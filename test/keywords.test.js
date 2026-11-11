// Problem keywords ("revenge trading"): matching, promotion filtering, Reddit keyword search, API, ranking, MCP.
// No network: Apple and Reddit are faked.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thevoice-kw-test-'));
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.NODE_ENV = 'test';
for (const k of ['REDDIT_PROVIDER', 'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT', 'CRON_SECRET']) delete process.env[k];

const { createClient } = require('@libsql/client');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const app = require('../server');
const db = require('../database');
const http = require('../collectors/http');
const reddit = require('../collectors/reddit');
const pipeline = require('../collectors/pipeline');
const runner = require('../collectors');
const kw = require('../keywords');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const res = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });

let calls = [];
let routes = [];
function fakeFetch(url, init) {
  calls.push({ url, init });
  for (const [m, h] of routes) if (url.includes(m)) { const o = typeof h === 'function' ? h(url, init) : h; return Promise.resolve(o instanceof Response ? o : res(o)); }
  return Promise.resolve(new Response('not found', { status: 404 }));
}
const callsTo = (s) => calls.filter((c) => c.url.includes(s)).length;

let server, base, ipN = 0, emailN = 0, srcN = 0;
const openClients = [];
before(async () => {
  await db.init();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  for (const c of openClients) await c.close().catch(() => {});
  server.close(); db.client.close(); fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls = []; routes = [];
  http.reset();
  http.configure({ fetchImpl: fakeFetch, sleep: () => new Promise((r) => setImmediate(r)) });
  reddit.resetToken();
  for (const k of ['REDDIT_PROVIDER', 'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT']) delete process.env[k];
});

