// Reddit adapter with swappable providers. TODAY: Arctic Shift (primary) → Reddit RSS (fallback).
// The official API provider is a dormant PLACEHOLDER (Reddit approval pending): it only activates when all three
// REDDIT_* credentials are set, and then goes first — no code change needed.
//
//   official  Reddit Data API (OAuth app-only). Needs REDDIT_CLIENT_ID/SECRET/USER_AGENT.
//   arctic    Arctic Shift public archive API (no key; JSON; supports `after`; has NSFW/sticky flags).
//   rss       Reddit's own public Atom feeds (no key; ONE request ≈ 100 newest posts; throttles hard
//             with 429 after a few quick requests, so it is the last resort).
//
// REDDIT_PROVIDER = auto (default: official if configured → arctic → rss) | official | arctic | rss | off
// Providers fall through on error. Authors/usernames are never read or stored.
const { z } = require('zod');
const { fetchJson, fetchText, request, UpstreamError } = require('./http');
const { htmlToText, decodeEntities } = require('./text');
const { keywordStems, STOP_WORDS } = require('../keywords');

const VALID = new Set(['auto', 'official', 'arctic', 'rss', 'off']);
const SUB = /^[A-Za-z0-9_]{2,21}$/;
const DAY_MS = 86400000;
const DEFAULT_LOOKBACK_DAYS = 30;

function mode() {
  const m = (process.env.REDDIT_PROVIDER || 'auto').toLowerCase();
  return VALID.has(m) ? m : 'auto';
}
const isEnabled = () => mode() !== 'off';
const officialConfigured = () =>
  Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET && process.env.REDDIT_USER_AGENT);

function providerChain() {
  const m = mode();
  if (m === 'off') return [];
  if (m === 'auto') return [...(officialConfigured() ? ['official'] : []), 'arctic', 'rss'];
  if (m === 'official' && !officialConfigured()) return [];
  return [m];
}

const permalinkUrl = (p) => `https://www.reddit.com${p.startsWith('/') ? p : `/${p}`}`;

// Shared by official + arctic (both return Reddit "link" objects).
function mapPost(p) {
  const selftext = typeof p.selftext === 'string' ? p.selftext : '';
  const removed = Boolean(p.removed_by_category) || /^\[(removed|deleted)\]$/i.test(selftext.trim());
  return {
    external_id: p.name || `t3_${p.id}`,
    kind: 'post',
    title: p.title || '',
    body: removed ? '' : selftext,
    published_at: p.created_utc ? Number(p.created_utc) * 1000 : null,
    url: permalinkUrl(p.permalink || `/comments/${p.id}/`),
    flags: { over_18: Boolean(p.over_18), stickied: Boolean(p.stickied), removed }
  };
}

// ---- provider: arctic shift ----
const arcticSchema = z.object({ data: z.array(z.object({}).passthrough()) }).passthrough();
async function collectArctic(sub, since) {
  const after = new Date(since ? since - DAY_MS : Date.now() - DEFAULT_LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
  const { json } = await fetchJson(
    `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${encodeURIComponent(sub)}&limit=100&sort=desc&after=${after}`,
    { timeoutMs: 15000, maxBytes: 4 * 1024 * 1024 }
  );
  const parsed = arcticSchema.safeParse(json);
  if (!parsed.success) throw new UpstreamError('Arctic Shift returned an unexpected format');
  return parsed.data.data.map(mapPost);
}

// ---- provider: reddit public RSS (Atom) ----
function parseAtom(xml) {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  const pick = (block, tag) => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1];
  return entries.map((e) => {
    const id = pick(e, 'id');
    const link = (e.match(/<link\s+href="([^"]+)"/) || [])[1];
    const when = Date.parse(pick(e, 'published') || pick(e, 'updated') || '');
    const content = htmlToText(decodeEntities(pick(e, 'content') || '')).replace(/\bsubmitted by\b[\s\S]*$/i, '').trim();
    return {
      external_id: id,
      kind: 'post',
      title: htmlToText(pick(e, 'title') || ''),
      body: content,
      published_at: Number.isFinite(when) ? when : null,
      url: link,
      flags: {} // RSS exposes no NSFW/sticky info; thread-title heuristics in the pipeline cover mod posts
    };
  }).filter((i) => i.external_id && i.url);
}
async function collectRss(sub) {
  const xml = await fetchText(`https://www.reddit.com/r/${encodeURIComponent(sub)}/new/.rss?limit=100`, { retries: 1 });
  if (!xml.includes('<feed')) throw new UpstreamError('Reddit RSS returned an unexpected format');
  return parseAtom(xml);
}

