require('dotenv').config({ quiet: true });
const { createClient } = require('@libsql/client');
const { HttpError } = require('./validation');
const { matchKeywords, sqlKeywordMatch } = require('./keywords');

const DB_URL = process.env.TURSO_DATABASE_URL || 'file:local.db';
// On Vercel the filesystem is temporary: a file database would silently lose every account and quote between requests.
// Fail loudly at startup instead of "working" and then forgetting everything.
if (process.env.VERCEL && !/^(libsql|https?|wss?):/i.test(DB_URL)) {
  throw new Error('TURSO_DATABASE_URL must be a libsql:// URL on Vercel (a local file would be lost). Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in Project → Settings → Environment Variables.');
}
const client = createClient({
  url: DB_URL,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined
});

// ---------------------------------------------------------------------------
// Versioned migrations. Each runs once, atomically (batch = transaction).
// Never edit a shipped migration; add a new one.
// ---------------------------------------------------------------------------
const MIGRATIONS = [
  {
    version: 1, // v2 schema: auth + founders + content
    statements: [
      `CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE sessions (
        id_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME,
        revoked_at DATETIME
      )`,
      `CREATE TABLE rate_limits (
        key TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key, window_start)
      )`,
      `CREATE TABLE founders (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        app_description TEXT NOT NULL,
        target_user TEXT NOT NULL,
        voice_tone TEXT NOT NULL,
        competitor_url TEXT NOT NULL,
        niche TEXT NOT NULL DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE content (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hooks TEXT NOT NULL,
        script TEXT NOT NULL,
        inspiration_quote_ids TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        founder_feedback TEXT,
        feedback_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        modified_at DATETIME
      )`,
      `CREATE INDEX idx_content_user ON content(user_id, created_at DESC)`
    ]
  },
  {
    version: 2, // live collection: sources, quotes, runs; content snapshot
    statements: [
      `CREATE TABLE sources (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        country TEXT NOT NULL DEFAULT '',
        label TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_collected_at INTEGER,
        next_collect_at INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER NOT NULL DEFAULT 0,
        last_status TEXT,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (type, external_id, country)
      )`,
      `CREATE INDEX idx_sources_due ON sources(enabled, next_collect_at)`,
      `CREATE TABLE founder_sources (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, source_id)
      )`,
      `CREATE TABLE pain_quotes (
        id INTEGER PRIMARY KEY,
        source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        quote TEXT NOT NULL,
        source TEXT NOT NULL,
        source_url TEXT NOT NULL,
        rating INTEGER,
        pain_score REAL NOT NULL,
        content_hash TEXT NOT NULL,
        published_at INTEGER,
        fetched_at INTEGER NOT NULL,
        UNIQUE (source_id, external_id),
        UNIQUE (source_id, content_hash)
      )`,
      `CREATE INDEX idx_quotes_rank ON pain_quotes(source_id, pain_score DESC, published_at DESC)`,
      `CREATE TABLE collection_runs (
        id INTEGER PRIMARY KEY,
        source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        fetched INTEGER NOT NULL DEFAULT 0,
        kept INTEGER NOT NULL DEFAULT 0,
        inserted INTEGER NOT NULL DEFAULT 0,
        error TEXT
      )`,
      `CREATE INDEX idx_runs_source ON collection_runs(source_id, started_at DESC)`,
      `ALTER TABLE content ADD COLUMN inspiration_snapshot TEXT NOT NULL DEFAULT '[]'`
    ]
  },
  {
    version: 3, // target locations (country + optional city/region), up to 3 per founder
    statements: [
      `CREATE TABLE founder_locations (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        country TEXT NOT NULL,
        region TEXT NOT NULL DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, country, region)
      )`,
      // NULL = source isn't tied to a location (global/topic community, or a pre-location link)
      `ALTER TABLE founder_sources ADD COLUMN location_id INTEGER REFERENCES founder_locations(id) ON DELETE CASCADE`,
      `ALTER TABLE founders ADD COLUMN location_mode TEXT NOT NULL DEFAULT 'strict'`
    ]
  },
  {
    version: 4, // which app a source is about (competitor name), for multi-competitor + Reddit mention sources
    statements: [
      `ALTER TABLE sources ADD COLUMN subject TEXT NOT NULL DEFAULT ''`,
      // backfill existing App Store sources from their label: "Name (App Store, US)" -> "Name"
      `UPDATE sources SET subject = substr(label, 1, instr(label, ' (App Store, ') - 1)
         WHERE type = 'app_store' AND instr(label, ' (App Store, ') > 0`
    ]
  },
  {
    version: 5, // problem keywords the founder wants to find in their users ("revenge trading")
    statements: [
      `CREATE TABLE founder_keywords (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, keyword)
      )`
    ]
  }
];