function client() {
  const ip = `10.6.0.${++ipN}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const t = await r.text(); let json; try { json = JSON.parse(t); } catch { json = t; }
    return { status: r.status, json };
  };
  return { call, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}) };
}
async function user() {
  const c = client();
  const r = await c.post('/api/auth/signup', { email: `kw${++emailN}@example.com`, password: 'password123' });
  assert.equal(r.status, 201); c.id = r.json.id; return c;
}
const profile = { app_description: 'A trading journal', target_user: 'Day traders', voice_tone: 'Direct' };
const KW = ['revenge trading', 'not following my system'];
const row = (n, over = {}) => ({
  external_id: `kq${++srcN}-${n}`, quote: `I keep struggling with thing number ${srcN}-${n} so much`, source: 'Reddit r/Daytrading',
  source_url: 'https://www.reddit.com/r/Daytrading/comments/a/b/', rating: null, pain_score: 0.5, content_hash: `kh${srcN}-${n}`, published_at: Date.now(), fetched_at: Date.now(), ...over
});
// Public sources/quotes are shared between tests, so API tests use their own phrase: `pivot7 trading` / `pivot7 slipped`.
const uniq = () => { const n = ++srcN; return { a: `pivot${n} trading`, b: `slip${n} system`, ta: `pivot${n} trading`, tb: `slip${n} system` }; };
const kwSource = (k) => db.upsertSource({ type: 'reddit_keyword', external_id: kw.keywordKey(k), country: '', label: `Reddit: “${k}”`, url: 'https://www.reddit.com/search/', subject: k });

// =====================================================================
// matching
// =====================================================================
test('keywordStems: significant words only, inflections folded', () => {
  assert.deepEqual(kw.keywordStems('revenge trading'), ['reveng', 'trad']);
  assert.deepEqual(kw.keywordStems('not following my system'), ['follow', 'system']);
  assert.deepEqual(kw.keywordStems('FOMO'), ['fomo']);
  assert.deepEqual(kw.keywordStems('I keep breaking my rules'), ['keep', 'break', 'rule']);
  assert.deepEqual(kw.keywordStems("can't"), ['cant']); // all stop-words → falls back to what is there
  assert.equal(kw.normalizeKeyword('  “revenge   trading”  '), 'revenge trading');
  assert.equal(kw.keywordKey('Revenge  Trading'), 'revenge trading');
});

test('matchKeywords: any word order and inflection; unrelated text does not match', () => {
  const m = (t) => kw.matchKeywords(t, KW);
  assert.deepEqual(m('I revenge traded again after the loss'), ['revenge trading']);
  assert.deepEqual(m('I keep revenge trading and it never works'), ['revenge trading']);
  assert.deepEqual(m('I never follow my rules, my system is useless'), ['not following my system']);
  assert.deepEqual(m('revenge trading AND I do not follow my system'), KW);
  assert.deepEqual(m('The weather is nice today'), []);
  assert.deepEqual(m('I trade stocks and follow the news'), []); // one word of each keyword is not enough
  assert.deepEqual(kw.matchKeywords('anything', []), []);
});

test('the SQL predicate agrees with the JS matcher on every example', async () => {
  const mem = createClient({ url: ':memory:' });
  const texts = ['I revenge traded again', 'I never follow my rules, my system is useless', 'The weather is nice', 'I trade stocks and follow the news',
    'REVENGE TRADING!!', 'systems fail when I follow nothing', 'Today I traded well'];
  for (const keywords of [KW, ['revenge trading'], ['fomo'], []]) {
    const { sql, args } = kw.sqlKeywordMatch(keywords);
    for (const t of texts) {
      const r = await mem.execute({ sql: `SELECT ${sql} AS hit FROM (SELECT ? AS quote) q`, args: [...args, t] });
      assert.equal(Boolean(Number(r.rows[0].hit)), kw.matchKeywords(t, keywords).length > 0, `${JSON.stringify(keywords)} vs ${t}`);
    }
  }
  mem.close();
});

// =====================================================================
// promotion filter
// =====================================================================
test('isPromotion: course sellers, signal groups, referral codes and self-promoted apps are dropped; genuine problems are kept', () => {
  const promo = (t, b = '', strict = false) => pipeline.isPromotion(t, b, { strict });
  // dropped
  assert.equal(promo('Join my Discord for free signals', 'I post trading signals every day, DM me'), true);
  assert.equal(promo('I built a trading journal app', 'Looking for feedback, try it free at the link below'), true);
  assert.equal(promo('[Promo] 50% off my course', 'Use code SAVE'), true);
  assert.equal(promo('Enroll in my mentorship', 'Only 5 spots left, link in bio'), true);
  assert.equal(promo('Best trading signals', 'Join our Telegram group for copy trading'), true);
  assert.equal(promo('Beta testers wanted', 'We are launching soon, join the waitlist'), true);
  assert.equal(promo('Subscribe to my YouTube channel', 'I talk about revenge trading', true), true); // keyword searches are stricter
  // kept
  assert.equal(promo('Revenge trading wrecked me', 'I keep revenge trading after a loss and I hate it'), false);
  assert.equal(promo('I made a trading journal but never review it', 'I keep breaking my rules and I hate it'), false); // not a pitch
  assert.equal(promo('My course taught me nothing', 'I paid for a course and I still revenge trade'), false); // a buyer's complaint
  assert.equal(promo('Why do I keep doing this?', 'Every time I lose I double down. Free advice welcome'), false);
  assert.equal(promo('Subscribe to my YouTube channel', 'I talk about revenge trading', false), false); // only the keyword path is this strict
});

const kwItem = (id, title, body, sub = 'Daytrading') => ({ external_id: `t3_${id}`, kind: 'post', title, body, url: `https://www.reddit.com/r/${sub}/comments/${id}/x/`, published_at: Date.now(), flags: {} });
const kwSourceRow = { type: 'reddit_keyword', subject: 'revenge trading', external_id: 'revenge trading', label: 'x' };

test('pipeline for a keyword source: keeps real problem posts, drops promotions and posts that do not discuss the problem', () => {
  const out = pipeline.process([
    kwItem('a', 'Why do I keep revenge trading?', 'Every time I lose I double down and I hate it.'),
    kwItem('b', 'Join my Discord for revenge trading signals', 'I post free signals daily, DM me'),
    kwItem('c', 'I built an app to stop revenge trading', 'Looking for feedback, try it free, link below'),
    kwItem('d', 'Best breakfast spots', 'I love pancakes and hate waiting in line', 'food'),
    kwItem('e', 'My course taught me nothing about revenge trading', 'I paid a lot and I still blow accounts. I hate it.', 'Trading'),
    kwItem('f', 'Subscribe to my YouTube channel about revenge trading', 'I keep failing at it myself', 'Daytrading')
  ], kwSourceRow);
  assert.deepEqual(out.rows.map((r) => r.external_id).sort(), ['t3_a', 't3_e']);
  assert.equal(out.rows[0].source.startsWith('Reddit r/'), true);
  assert.equal(out.rows[0].rating, null);
});

test('keyword results use the relaxed rule (topic match is the signal) and get a small score boost', () => {
  const question = kwItem('q', 'How to stop revenge trading?', 'Any advice for dealing with this, tips welcome please');
  const asKeyword = pipeline.process([question], kwSourceRow);
  const asCommunity = pipeline.process([question], { type: 'reddit', label: 'r/Daytrading', external_id: 'daytrading' });
  assert.equal(asKeyword.rows.length, 1); // no "I" and no pain word, but it is exactly about the problem
  assert.equal(asCommunity.rows.length, 0); // a plain community post still needs a first-person pain signal
  const strong = kwItem('s', 'I keep revenge trading', 'I hate it and I keep failing every single day');
  const boosted = pipeline.process([strong], kwSourceRow).rows[0].pain_score;
  const plain = pipeline.process([strong], { type: 'reddit', label: 'r/Daytrading', external_id: 'daytrading' }).rows[0].pain_score;
  assert.ok(boosted > plain, `${boosted} should exceed ${plain}`);
  assert.ok(boosted <= 1);
});

test('promotion filtering applies to community and competitor-complaint posts as well', () => {
  const promo = kwItem('p', 'Join my Discord', 'I hate losing and I keep failing, DM me for signals');
  assert.equal(pipeline.process([promo], { type: 'reddit', label: 'r/Daytrading', external_id: 'daytrading' }).rows.length, 0);
  assert.equal(pipeline.process([{ ...promo, title: 'Robinhood Discord' }], { type: 'reddit_search', subject: 'Robinhood', external_id: 'robinhood', label: 'x' }).rows.length, 0);
});

// =====================================================================
// Reddit keyword collection
// =====================================================================
test('keywordChain: Reddit-wide providers only (Arctic Shift cannot text-search across Reddit)', () => {
  assert.deepEqual(reddit.keywordChain(), ['rss']);
  process.env.REDDIT_CLIENT_ID = 'id'; process.env.REDDIT_CLIENT_SECRET = 's'; process.env.REDDIT_USER_AGENT = 'a/1';
  assert.deepEqual(reddit.keywordChain(), ['official', 'rss']);
  process.env.REDDIT_PROVIDER = 'arctic'; assert.deepEqual(reddit.keywordChain(), []);
  process.env.REDDIT_PROVIDER = 'off'; assert.deepEqual(reddit.keywordChain(), []);
});

test('collect a keyword via Reddit search: only genuine, non-promotional posts that discuss the problem are stored', async () => {
  routes = [['search.rss', () => res(fx('reddit-keyword.rss'))]];
  const sid = await kwSource('revenge trading');
  const out = await runner.collectSource(await db.getSource(sid), { trigger: 'cli' });
  assert.equal(out.status, 'ok');
  assert.equal(out.provider, 'rss');
  assert.equal(out.fetched, 7);
  assert.equal(out.inserted, 3); // k1, k2, k5 — promotions (k3 k4 k7) and the unrelated post (k6) are dropped
  const rows = (await db.client.execute({ sql: 'SELECT external_id, source FROM pain_quotes WHERE source_id = ? ORDER BY external_id', args: [sid] })).rows;
  assert.deepEqual(rows.map((r) => r.external_id), ['t3_k1', 't3_k2', 't3_k5']);
  assert.deepEqual(rows.map((r) => r.source), ['Reddit r/Daytrading', 'Reddit r/Forex', 'Reddit r/Trading']);
  assert.match(calls[0].url, /search\.rss\?q=revenge%20trading&sort=new&t=month&limit=100/); // significant words, unquoted
  assert.equal((await runner.collectSource(await db.getSource(sid))).inserted, 0); // idempotent
});

test('a multi-word keyword searches on its significant words (stop-words removed)', async () => {
  routes = [['search.rss', () => res(fx('reddit-keyword.rss'))]];
  const sid = await kwSource('not following my system');
  await runner.collectSource(await db.getSource(sid));
  assert.match(calls[0].url, /q=following%20system&/);
  // and only posts whose text really covers those words are kept (k1: "I have a system but I do not follow it")
  const kept = (await db.client.execute({ sql: 'SELECT external_id FROM pain_quotes WHERE source_id = ?', args: [sid] })).rows.map((r) => r.external_id);
  assert.deepEqual(kept, ['t3_k1']);
});

test('keyword search: official API first; 403 → clear "blocked" status with a 6 h retry; arctic-only mode explains; Reddit off → disabled', async () => {
  process.env.REDDIT_CLIENT_ID = 'id'; process.env.REDDIT_CLIENT_SECRET = 's'; process.env.REDDIT_USER_AGENT = 'agent/1.0';
  routes = [
    ['api/v1/access_token', () => res(fx('reddit-token.json'))],
    ['oauth.reddit.com/search', () => res({ data: { children: [{ kind: 't3', data: { id: 'o9', name: 't3_o9', title: 'I keep revenge trading', selftext: 'I hate it and I keep failing', created_utc: 1794300000, permalink: '/r/Daytrading/comments/o9/x/', over_18: false, stickied: false, removed_by_category: null, subreddit: 'Daytrading' } }] } })]
  ];
  const sid = await kwSource('revenge trading');
  const ok = await runner.collectSource(await db.getSource(sid));
  assert.equal(ok.provider, 'official');
  assert.equal(ok.inserted, 1);
  assert.match(calls.find((c) => c.url.includes('oauth.reddit.com/search')).url, /q=revenge%20trading/);

  for (const k of ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT']) delete process.env[k];
  calls = []; // (the official-API token request above also went to www.reddit.com)
  routes = [['search.rss', () => new Response('blocked', { status: 403 })]];
  const blocked = await runner.collectSource(await db.getSource(await kwSource('fomo trading')));
  assert.equal(blocked.status, 'error');
  assert.equal(blocked.blocked, true);
  assert.match(blocked.error, /blocking automated requests from this network/);
  assert.equal(callsTo('www.reddit.com'), 1);

  process.env.REDDIT_PROVIDER = 'arctic';
  const arctic = await runner.collectSource(await db.getSource(await kwSource('overtrading problem')));
  assert.equal(arctic.status, 'error');
  assert.match(arctic.error, /needs Reddit-wide search/);

  process.env.REDDIT_PROVIDER = 'off';
  assert.equal((await runner.collectSource(await db.getSource(await kwSource('another problem')))).status, 'disabled');
});

test('keyword sources are collected after App Store, competitor-complaint and community sources', async () => {
  routes = [['search.rss', () => res(fx('reddit-keyword.rss'))], ['page=1/', () => res(fx('appstore-reviews-page1.json'))], ['page=2/', () => res(fx('appstore-reviews-empty.json'))]];
  const k = await kwSource('ordering problem');
  const store = await db.upsertSource({ type: 'app_store', external_id: `88${++srcN}00`, country: 'us', label: 'Order App (App Store, US)', url: 'u', subject: 'Order App' });
  const out = await runner.runDue({ trigger: 'cli', ids: [k, store], budgetMs: 60000 });
  assert.deepEqual(out.results.map((r) => r.source_id), [store, k]);
});

// =====================================================================
// API: setup, founder, problems
// =====================================================================
test('setup: problem keywords are validated, de-duplicated and stored; each gets a shared Reddit search source (role keyword)', async () => {
  const u = await user();
  const r = await u.post('/api/setup', { ...profile, problem_keywords: ['revenge trading', '  Revenge   Trading ', '“not following my system”'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.keywords, ['revenge trading', 'not following my system']); // quotes stripped, case-insensitive de-dupe
  const srcs = r.json.sources.filter((s) => s.type === 'reddit_keyword');
  assert.equal(srcs.length, 2);
  assert.ok(srcs.every((s) => s.role === 'keyword' && s.location === null));
  const rev = srcs.find((s) => s.subject === 'revenge trading');
  assert.equal(rev.label, 'Reddit: “revenge trading”');
  assert.match(rev.url, /^https:\/\/www\.reddit\.com\/search\/\?q=revenge%20trading/);
  assert.deepEqual((await u.get('/api/founder')).json.keywords, ['revenge trading', 'not following my system']);
  // an omitted field leaves them alone; [] clears them (and their sources); replacing swaps them
  assert.equal((await u.post('/api/setup', { ...profile })).json.keywords.length, 2);
  const swapped = await u.post('/api/setup', { ...profile, problem_keywords: ['overtrading'] });
  assert.deepEqual(swapped.json.keywords, ['overtrading']);
  assert.deepEqual(swapped.json.sources.filter((s) => s.type === 'reddit_keyword').map((s) => s.subject), ['overtrading']);
  const cleared = await u.post('/api/setup', { ...profile, problem_keywords: [] });
  assert.deepEqual(cleared.json.keywords, []);
  assert.equal(cleared.json.sources.filter((s) => s.type === 'reddit_keyword').length, 0);
});

test('setup validation for keywords: max 8, 3-60 characters, real words', async () => {
  const u = await user();
  const nine = Array.from({ length: 9 }, (_, i) => `problem number ${i}`);
  assert.equal((await u.post('/api/setup', { ...profile, problem_keywords: nine })).status, 400);
  assert.equal((await u.post('/api/setup', { ...profile, problem_keywords: Array.from({ length: 8 }, (_, i) => `problem number ${i}`) })).status, 200);
  assert.equal((await u.post('/api/setup', { ...profile, problem_keywords: ['ab'] })).status, 400);
  assert.equal((await u.post('/api/setup', { ...profile, problem_keywords: ['x'.repeat(61)] })).status, 400);
  assert.equal((await u.post('/api/setup', { ...profile, problem_keywords: ['!!! ???'] })).status, 400);
  assert.equal((await u.post('/api/setup', { ...profile, problem_keywords: 'revenge trading' })).status, 400); // must be a list
});

test('ZERO competitors is allowed: no competitor field at all, and competitor_url can be empty', async () => {
  const u = await user();
  const r = await u.post('/api/setup', { ...profile });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.competitors, []);
  assert.equal(r.json.competitor_url, '');
  assert.equal((await u.post('/api/setup', { ...profile, competitor_url: '', competitor_sources: [], problem_keywords: ['revenge trading'] })).status, 200);
});

test('with Reddit off, problems are still saved (they highlight quotes) but no search source is created', async () => {
  process.env.REDDIT_PROVIDER = 'off';
  const u = await user();
  const r = await u.post('/api/setup', { ...profile, problem_keywords: ['revenge trading'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.keywords, ['revenge trading']);
  assert.equal(r.json.sources.filter((s) => s.type === 'reddit_keyword').length, 0);
});

test('GET /api/problems: matching quotes counted across ALL sources, search status and where posts came from; isolated per user', async () => {
  const a = await user();
  const b = await user();
  const k = uniq();
  await a.post('/api/setup', { ...profile, problem_keywords: [k.a, k.b] });
  await b.post('/api/setup', { ...profile, problem_keywords: ['fomo'] });
  const search = (await a.get('/api/founder')).json.sources.find((s) => s.type === 'reddit_keyword' && s.subject === k.a);
  // quotes from the keyword search, from a community, and from an app review — all count if they match
  const comm = await db.upsertSource({ type: 'reddit', external_id: `kwc${++srcN}`, country: '', label: 'r/kwc', url: 'https://www.reddit.com/r/kwc/' });
  await db.followSource(a.id, comm, 'community');
  await db.insertQuotes(search.id, [row(1, { quote: `I keep ${k.ta} every single day and hate it`, source_url: 'https://www.reddit.com/r/Forex/comments/z/y/' }), row(2, { quote: `My ${k.ta} keep failing, so frustrated` })]);
  await db.insertQuotes(comm, [row(3, { quote: `I never keep my ${k.tb} and it fails me again` }), row(4, { quote: 'Nothing relevant here, just a normal day of pain' })]);
  await db.client.execute({ sql: "UPDATE sources SET last_status = 'ok', last_collected_at = ? WHERE id = ?", args: [Date.now(), search.id] });

  const p = (await a.get('/api/problems')).json;
  assert.deepEqual(p.problems.map((x) => x.keyword), [k.a, k.b]);
  const first = p.problems[0];
  assert.equal(first.matching_quotes, 2);
  assert.equal(first.search.status, 'ok');
  assert.equal(first.search.quote_count, 2);
  assert.deepEqual(first.search.subreddits.map((s) => [s.name, s.count]).sort(), [['Daytrading', 1], ['Forex', 1]]);
  assert.equal(p.problems[1].matching_quotes, 1); // found in a community post, not from the keyword search
  assert.equal((await b.get('/api/problems')).json.problems[0].matching_quotes, 0); // b doesn't see a's data
  assert.equal((await client().get('/api/problems')).status, 401);
});

test('quotes carry matched_keywords; ?problems=1 returns only matches; matches rank first; keyword search quotes are not "an app"', async () => {
  const u = await user();
  const k = uniq();
  await u.post('/api/setup', { ...profile, problem_keywords: [k.a] });
  const search = (await u.get('/api/founder')).json.sources.find((s) => s.type === 'reddit_keyword');
  const comm = await db.upsertSource({ type: 'reddit', external_id: `kwd${++srcN}`, country: '', label: 'r/kwd', url: 'https://www.reddit.com/r/kwd/' });
  await db.followSource(u.id, comm, 'community');
  await db.insertQuotes(comm, [row(1, { quote: 'Plain pain with a HIGHER score and no problem keyword here', pain_score: 0.9 }), row(2, { quote: `I ${k.ta} again and lost so much money today`, pain_score: 0.2 })]);
  await db.insertQuotes(search.id, [row(3, { quote: `${k.ta} is destroying me every week`, pain_score: 0.3, source_url: 'https://www.reddit.com/r/Forex/comments/q/w/' })]);

  const all = (await u.get('/api/pain-quotes?limit=10&source_type=reddit')).json;
  assert.deepEqual(all.map((q) => q.matched_keywords.length > 0), [true, true, false]); // matches first, then by score
  const only = (await u.get('/api/pain-quotes?limit=10&problems=1')).json;
  assert.equal(only.length, 2);
  assert.ok(only.every((q) => q.matched_keywords.includes(k.a)));
  const fromSearch = only.find((q) => q.source_type === 'reddit_keyword');
  assert.equal(fromSearch.app, null); // the keyword is a problem, not an app
  assert.equal(fromSearch.subreddit, 'Forex');
  assert.equal((await u.get('/api/pain-quotes?problems=2')).status, 400);
  // sampling: matches are taken first, so a 2-quote draw out of 3 always contains both matches
  for (let i = 0; i < 10; i++) {
    const smp = await db.sampleUserQuotes(u.id, { limit: 2 });
    assert.equal(smp.filter((q) => q.matched_keywords.length).length, 2);
  }
  const justOne = await db.sampleUserQuotes(u.id, { limit: 10, keyword: k.a });
  assert.equal(justOne.length, 2);
  assert.deepEqual(await db.sampleUserQuotes(u.id, { limit: 10, keyword: 'something not tracked' }), []);
});

test('strict location mode does not hide keyword-search quotes (they cannot be tied to a place)', async () => {
  const u = await user();
  const k = uniq();
  await u.post('/api/setup', { ...profile, locations: [{ country: 'us' }], problem_keywords: [k.a] });
  const search = (await u.get('/api/founder')).json.sources.find((s) => s.type === 'reddit_keyword');
  await db.insertQuotes(search.id, [row(1, { quote: `${k.ta} keeps wrecking my account every week` })]);
  const q = (await u.get('/api/pain-quotes')).json;
  assert.equal(q.length, 1);
  assert.equal(q[0].source_type, 'reddit_keyword');
});

// =====================================================================
// MCP
// =====================================================================
async function mcpFor(u) {
  u.key = (await u.post('/api/mcp-key')).json.key;
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${u.key}` } } }));
  openClients.push(c);
  return c;
}
const data = (r) => JSON.parse(r.content[0].text);

test('MCP: profile lists the problems to find; quotes list matched_keywords and matches come first; `problem` narrows; notes are honest', async () => {
  const u = await user();
  const k = uniq();
  await u.post('/api/setup', { ...profile, problem_keywords: [k.a] });
  const c = await mcpFor(u);
  assert.deepEqual(data(await c.callTool({ name: 'get_founder_profile', arguments: {} })).problem_keywords, [k.a]);

  // no quotes match yet, but quotes exist → the note says so instead of implying a match
  const comm = await db.upsertSource({ type: 'reddit', external_id: `kwm${++srcN}`, country: '', label: 'r/kwm', url: 'https://www.reddit.com/r/kwm/' });
  await db.followSource(u.id, comm, 'community');
  await db.client.execute({ sql: "UPDATE sources SET last_status='ok', last_collected_at=? WHERE id = ?", args: [Date.now(), comm] });
  await db.insertQuotes(comm, [row(1, { quote: 'Just a plain painful quote about nothing in particular here' })]);
  const none = data(await c.callTool({ name: 'get_pain_quotes', arguments: { limit: 5 } }));
  assert.deepEqual(none.meta.problem_keywords, [k.a]);
  assert.ok(none.meta.note.includes(`None of these quotes match the problems the founder is tracking (${k.a})`), none.meta.note);

  await db.insertQuotes(comm, [row(2, { quote: `I ${k.ta} again today and I hate myself for it`, pain_score: 0.1 })]);
  const some = data(await c.callTool({ name: 'get_pain_quotes', arguments: { limit: 5 } }));
  const hit = some.quotes.find((q) => q.matched_keywords.length);
  assert.deepEqual(hit.matched_keywords, [k.a]);
  assert.doesNotMatch(some.meta.note, /None of these quotes match/);
  const focused = data(await c.callTool({ name: 'get_pain_quotes', arguments: { limit: 5, problem: k.a.toUpperCase() } }));
  assert.equal(focused.quotes.length, 1);
  assert.deepEqual(focused.quotes[0].matched_keywords, [k.a]);
  const missing = data(await c.callTool({ name: 'get_pain_quotes', arguments: { limit: 5, problem: 'fomo' } }));
  assert.deepEqual(missing.quotes, []);
  assert.match(missing.meta.note, /No collected quote matches the problem "fomo"/);
  assert.match((await c.listTools()).tools.find((t) => t.name === 'get_pain_quotes').description, /problem_keywords/);
});