// ---- provider: official OAuth API ----
let token = { value: null, expiresAt: 0 };
async function officialToken() {
  if (token.value && Date.now() < token.expiresAt - 60000) return token.value;
  const basic = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString('base64');
  const r = await request('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': process.env.REDDIT_USER_AGENT },
    body: 'grant_type=client_credentials'
  });
  const j = JSON.parse(r.text);
  if (!j.access_token) throw new UpstreamError('Reddit token response missing access_token');
  token = { value: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return token.value;
}
async function collectOfficial(sub) {
  const auth = { authorization: `bearer ${await officialToken()}`, 'user-agent': process.env.REDDIT_USER_AGENT };
  const items = [];
  for (const path of [`new?limit=100`, `top?t=month&limit=100`]) {
    const { json, headers } = await fetchJson(`https://oauth.reddit.com/r/${encodeURIComponent(sub)}/${path}&raw_json=1`, { headers: auth });
    for (const c of json?.data?.children || []) if (c.kind === 't3') items.push(mapPost(c.data));
    if (Number(headers.get('x-ratelimit-remaining')) < 2) break; // respect Reddit's budget
  }
  return items;
}

const PROVIDERS = {
  official: (sub) => collectOfficial(sub),
  arctic: (sub, since) => collectArctic(sub, since),
  rss: (sub) => collectRss(sub)
};

// Try providers in order; the first one that responds wins. Throws only if all fail.
async function collect(source, { since } = {}) {
  const sub = source.external_id;
  if (!SUB.test(sub)) throw new UpstreamError('Invalid subreddit name');
  const chain = providerChain();
  if (!chain.length) throw new UpstreamError('Reddit collection is disabled');
  const failures = [];
  const statuses = [];
  for (const name of chain) {
    try {
      const items = await PROVIDERS[name](sub, since);
      return { items, provider: name };
    } catch (err) {
      failures.push(`${name}: ${String(err.message).slice(0, 60)}`);
      statuses.push(err.status);
    }
  }
  const only = (set) => statuses.length > 0 && statuses.every((x) => set.includes(x));
  throw new UpstreamError(`Reddit unavailable (${failures.join('; ')})`, { retryable: true, status: only([403, 429]) ? (statuses.includes(403) ? 403 : 429) : 0 });
}

// true = exists, false = doesn't exist, null = couldn't verify (blocked/rate-limited → allow).
async function resolve(name) {
  if (!SUB.test(name)) return false;
  try {
    await fetchText(`https://www.reddit.com/r/${encodeURIComponent(name)}/new/.rss?limit=1`, { retries: 0, timeoutMs: 6000 });
    return true;
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) return false;
    return null;
  }
}

// ---- subreddit search (used to suggest LOCAL communities for a founder's location) ----
// Official and Arctic Shift both return Reddit "subreddit" objects.
const subredditSchema = z.object({
  display_name: z.string(),
  subscribers: z.number().nullable().optional(),
  over18: z.boolean().nullable().optional(),
  subreddit_type: z.string().nullable().optional()
}).passthrough();

function mapSubreddit(d) {
  const p = subredditSchema.safeParse(d);
  if (!p.success) return null;
  const x = p.data;
  return {
    name: x.display_name,
    subscribers: Number(x.subscribers) || 0,
    over18: Boolean(x.over18),
    isPublic: !x.subreddit_type || x.subreddit_type === 'public'
  };
}

async function searchOfficial(query) {
  const auth = { authorization: `bearer ${await officialToken()}`, 'user-agent': process.env.REDDIT_USER_AGENT };
  const { json } = await fetchJson(
    `https://oauth.reddit.com/subreddits/search?q=${encodeURIComponent(query)}&limit=10&raw_json=1&include_over_18=off`,
    { headers: auth }
  );
  return (json?.data?.children || []).map((c) => mapSubreddit(c.data));
}
async function searchArctic(query) {
  const prefix = String(query).toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (prefix.length < 2) return [];
  const { json } = await fetchJson(
    `https://arctic-shift.photon-reddit.com/api/subreddits/search?subreddit_prefix=${encodeURIComponent(prefix)}&limit=10`,
    { timeoutMs: 12000, retries: 1 }
  );
  if (!json || !Array.isArray(json.data)) throw new UpstreamError('Arctic Shift returned an unexpected format');
  return json.data.map(mapSubreddit);
}