let initPromise;

async function migrate() {
  await client.execute(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)'
  );
  const applied = new Set((await client.execute('SELECT version FROM schema_migrations')).rows.map((r) => Number(r.version)));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    try {
      await client.batch(
        [...m.statements, { sql: 'INSERT INTO schema_migrations (version) VALUES (?)', args: [m.version] }],
        'write'
      );
    } catch (err) {
      // Another instance may have applied it concurrently (cold-start race): that's fine.
      const now = await client.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE version = ?', args: [m.version] });
      if (!now.rows.length) throw err;
    }
  }
}

// Memoized: runs pending migrations once per process. No seeding — data comes from live collection.
function init() {
  if (!initPromise) {
    initPromise = migrate().catch((err) => {
      initPromise = undefined; // allow retry on next request
      throw err;
    });
  }
  return initPromise;
}

// ---------------------------------------------------------------------------
// Query helpers. Convention: helpers for user-owned data (founders, content,
// api_keys, sessions, founder_sources) take userId and filter on it. Quotes are
// public but are only ever read through the founder_sources join.
// ---------------------------------------------------------------------------
const one = async (sql, args = []) => (await client.execute({ sql, args })).rows[0] || null;
const all = async (sql, args = []) => (await client.execute({ sql, args })).rows;
const run = (sql, args = []) => client.execute({ sql, args });
const num = (v) => (v === null || v === undefined ? null : Number(v));

// ---- users / sessions ----
async function createUser(email, passwordHash) {
  const r = await run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, passwordHash]);
  return Number(r.lastInsertRowid);
}
const getUserByEmail = (email) => one('SELECT id, email, password_hash FROM users WHERE email = ?', [email]);

const insertSession = (idHash, userId, expiresAt) =>
  run('INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)', [idHash, userId, expiresAt]);
const deleteSession = (idHash) => run('DELETE FROM sessions WHERE id_hash = ?', [idHash]);
const getSessionUser = (idHash) =>
  one(
    `SELECT u.id, u.email, s.expires_at,
            EXISTS (SELECT 1 FROM founders f WHERE f.user_id = u.id) AS has_profile
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    [idHash]
  );

// ---- rate limiting (fixed window, shared across serverless instances) ----
async function hitRateLimit(key, windowMs) {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const row = await one(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
    [key, windowStart]
  );
  if (Math.random() < 0.02) await run('DELETE FROM rate_limits WHERE window_start < ?', [Date.now() - 24 * 3600 * 1000]);
  return Number(row.count);
}

// ---- MCP api keys ----
async function rotateApiKey(userId, keyHash, keyPrefix) {
  await client.batch(
    [
      { sql: 'UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL', args: [userId] },
      { sql: 'INSERT INTO api_keys (user_id, key_hash, key_prefix) VALUES (?, ?, ?)', args: [userId, keyHash, keyPrefix] }
    ],
    'write'
  );
}
// MCP auth: resolve an active (non-revoked) key hash to its owner. Returns null for unknown/revoked keys.
async function findActiveApiKey(keyHash) {
  const r = await one('SELECT id, user_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', [keyHash]);
  return r ? { id: Number(r.id), userId: Number(r.user_id) } : null;
}
// At most one write per minute per key.
const touchApiKey = (id) =>
  run("UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 minute'))", [id]);
const getActiveApiKey = (userId) =>
  one('SELECT key_prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL', [userId]);

// ---- founders ----
// location_mode: 'strict' = with ≥1 location, only quotes from location-tied sources; 'all' = everything followed.
async function upsertFounder(userId, p) {
  const mode = p.location_mode ?? null;
  await run(
    `INSERT INTO founders (user_id, app_description, target_user, voice_tone, competitor_url, niche, location_mode)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 'strict'))
     ON CONFLICT(user_id) DO UPDATE SET app_description = excluded.app_description,
       target_user = excluded.target_user, voice_tone = excluded.voice_tone,
       competitor_url = excluded.competitor_url, niche = excluded.niche,
       location_mode = COALESCE(?, founders.location_mode)`,
    [userId, p.app_description, p.target_user, p.voice_tone, p.competitor_url, p.niche ?? '', mode, mode]
  );
  return getFounder(userId);
}
const getFounder = (userId) =>
  one(
    `SELECT app_description, target_user, voice_tone, competitor_url, niche, location_mode, created_at
       FROM founders WHERE user_id = ?`,
    [userId]
  );
async function setLocationMode(userId, mode) {
  const r = await run('UPDATE founders SET location_mode = ? WHERE user_id = ?', [mode, userId]);
  return r.rowsAffected > 0;
}

// ---- founder locations (user-scoped) ----
const locKey = (l) => `${l.country}|${String(l.region).toLowerCase()}`;
async function listLocations(userId) {
  const rows = await all('SELECT id, country, region FROM founder_locations WHERE user_id = ? ORDER BY id', [userId]);
  return rows.map((r) => ({ id: Number(r.id), country: r.country, region: r.region }));
}
// Reconcile to exactly `wanted` ([{country, region}]). Removed locations cascade away their source links.
async function replaceLocations(userId, wanted) {
  const existing = await listLocations(userId);
  const wantedKeys = new Set(wanted.map(locKey));
  const haveKeys = new Set(existing.map(locKey));
  const stmts = [];
  for (const e of existing) {
    if (!wantedKeys.has(locKey(e))) stmts.push({ sql: 'DELETE FROM founder_locations WHERE id = ? AND user_id = ?', args: [e.id, userId] });
  }
  for (const w of wanted) {
    if (!haveKeys.has(locKey(w))) stmts.push({ sql: 'INSERT INTO founder_locations (user_id, country, region) VALUES (?, ?, ?)', args: [userId, w.country, w.region] });
  }
  if (stmts.length) await client.batch(stmts, 'write');
  return listLocations(userId);
}

// ---- problem keywords (user-scoped) ----
async function listKeywords(userId) {
  return (await all('SELECT keyword FROM founder_keywords WHERE user_id = ? ORDER BY id', [userId])).map((r) => r.keyword);
}
// Reconcile to exactly `wanted` (case-insensitive de-duplication is done by the caller).
async function replaceKeywords(userId, wanted) {
  const have = await listKeywords(userId);
  const wantedKeys = new Set(wanted.map((k) => k.toLowerCase()));
  const haveKeys = new Set(have.map((k) => k.toLowerCase()));
  const stmts = [];
  for (const k of have) if (!wantedKeys.has(k.toLowerCase())) stmts.push({ sql: 'DELETE FROM founder_keywords WHERE user_id = ? AND keyword = ?', args: [userId, k] });
  for (const k of wanted) if (!haveKeys.has(k.toLowerCase())) stmts.push({ sql: 'INSERT INTO founder_keywords (user_id, keyword) VALUES (?, ?)', args: [userId, k] });
  if (stmts.length) await client.batch(stmts, 'write');
  return listKeywords(userId);
}
// How many of the founder's visible quotes match one keyword (across ALL their sources)?
async function countKeywordMatches(userId, keyword) {
  const kw = sqlKeywordMatch([keyword]);
  const f = quoteFilter(userId, {});
  const r = await one(`SELECT COUNT(*) AS n ${QUOTE_FROM} WHERE ${f.where} AND ${kw.sql}`, [...f.args, ...kw.args]);
  return Number(r.n);
}

// ---- sources (public) + founder_sources (user-scoped) ----
async function upsertSource({ type, external_id, country = '', label, url, subject = '' }) {
  const row = await one(
    `INSERT INTO sources (type, external_id, country, label, url, subject) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(type, external_id, country) DO UPDATE SET label = excluded.label, url = excluded.url,
       subject = CASE WHEN excluded.subject != '' THEN excluded.subject ELSE sources.subject END
     RETURNING id`,
    [type, external_id, country, label, url, subject]
  );
  return Number(row.id);
}

// Replace this user's links of a role with exactly `entries`: source ids, or { sourceId, locationId }.
async function replaceFounderSources(userId, role, entries) {
  const seen = new Set();
  const stmts = [{ sql: 'DELETE FROM founder_sources WHERE user_id = ? AND role = ?', args: [userId, role] }];
  for (const e of entries) {
    const { sourceId, locationId = null } = typeof e === 'number' ? { sourceId: e } : e;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    stmts.push({
      sql: `INSERT INTO founder_sources (user_id, source_id, role, location_id) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, source_id) DO UPDATE SET role = excluded.role, location_id = excluded.location_id`,
      args: [userId, sourceId, role, locationId]
    });
  }
  await client.batch(stmts, 'write');
}
const followSource = (userId, sourceId, role, locationId = null) =>
  run(
    `INSERT INTO founder_sources (user_id, source_id, role, location_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, source_id) DO NOTHING`,
    [userId, sourceId, role, locationId]
  );
async function unfollowSource(userId, sourceId) {
  const r = await run('DELETE FROM founder_sources WHERE user_id = ? AND source_id = ?', [userId, sourceId]);
  return r.rowsAffected > 0;
}
async function countCommunities(userId) {
  const r = await one("SELECT COUNT(*) AS n FROM founder_sources WHERE user_id = ? AND role = 'community'", [userId]);
  return Number(r.n);
}
async function isFollowing(userId, sourceId) {
  return Boolean(await one('SELECT 1 FROM founder_sources WHERE user_id = ? AND source_id = ?', [userId, sourceId]));
}
// App Store reviews are country-level, so their location never carries a region.
const shapeLocation = (id, country, region, type) =>
  id == null ? null : { id: Number(id), country, region: type === 'app_store' ? '' : region };

async function listUserSources(userId) {
  const rows = await all(
    `SELECT s.id, s.type, s.external_id, s.country AS source_country, s.subject, s.label, s.url, s.enabled, s.last_collected_at, s.next_collect_at,
            s.last_status, s.last_error, fs.role, fs.location_id, fl.country AS loc_country, fl.region AS loc_region,
            (SELECT COUNT(*) FROM pain_quotes q WHERE q.source_id = s.id) AS quote_count
       FROM founder_sources fs
       JOIN sources s ON s.id = fs.source_id
       LEFT JOIN founder_locations fl ON fl.id = fs.location_id
      WHERE fs.user_id = ? ORDER BY fs.role, s.label`,
    [userId]
  );
  return rows.map((r) => ({
    id: Number(r.id), type: r.type, external_id: r.external_id, country: r.source_country, subject: r.subject, role: r.role, label: r.label, url: r.url,
    enabled: Boolean(r.enabled), last_collected_at: num(r.last_collected_at), next_collect_at: num(r.next_collect_at),
    last_status: r.last_status, last_error: r.last_error, quote_count: Number(r.quote_count),
    location: shapeLocation(r.location_id, r.loc_country, r.loc_region, r.type)
  }));
}

// ---- pain quotes (read only through founder_sources) ----
// mentions_location: the quote text names one of the founder's regions (soft signal, used for ranking).
const QUOTE_COLS = `q.id, q.source_id, q.quote, q.source, q.source_url, q.rating, q.pain_score, q.published_at,
  s.type AS source_type, s.subject AS subject, s.label AS source_label, fs.location_id AS loc_id, fl.country AS loc_country, fl.region AS loc_region,
  EXISTS (SELECT 1 FROM founder_locations x
           WHERE x.user_id = fs.user_id AND x.region != '' AND instr(lower(q.quote), lower(x.region)) > 0) AS mentions_location`;
const QUOTE_FROM = `FROM pain_quotes q
  JOIN founder_sources fs ON fs.source_id = q.source_id
  JOIN sources s ON s.id = q.source_id
  LEFT JOIN founders f ON f.user_id = fs.user_id
  LEFT JOIN founder_locations fl ON fl.id = fs.location_id`;
// Strict mode: a founder WITH locations only sees quotes from location-tied sources. No locations => unchanged.
// Competitor and problem-keyword sources are always visible: a Reddit-wide search can't be tied to a place (labelled "all regions" in the UI).
const LOCATION_VISIBLE = `(COALESCE(f.location_mode, 'strict') = 'all'
  OR fs.location_id IS NOT NULL
  OR fs.role IN ('competitor', 'keyword')
  OR NOT EXISTS (SELECT 1 FROM founder_locations y WHERE y.user_id = fs.user_id))`;

// Which app is this quote about? (competitor name for reviews and Reddit mentions; null for plain communities)
// A keyword source's subject is a PROBLEM ("revenge trading"), not an app, so it never counts as "which app".
const appOf = (subject, type, label) =>
  ((type === 'app_store' || type === 'reddit_search') && subject) ||
  (type === 'app_store' ? String(label).replace(/ \(App Store, [A-Z]{2}\)$/, '') : null) || null;
const subredditOf = (type, url) =>
  type === 'reddit' || type === 'reddit_search' || type === 'reddit_keyword' ? ((/\/r\/([A-Za-z0-9_]+)\//.exec(String(url)) || [])[1] || null) : null;

function shapeQuote(r, keywords = []) {
  return {
    matched_keywords: keywords.length ? matchKeywords(r.quote, keywords) : [],
    id: Number(r.id), source_id: Number(r.source_id), quote: r.quote, source: r.source, source_url: r.source_url,
    rating: num(r.rating), pain_score: Number(r.pain_score), published_at: num(r.published_at),
    source_type: r.source_type, source_label: r.source_label,
    app: appOf(r.subject, r.source_type, r.source_label), subreddit: subredditOf(r.source_type, r.source_url),
    location: shapeLocation(r.loc_id, r.loc_country, r.loc_region, r.source_type),
    mentions_location: Boolean(Number(r.mentions_location))
  };
}
function quoteFilter(userId, { sourceId, sourceType, locationId, days } = {}) {
  const where = ['fs.user_id = ?', LOCATION_VISIBLE];
  const args = [userId];
  if (sourceId) { where.push('q.source_id = ?'); args.push(sourceId); }
  // 'reddit' means every Reddit-derived source (community posts AND competitor-complaint search)
  if (sourceType === 'reddit') where.push("s.type IN ('reddit', 'reddit_search', 'reddit_keyword')");
  else if (sourceType) { where.push('s.type = ?'); args.push(sourceType); }
  if (locationId) { where.push('fs.location_id = ?'); args.push(locationId); }
  if (days) { where.push('COALESCE(q.published_at, q.fetched_at) >= ?'); args.push(Date.now() - days * 86400000); }
  return { where: where.join(' AND '), args };
}

async function getUserQuotes(userId, { sourceId, sourceType, locationId, days, keywordsOnly = false, limit = 50, offset = 0 } = {}) {
  const keywords = await listKeywords(userId);
  const kw = sqlKeywordMatch(keywords);
  const f = quoteFilter(userId, { sourceId, sourceType, locationId, days });
  const rows = await all(
    `SELECT ${QUOTE_COLS}, (${kw.sql}) AS keyword_match ${QUOTE_FROM} WHERE ${f.where}${keywordsOnly ? ` AND ${kw.sql}` : ''}
     ORDER BY keyword_match DESC, q.pain_score DESC, q.published_at DESC, q.id DESC LIMIT ? OFFSET ?`,
    [...kw.args, ...f.args, ...(keywordsOnly ? kw.args : []), limit, offset]
  );
  return rows.map((r) => shapeQuote(r, keywords));
}
// Sample `limit` quotes for Claude. App Store reviews score higher than Reddit posts by design (a 1★ rating is a strong
// signal), so ranking by raw score alone — or just sampling a mixed top-N — would fill every draw with reviews and Claude
// would never see Reddit. So: rank each source family (App Store / Reddit) WITHIN itself and keep the top `top` of each;
// quotes that name the founder's place are taken first; the rest alternate between families, drawn at random.
// If one family is short (or empty) the other fills the remaining slots.
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
async function sampleUserQuotes(userId, { limit = 10, top = 100, sourceType, days = 180, keyword } = {}) {
  const keywords = await listKeywords(userId);
  const wanted = keyword ? keywords.filter((k) => k.toLowerCase() === String(keyword).toLowerCase()) : keywords;
  if (keyword && !wanted.length) return []; // asked for a problem the founder isn't tracking
  const kw = sqlKeywordMatch(wanted);
  const f = quoteFilter(userId, { sourceType, days });
  const rows = await all(
    `SELECT * FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY keyword_match DESC, mentions_location DESC, pain_score DESC, published_at DESC) AS rk
         FROM (SELECT ${QUOTE_COLS}, (${kw.sql}) AS keyword_match, CASE WHEN s.type = 'app_store' THEN 'a' ELSE 'r' END AS grp
                 ${QUOTE_FROM} WHERE ${f.where}${keyword ? ` AND ${kw.sql}` : ''})
     ) WHERE rk <= ?`,
    [...kw.args, ...f.args, ...(keyword ? kw.args : []), top]
  );
  const pool = rows.map((r) => ({ q: shapeQuote(r, keywords), grp: r.grp, hit: Boolean(Number(r.keyword_match)) }));
  // 1) quotes that match a problem the founder is tracking, 2) quotes naming their place, 3) the rest, alternating families
  const picked = shuffle(pool.filter((x) => x.hit)).slice(0, limit);
  if (picked.length < limit) picked.push(...shuffle(pool.filter((x) => !picked.includes(x) && x.q.mentions_location)).slice(0, limit - picked.length));
  const rest = pool.filter((x) => !picked.includes(x));
  const families = { a: shuffle(rest.filter((x) => x.grp === 'a')), r: shuffle(rest.filter((x) => x.grp === 'r')) };
  const order = Math.random() < 0.5 ? ['a', 'r'] : ['r', 'a'];
  while (picked.length < limit && (families.a.length || families.r.length)) {
    for (const g of order) if (picked.length < limit && families[g].length) picked.push(families[g].pop());
  }
  return shuffle(picked).map((x) => x.q);
}
async function countUserQuotes(userId, opts = {}) {
  const f = quoteFilter(userId, opts);
  const r = await one(`SELECT COUNT(*) AS n ${QUOTE_FROM} WHERE ${f.where}`, f.args);
  return Number(r.n);
}
async function getQuotesByIdsForUser(userId, ids) {
  if (!ids.length) return [];
  const f = quoteFilter(userId);
  const rows = await all(
    `SELECT ${QUOTE_COLS} ${QUOTE_FROM} WHERE ${f.where} AND q.id IN (${ids.map(() => '?').join(',')})`,
    [...f.args, ...ids]
  );
  return rows.map(shapeQuote);
}

// Which subreddits did a Reddit source's quotes come from? [{name, count}] — callers pass only sources the user follows.
async function subredditCounts(sourceId, limit = 8) {
  const rows = await all('SELECT source_url FROM pain_quotes WHERE source_id = ? LIMIT 2000', [sourceId]);
  const counts = new Map();
  for (const r of rows) {
    const m = /\/r\/([A-Za-z0-9_]+)\//.exec(String(r.source_url));
    if (!m) continue;
    const key = m[1].toLowerCase();
    const cur = counts.get(key) || { name: m[1], count: 0 };
    cur.count += 1;
    counts.set(key, cur);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit);
}

// ---- collection runner support ----
const parseSource = (r) => ({
  id: Number(r.id), type: r.type, external_id: r.external_id, country: r.country, subject: r.subject || '', label: r.label, url: r.url,
  enabled: Boolean(r.enabled), last_collected_at: num(r.last_collected_at), next_collect_at: Number(r.next_collect_at),
  locked_until: Number(r.locked_until), last_status: r.last_status, last_error: r.last_error,
  consecutive_failures: Number(r.consecutive_failures)
});

// Sources due for collection. `minIntervalMs` lets manual runs refresh sources whose last
// success is older than that interval even if their scheduled time is later.
async function listDueSources({ now = Date.now(), userId, minIntervalMs, ids, limit = 200 } = {}) {
  const args = [];
  let sql = 'SELECT s.* FROM sources s WHERE s.enabled = 1 AND s.locked_until < ?';
  args.push(now);
  if (ids) {
    sql += ` AND s.id IN (${ids.map(() => '?').join(',') || 'NULL'})`;
    args.push(...ids);
  } else if (minIntervalMs) {
    sql += ' AND (s.next_collect_at <= ? OR s.last_collected_at IS NULL OR s.last_collected_at <= ?)';
    args.push(now, now - minIntervalMs);
  } else {
    sql += ' AND s.next_collect_at <= ?';
    args.push(now);
  }
  if (userId) {
    sql += ' AND s.id IN (SELECT source_id FROM founder_sources WHERE user_id = ?)';
    args.push(userId);
  }
  sql += ' ORDER BY s.next_collect_at ASC, s.id ASC LIMIT ?';
  args.push(limit);
  return (await all(sql, args)).map(parseSource);
}
async function listAllSourceIds() {
  return (await all('SELECT id FROM sources WHERE enabled = 1 ORDER BY id')).map((r) => Number(r.id));
}
async function getSource(id) {
  const r = await one('SELECT * FROM sources WHERE id = ?', [id]);
  return r ? parseSource(r) : null;
}
// Lease: only one concurrent runner can hold a source.
async function claimSource(id, now, leaseMs) {
  const r = await run('UPDATE sources SET locked_until = ? WHERE id = ? AND locked_until < ?', [now + leaseMs, id, now]);
  return r.rowsAffected === 1;
}
// `note` = a non-error remark shown with an OK status (e.g. "only app-named communities were read")
async function finishSourceOk(id, now, nextCollectAt, note = null) {
  await run(
    `UPDATE sources SET last_collected_at = ?, next_collect_at = ?, last_status = 'ok', last_error = ?,
            consecutive_failures = 0, locked_until = 0 WHERE id = ?`,
    [now, nextCollectAt, note ? String(note).slice(0, 200) : null, id]
  );
}
// countFailure=false for rate limits: it's the upstream being busy, not a broken source, so don't escalate the backoff.
async function finishSourceError(id, nextCollectAt, error, { countFailure = true } = {}) {
  await run(
    `UPDATE sources SET next_collect_at = ?, last_status = 'error', last_error = ?,
            consecutive_failures = consecutive_failures + ?, locked_until = 0 WHERE id = ?`,
    [nextCollectAt, String(error).slice(0, 200), countFailure ? 1 : 0, id]
  );
}
async function markSourceDisabled(id, nextCollectAt, message) {
  await run(
    `UPDATE sources SET next_collect_at = ?, last_status = 'disabled', last_error = ?, locked_until = 0 WHERE id = ?`,
    [nextCollectAt, message, id]
  );
}
async function startRun(sourceId, trigger, now) {
  const r = await run(
    "INSERT INTO collection_runs (source_id, trigger, started_at, status) VALUES (?, ?, ?, 'running')",
    [sourceId, trigger, now]
  );
  return Number(r.lastInsertRowid);
}
const finishRun = (id, { status, fetched = 0, kept = 0, inserted = 0, error = null }) =>
  run(
    'UPDATE collection_runs SET finished_at = ?, status = ?, fetched = ?, kept = ?, inserted = ?, error = ? WHERE id = ?',
    [Date.now(), status, fetched, kept, inserted, error ? String(error).slice(0, 200) : null, id]
  );

// Idempotent insert; returns the number of NEW rows.
async function insertQuotes(sourceId, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const results = await client.batch(
      chunk.map((q) => ({
        sql: `INSERT INTO pain_quotes (source_id, external_id, quote, source, source_url, rating, pain_score, content_hash, published_at, fetched_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        args: [sourceId, q.external_id, q.quote, q.source, q.source_url, q.rating ?? null, q.pain_score, q.content_hash, q.published_at ?? null, q.fetched_at]
      })),
      'write'
    );
    inserted += results.reduce((n, r) => n + r.rowsAffected, 0);
  }
  return inserted;
}