// Returns [{name, subscribers}] — public, non-NSFW, valid names only. Official first when configured.
// Throws UpstreamError only if every provider failed; returns [] when Reddit is switched off.
async function searchSubreddits(query) {
  if (!isEnabled()) return [];
  const m = mode();
  const chain = (m === 'auto' || m === 'official') && officialConfigured() ? ['official', 'arctic'] : ['arctic'];
  const failures = [];
  for (const name of chain) {
    try {
      const found = await (name === 'official' ? searchOfficial(query) : searchArctic(query));
      return found.filter((s) => s && !s.over18 && s.isPublic && SUB.test(s.name)).map(({ name: n, subscribers }) => ({ name: n, subscribers }));
    } catch (err) {
      failures.push(`${name}: ${String(err.message).slice(0, 60)}`);
    }
  }
  throw new UpstreamError(`Subreddit search unavailable (${failures.join('; ')})`, { retryable: true });
}

// ---- competitor mentions: "complaints about <app>" via Reddit-wide search ----
// Only providers that can search ALL of Reddit qualify (Arctic Shift requires a subreddit or author, so it can't).
//   official  Reddit-wide search (needs approval)      rss  Reddit-wide search (blocked on some networks: 403/429)
//   arctic    FALLBACK that never touches reddit.com: reads communities named after the app (r/swiggy), because Arctic
//             Shift can't text-search across Reddit and times out searching inside big subreddits.
function mentionChain() {
  const m = mode();
  if (m === 'off') return [];
  if (m === 'official') return officialConfigured() ? ['official'] : [];
  if (m === 'rss') return ['rss'];
  if (m === 'arctic') return ['arctic'];
  return [...(officialConfigured() ? ['official'] : []), 'rss', 'arctic'];
}
const cleanTerm = (t) => String(t || '').replace(/["\\\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

async function searchOfficialQuery(q) {
  const auth = { authorization: `bearer ${await officialToken()}`, 'user-agent': process.env.REDDIT_USER_AGENT };
  const { json } = await fetchJson(
    `https://oauth.reddit.com/search?q=${encodeURIComponent(q)}&sort=new&t=month&type=link&limit=100&raw_json=1&include_over_18=off`,
    { headers: auth }
  );
  return (json?.data?.children || []).filter((c) => c.kind === 't3').map((c) => mapPost(c.data));
}
const mentionsOfficial = (term) => searchOfficialQuery(`"${term}"`);
// Reddit's search feed allows roughly one request every ~25 s per IP. Never retry in-request (that only burns the
// budget): space searches out, and let the runner reschedule a rate-limited source for a few minutes later.
const SEARCH_GAP_MS = 20000;
async function searchRssQuery(q) {
  const xml = await fetchText(`https://www.reddit.com/search.rss?q=${encodeURIComponent(q)}&sort=new&t=month&limit=100`, { retries: 0, gapMs: SEARCH_GAP_MS });
  if (!xml.includes('<feed')) throw new UpstreamError('Reddit RSS returned an unexpected format');
  return parseAtom(xml);
}
const mentionsRss = (term) => searchRssQuery(`"${term}"`);
const slugOf = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Fallback: the app's own community. "Swiggy" -> r/swiggy (+ r/SwiggyGold). Every post there is about the app, so the
// pipeline doesn't require the name in the text for these. Uses Arctic Shift only (never reddit.com).
async function mentionsArctic(term) {
  const key = slugOf(term);
  if (key.length < 3) throw new UpstreamError('App name is too short to find its community');
  const { json } = await fetchJson(
    `https://arctic-shift.photon-reddit.com/api/subreddits/search?subreddit_prefix=${encodeURIComponent(key)}&limit=10`,
    { timeoutMs: 12000, retries: 1 }
  );
  if (!json || !Array.isArray(json.data)) throw new UpstreamError('Arctic Shift returned an unexpected format');
  const communities = json.data.map(mapSubreddit)
    .filter((x) => x && !x.over18 && x.isPublic && SUB.test(x.name) && slugOf(x.name).startsWith(key) && x.subscribers >= 200)
    .sort((a, b) => b.subscribers - a.subscribers).slice(0, 2);
  if (!communities.length) throw new UpstreamError('No community named after this app was found');
  const after = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
  const items = [];
  for (const c of communities) {
    const { json: posts } = await fetchJson(
      `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${encodeURIComponent(c.name)}&limit=100&sort=desc&after=${after}`,
      { timeoutMs: 15000, maxBytes: 4 * 1024 * 1024 }
    );
    const parsed = arcticSchema.safeParse(posts);
    if (!parsed.success) throw new UpstreamError('Arctic Shift returned an unexpected format');
    items.push(...parsed.data.data.map(mapPost));
  }
  return items;
}
const MENTION_PROVIDERS = { official: mentionsOfficial, rss: mentionsRss, arctic: mentionsArctic };

// source.subject = the app's short name ("Robinhood"); falls back to external_id. One request per source per run.
async function collectMentions(source) {
  const term = cleanTerm(source.subject || source.external_id);
  if (term.length < 2) throw new UpstreamError('Invalid search term');
  const chain = mentionChain();
  if (!chain.length) {
    throw new UpstreamError('Reddit mention search is not available with the current settings');
  }
  const failures = [];
  const blocking = []; // statuses from Reddit's own endpoints (official / rss): they describe THE condition to report
  for (const name of chain) {
    try { return { items: await MENTION_PROVIDERS[name](term), provider: name }; }
    catch (err) {
      failures.push(`${name}: ${String(err.message).slice(0, 60)}`);
      if (name !== 'arctic') blocking.push(err.status);
    }
  }
  // 403 = Reddit refuses this network; 429 = Reddit asks us to slow down. Either one explains the failure even if the
  // fallback also had nothing (e.g. no community is named after the app).
  const status = blocking.includes(403) ? 403 : blocking.includes(429) ? 429 : 0;
  throw new UpstreamError(`Reddit search unavailable (${failures.join('; ')})`, { retryable: true, status });
}

// ---- problem keywords: "revenge trading", "not following my system" via Reddit-wide search ----
// Only Reddit-wide providers apply (Arctic Shift cannot text-search across Reddit). The query is the keyword's
// significant words, unquoted, so differently-worded posts still match; the pipeline then verifies every post.
function keywordChain() {
  const m = mode();
  if (m === 'off' || m === 'arctic') return [];
  if (m === 'official') return officialConfigured() ? ['official'] : [];
  if (m === 'rss') return ['rss'];
  return [...(officialConfigured() ? ['official'] : []), 'rss'];
}
const KEYWORD_PROVIDERS = { official: searchOfficialQuery, rss: searchRssQuery };

async function collectKeyword(source) {
  const phrase = cleanTerm(source.subject || source.external_id);
  const words = keywordStems(phrase); // significant words only (stop-words dropped)
  const query = words.length ? phrase.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP_WORDS.has(w)).join(' ') || phrase : phrase;
  if (query.length < 2) throw new UpstreamError('Invalid search keyword');
  const chain = keywordChain();
  if (!chain.length) throw new UpstreamError(mode() === 'arctic'
    ? 'Keyword search needs Reddit-wide search (the official API or Reddit RSS); REDDIT_PROVIDER=arctic cannot do it'
    : 'Keyword search is not available with the current settings');
  const failures = [];
  const statuses = [];
  for (const name of chain) {
    try { return { items: await KEYWORD_PROVIDERS[name](query), provider: name }; }
    catch (err) { failures.push(`${name}: ${String(err.message).slice(0, 60)}`); statuses.push(err.status); }
  }
  const status = statuses.includes(403) ? 403 : statuses.includes(429) ? 429 : 0;
  throw new UpstreamError(`Reddit search unavailable (${failures.join('; ')})`, { retryable: true, status });
}

function resetToken() { token = { value: null, expiresAt: 0 }; }

module.exports = { collect, collectMentions, collectKeyword, keywordChain, mentionChain, resolve, searchSubreddits, isEnabled, mode, providerChain, parseAtom, mapPost, resetToken };