const RETENTION = { quoteDays: 180, maxPerSource: 2000, runsPerSource: 50, orphanDays: 7 };
async function runRetention(now = Date.now()) {
  const cutoff = now - RETENTION.quoteDays * 86400000;
  await run('DELETE FROM pain_quotes WHERE COALESCE(published_at, fetched_at) < ?', [cutoff]);
  // cap per source: keep the highest-scoring rows
  await run(
    `DELETE FROM pain_quotes WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY pain_score DESC, published_at DESC, id DESC) AS rn
           FROM pain_quotes)
       WHERE rn > ?)`,
    [RETENTION.maxPerSource]
  );
  await run(
    `DELETE FROM collection_runs WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY started_at DESC, id DESC) AS rn FROM collection_runs)
       WHERE rn > ?)`,
    [RETENTION.runsPerSource]
  );
  // sources nobody follows anymore (cascade removes their quotes + runs)
  await run(
    `DELETE FROM sources WHERE created_at < datetime(?, 'unixepoch')
       AND id NOT IN (SELECT source_id FROM founder_sources)`,
    [Math.floor((now - RETENTION.orphanDays * 86400000) / 1000)]
  );
}

// ---- content ----
function shapeContent(row) {
  return {
    id: Number(row.id),
    hooks: JSON.parse(row.hooks),
    script: row.script,
    inspiration_quote_ids: JSON.parse(row.inspiration_quote_ids),
    inspiration_quotes: JSON.parse(row.inspiration_snapshot),
    status: row.status,
    founder_feedback: row.founder_feedback,
    feedback_reason: row.feedback_reason,
    created_at: row.created_at,
    modified_at: row.modified_at
  };
}
async function listContent(userId, { includeDeleted = false, limit = 200 } = {}) {
  const rows = await all(
    `SELECT * FROM content WHERE user_id = ? ${includeDeleted ? '' : "AND status != 'deleted'"}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    [userId, limit]
  );
  return rows.map(shapeContent);
}
async function getContent(userId, id, { includeDeleted = false } = {}) {
  const row = await one(
    `SELECT * FROM content WHERE id = ? AND user_id = ? ${includeDeleted ? '' : "AND status != 'deleted'"}`,
    [id, userId]
  );
  return row ? shapeContent(row) : null;
}
// Cited quotes must belong to a source the user follows. The snapshot is copied from the DB, never from client input.
async function resolveInspiration(userId, ids) {
  const unique = [...new Set(ids)];
  const found = await getQuotesByIdsForUser(userId, unique);
  if (found.length !== unique.length) {
    throw new HttpError(400, 'Invalid input', [{ field: 'inspiration_quote_ids', message: 'Unknown quote id' }]);
  }
  const byId = new Map(found.map((q) => [q.id, q]));
  return ids.map((id) => byId.get(id)).filter((q, i, a) => a.indexOf(q) === i)
    .map((q) => ({ id: q.id, quote: q.quote, source: q.source, source_url: q.source_url, published_at: q.published_at, app: q.app, subreddit: q.subreddit, source_type: q.source_type }));
}
async function createContent(userId, { hooks, script, inspiration_quote_ids }) {
  const snapshot = await resolveInspiration(userId, inspiration_quote_ids);
  const r = await run(
    'INSERT INTO content (user_id, hooks, script, inspiration_quote_ids, inspiration_snapshot) VALUES (?, ?, ?, ?, ?)',
    [userId, JSON.stringify(hooks), script, JSON.stringify(inspiration_quote_ids), JSON.stringify(snapshot)]
  );
  return Number(r.lastInsertRowid);
}
async function updateContent(userId, id, { hooks, script }) {
  const r = await run(
    `UPDATE content SET hooks = COALESCE(?, hooks), script = COALESCE(?, script),
            status = 'edited', modified_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND status != 'deleted'`,
    [hooks ? JSON.stringify(hooks) : null, script ?? null, id, userId]
  );
  return r.rowsAffected > 0;
}
async function softDeleteContent(userId, id) {
  const r = await run(
    "UPDATE content SET status = 'deleted', modified_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status != 'deleted'",
    [id, userId]
  );
  return r.rowsAffected > 0;
}
async function setFeedback(userId, id, feedback, reason) {
  const r = await run(
    `UPDATE content SET founder_feedback = ?, feedback_reason = ?,
            status = CASE WHEN ? = 'approved' THEN 'approved' ELSE status END,
            modified_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?`,
    [feedback, reason, feedback, id, userId]
  );
  return r.rowsAffected > 0;
}

module.exports = {
  client, init,
  createUser, getUserByEmail, insertSession, deleteSession, getSessionUser,
  hitRateLimit, rotateApiKey, getActiveApiKey, findActiveApiKey, touchApiKey,
  upsertFounder, getFounder, setLocationMode, listLocations, replaceLocations, listKeywords, replaceKeywords, countKeywordMatches,
  upsertSource, replaceFounderSources, followSource, unfollowSource, countCommunities, isFollowing, listUserSources,
  subredditCounts, getUserQuotes, sampleUserQuotes, countUserQuotes, getQuotesByIdsForUser,
  listDueSources, listAllSourceIds, getSource, claimSource, finishSourceOk, finishSourceError, markSourceDisabled,
  startRun, finishRun, insertQuotes, runRetention, RETENTION,
  listContent, getContent, createContent, updateContent, softDeleteContent, setFeedback
};
