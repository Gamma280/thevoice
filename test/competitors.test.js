// Multiple competitors, Reddit complaints about them, and the "which app / when published" fields.
// No network: Apple and Reddit are faked.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thevoice-comp-test-'));
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.NODE_ENV = 'test';
for (const k of ['REDDIT_PROVIDER', 'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT', 'CRON_SECRET']) delete process.env[k];

const app = require('../server');
const db = require('../database');
const http = require('../collectors/http');
const reddit = require('../collectors/reddit');
const appstore = require('../collectors/appstore');
const pipeline = require('../collectors/pipeline');
const runner = require('../collectors');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const res = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });

// ---- fake outside world ----
let calls = [];
let routes = [];
function fakeFetch(url, init) {
  calls.push({ url, init });
  for (const [m, h] of routes) if (url.includes(m)) { const o = typeof h === 'function' ? h(url, init) : h; return Promise.resolve(o instanceof Response ? o : res(o)); }
  return Promise.resolve(new Response('not found', { status: 404 }));
}
const callsTo = (s) => calls.filter((c) => c.url.includes(s)).length;
// Apple lookup: answers for exactly the requested ids; the UK storefront doesn't carry Fidelity.
const lookupRoute = ['itunes.apple.com/lookup', (url) => {
  const ids = ((/[?&]id=([\d,]+)/.exec(url) || [])[1] || '').split(',');
  const country = (/[?&]country=([a-z]{2})/.exec(url) || [])[1];
  const all = JSON.parse(fx('apple-lookup-multi.json')).results;
  const results = all.filter((r) => ids.includes(String(r.trackId)) && !(country === 'gb' && r.trackId === 348177453));
  return res({ resultCount: results.length, results });
}];
const ROBINHOOD = '938003185', COINBASE = '886427730', FIDELITY = '348177453';

let server, base, ipN = 0, emailN = 0, srcN = 0;
before(async () => {
  await db.init();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  calls = []; routes = [lookupRoute];
  http.reset();
  http.configure({ fetchImpl: fakeFetch, sleep: () => new Promise((r) => setImmediate(r)) });
  reddit.resetToken();
  for (const k of ['REDDIT_PROVIDER', 'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT']) delete process.env[k];
});

function client() {
  const ip = `10.5.0.${++ipN}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(cookie && { cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const t = await r.text(); let json; try { json = JSON.parse(t); } catch { json = t; }
    return { status: r.status, json };
  };
  return { call, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}) };
}
async function user() {
  const c = client();
  const r = await c.post('/api/auth/signup', { email: `cp${++emailN}@example.com`, password: 'password123' });
  assert.equal(r.status, 201); c.id = r.json.id; return c;
}
const profile = { app_description: 'A trading journal', target_user: 'Day traders', voice_tone: 'Direct', competitor_url: 'Robinhood, Coinbase' };
const apps = (...ids) => ids.map((external_id) => ({ type: 'app_store', external_id }));
const types = (json, type) => json.sources.filter((s) => s.type === type);

// =====================================================================
test('brandName: the short name people actually write', () => {
  assert.equal(appstore.brandName('Robinhood: Trading & Investing'), 'Robinhood');
  assert.equal(appstore.brandName('Coinbase: Buy Crypto & Stocks'), 'Coinbase');
  assert.equal(appstore.brandName('Trading 212 - Stocks & ETFs'), 'Trading 212');
  assert.equal(appstore.brandName('Fidelity Investments'), 'Fidelity Investments');
  assert.equal(appstore.brandName('X'), 'X');
});

test('lookupMany: ONE request for many apps; unavailable and invalid ids are simply absent', async () => {
  const found = await appstore.lookupMany([ROBINHOOD, COINBASE, FIDELITY, 'abc', ROBINHOOD], 'us');
  assert.equal(callsTo('itunes.apple.com/lookup'), 1);
  assert.match(calls[0].url, /id=938003185,886427730,348177453&country=us/);
  assert.deepEqual([...found.keys()].sort(), [FIDELITY, COINBASE, ROBINHOOD].sort());
  const rh = found.get(ROBINHOOD);
  assert.equal(rh.brand, 'Robinhood');
  assert.equal(rh.name, 'Robinhood: Trading & Investing');
  assert.equal(rh.subject, rh.name);
  assert.match(rh.label, /\(App Store, US\)$/);
  const gb = await appstore.lookupMany([ROBINHOOD, FIDELITY], 'gb');
  assert.deepEqual([...gb.keys()], [ROBINHOOD]); // not in the UK storefront
  assert.equal((await appstore.lookupMany([], 'us')).size, 0);
  assert.equal((await appstore.lookupMany([ROBINHOOD], 'USA')).size, 0);
  assert.equal(await appstore.lookup(FIDELITY, 'gb'), null);
});

// ---------------------------------------------------------------- setup: many competitors
test('setup: 3 competitors × 2 countries → one batched Apple lookup per country, per-app sources, warnings, summary', async () => {
  const u = await user();
  const r = await u.post('/api/setup', { ...profile, competitor_sources: apps(ROBINHOOD, COINBASE, FIDELITY), locations: [{ country: 'us' }, { country: 'gb' }] });
  assert.equal(r.status, 200);
  assert.equal(callsTo('itunes.apple.com/lookup'), 2); // not 6
  const store = types(r.json, 'app_store');
  assert.equal(store.length, 5); // 3 in the US + 2 in the UK (Fidelity isn't there)
  assert.deepEqual(store.map((s) => `${s.subject}|${s.country}`).sort(), [
    'Coinbase: Buy Crypto & Stocks|gb', 'Coinbase: Buy Crypto & Stocks|us', 'Fidelity Investments|us',
    'Robinhood: Trading & Investing|gb', 'Robinhood: Trading & Investing|us'
  ]);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0].message, /Fidelity Investments isn’t available in the United Kingdom App Store/);
  assert.equal(r.json.competitors.length, 3);
  const rh = r.json.competitors.find((c) => c.external_id === ROBINHOOD);
  assert.deepEqual([...rh.countries].sort(), ['gb', 'us']);
  assert.equal(rh.brand, 'Robinhood');
  assert.deepEqual(r.json.competitors.find((c) => c.external_id === FIDELITY).countries, ['us']);
  assert.equal(r.json.competitor_mentions, false); // not requested
  assert.equal((await u.get('/api/founder')).json.competitors.length, 3);
});

test('setup: the cap is 5, duplicates collapse, the legacy single field still works, unknown app → 400, Apple down → 502 (nothing saved)', async () => {
  const u = await user();
  const six = ['111111', '222222', '333333', '444444', '555555', '666666'];
  assert.equal((await u.post('/api/setup', { ...profile, competitor_sources: apps(...six) })).status, 400);
  assert.equal((await u.post('/api/setup', { ...profile, competitor_sources: apps(ROBINHOOD, ROBINHOOD) })).json.competitors.length, 1);
  assert.equal((await u.post('/api/setup', { ...profile, competitor_source: { type: 'app_store', external_id: COINBASE } })).json.competitors[0].external_id, COINBASE);
  assert.equal((await u.post('/api/setup', { ...profile, competitor_sources: [...apps(ROBINHOOD), ...apps('999999999')] })).status, 400); // unknown id
  assert.equal((await u.get('/api/founder')).json.competitors[0].external_id, COINBASE); // failed save changed nothing
  routes = [['itunes.apple.com/lookup', () => new Response('x', { status: 503 })]];
  const fresh = await user();
  assert.equal((await fresh.post('/api/setup', { ...profile, competitor_sources: apps(ROBINHOOD) })).status, 502);
  assert.equal((await fresh.get('/api/founder')).status, 404);
  // an explicit empty list clears competitors
  routes = [lookupRoute];
  assert.deepEqual((await u.post('/api/setup', { ...profile, competitor_sources: [] })).json.competitors, []);
});

// ---------------------------------------------------------------- Reddit complaints about competitors
test('competitor_mentions: one Reddit search source per app brand, not tied to a location, with its own label/url/subject', async () => {
  const u = await user();
  const r = await u.post('/api/setup', { ...profile, competitor_sources: apps(ROBINHOOD, COINBASE), locations: [{ country: 'us' }, { country: 'gb' }], competitor_mentions: true });
  assert.equal(r.status, 200);
  const m = types(r.json, 'reddit_search');
  assert.deepEqual(m.map((s) => s.subject).sort(), ['Coinbase', 'Robinhood']); // one per brand, not per country
  const rh = m.find((s) => s.subject === 'Robinhood');
  assert.equal(rh.role, 'competitor');
  assert.equal(rh.location, null);
  assert.equal(rh.label, 'Reddit: complaints about “Robinhood”');
  assert.match(rh.url, /^https:\/\/www\.reddit\.com\/search\/\?q=%22Robinhood%22/);
  assert.equal(r.json.competitor_mentions, true);
});

test('competitor_mentions: false removes them, omitted keeps them (even when re-linking countries), Reddit off → explicit true is 400, inherited is dropped', async () => {
  const u = await user();
  await u.post('/api/setup', { ...profile, competitor_sources: apps(ROBINHOOD), locations: [{ country: 'us' }], competitor_mentions: true });
  const keep = await u.post('/api/setup', { ...profile, locations: [{ country: 'us' }, { country: 'gb' }] }); // re-link only
  assert.equal(types(keep.json, 'reddit_search').length, 1);
  assert.equal(types(keep.json, 'app_store').length, 2);
  assert.equal(types((await u.post('/api/setup', { ...profile, competitor_mentions: false })).json, 'reddit_search').length, 0);
  assert.equal(types((await u.post('/api/setup', { ...profile, competitor_mentions: true })).json, 'reddit_search').length, 1); // re-added without resubmitting apps
  process.env.REDDIT_PROVIDER = 'off';
  assert.equal((await u.post('/api/setup', { ...profile, competitor_mentions: true })).status, 400);
  const inherited = await u.post('/api/setup', { ...profile, locations: [{ country: 'us' }] });
  assert.equal(inherited.status, 200);
  assert.equal(types(inherited.json, 'reddit_search').length, 0); // can't be collected, so not kept
});

test('strict mode: competitor Reddit complaints stay visible ("all regions"); other non-local sources are still hidden', async () => {
  const u = await user();
  const r = await u.post('/api/setup', { ...profile, competitor_sources: apps(ROBINHOOD), locations: [{ country: 'us', region: 'Austin' }], competitor_mentions: true });
  const mention = types(r.json, 'reddit_search')[0];
  const store = types(r.json, 'app_store')[0];
  const globalSub = await db.upsertSource({ type: 'reddit', external_id: 'globalsub', country: '', label: 'r/globalsub', url: 'https://www.reddit.com/r/globalsub/' });
  await db.followSource(u.id, globalSub, 'community');
  const q = (n, over = {}) => ({ external_id: `c${++srcN}-${n}`, quote: `I keep struggling with number ${n} every day`, source: 'x', source_url: 'https://www.reddit.com/r/wallstreetbets/comments/a/b/', rating: null, pain_score: 0.5, content_hash: `ch${srcN}-${n}`, published_at: Date.now(), fetched_at: Date.now(), ...over });
  await db.insertQuotes(mention.id, [q(1)]);
  await db.insertQuotes(store.id, [q(2, { rating: 1 })]);
  await db.insertQuotes(globalSub, [q(3)]);
  const seen = (await u.get('/api/pain-quotes?limit=100')).json.map((x) => x.source_id).sort((a, b) => a - b);
  assert.deepEqual(seen, [mention.id, store.id].sort((a, b) => a - b)); // global community hidden, mention visible
});

// ---------------------------------------------------------------- Reddit mention collection
test('mentionChain: Reddit-wide search first, then the app-community fallback (Arctic Shift never searches all of Reddit)', () => {
  assert.deepEqual(reddit.mentionChain(), ['rss', 'arctic']);
  process.env.REDDIT_CLIENT_ID = 'id'; process.env.REDDIT_CLIENT_SECRET = 's'; process.env.REDDIT_USER_AGENT = 'a/1';
  assert.deepEqual(reddit.mentionChain(), ['official', 'rss', 'arctic']);
  process.env.REDDIT_PROVIDER = 'arctic'; assert.deepEqual(reddit.mentionChain(), ['arctic']);
  process.env.REDDIT_PROVIDER = 'rss'; assert.deepEqual(reddit.mentionChain(), ['rss']);
  process.env.REDDIT_PROVIDER = 'official'; assert.deepEqual(reddit.mentionChain(), ['official']);
  process.env.REDDIT_PROVIDER = 'off'; assert.deepEqual(reddit.mentionChain(), []);
});

test('mentionsTerm: whole word, case-insensitive, punctuation-safe', () => {
  assert.equal(pipeline.mentionsTerm('I lost money on Robinhood again', 'Robinhood'), true);
  assert.equal(pipeline.mentionsTerm("robinhood's app froze", 'Robinhood'), true);
  assert.equal(pipeline.mentionsTerm('Robinhoodies unite', 'Robinhood'), false);
  assert.equal(pipeline.mentionsTerm('Trading 212 is slow', 'Trading 212'), true);
  assert.equal(pipeline.mentionsTerm('c++ is hard', 'C++'), true);
  assert.equal(pipeline.mentionsTerm('anything', ''), false);
});

const mentionSource = (subject) => db.upsertSource({ type: 'reddit_search', external_id: `${subject.toLowerCase()}${++srcN}`, country: '', label: `Reddit: complaints about “${subject}”`, url: 'https://www.reddit.com/search/', subject });

test('collect mentions via RSS search: only real complaints that NAME the app are kept, with subreddit + publish date', async () => {
  routes = [['search.rss', () => res(fx('reddit-search.rss'))]];
  const sid = await mentionSource('Robinhood');
  const out = await runner.collectSource(await db.getSource(sid), { trigger: 'cli' });
  assert.equal(out.status, 'ok');
  assert.equal(out.provider, 'rss');
  assert.equal(out.fetched, 5);
  assert.equal(out.inserted, 2); // s3 is about Fidelity, s4 is a daily thread, s5 is "Robinhoodies"
  assert.match(calls[0].url, /search\.rss\?q=%22Robinhood%22&sort=new&t=month&limit=100/);
  const rows = (await db.client.execute({ sql: 'SELECT external_id, source, source_url, published_at FROM pain_quotes WHERE source_id = ? ORDER BY external_id', args: [sid] })).rows;
  assert.deepEqual(rows.map((r) => r.external_id), ['t3_s1', 't3_s2']);
  assert.deepEqual(rows.map((r) => r.source), ['Reddit r/wallstreetbets', 'Reddit r/stocks']);
  assert.equal(Number(rows[0].published_at), Date.parse('2026-11-07T10:00:00+00:00'));
  assert.match(rows[0].source_url, /^https:\/\/www\.reddit\.com\/r\/wallstreetbets\/comments\/s1\//);
  // idempotent
  const again = await runner.collectSource(await db.getSource(sid), { trigger: 'cli' });
  assert.equal(again.inserted, 0);
});

test('collect mentions: official API first when credentials exist (NSFW and other-app posts dropped); falls back to RSS if it fails', async () => {
  process.env.REDDIT_CLIENT_ID = 'id'; process.env.REDDIT_CLIENT_SECRET = 's'; process.env.REDDIT_USER_AGENT = 'agent/1.0';
  routes = [
    ['api/v1/access_token', () => res(fx('reddit-token.json'))],
    ['oauth.reddit.com/search', () => res(fx('reddit-search-official.json'))],
    ['search.rss', () => res(fx('reddit-search.rss'))]
  ];
  const sid = await mentionSource('Robinhood');
  const out = await runner.collectSource(await db.getSource(sid));
  assert.equal(out.provider, 'official');
  assert.equal(out.inserted, 1); // o1 only: o2 is NSFW, o3 is about Coinbase
  assert.equal(calls.find((c) => c.url.includes('oauth.reddit.com/search')).init.headers.authorization, 'bearer tok_fixture');
  assert.match(calls.find((c) => c.url.includes('oauth.reddit.com/search')).url, /q=%22Robinhood%22/);

  reddit.resetToken(); calls = [];
  routes = [['api/v1/access_token', () => new Response('x', { status: 500 })], ['search.rss', () => res(fx('reddit-search.rss'))]];
  const sid2 = await mentionSource('Robinhood');
  const out2 = await runner.collectSource(await db.getSource(sid2));
  assert.equal(out2.provider, 'rss');
  assert.equal(out2.inserted, 2);
});

test('collect mentions: all providers failing → error + backoff; arctic-only mode explains why; Reddit off → disabled (no failure)', async () => {
  routes = [['search.rss', () => new Response('x', { status: 500 })]];
  const sid = await mentionSource('Robinhood');
  const failed = await runner.collectSource(await db.getSource(sid));
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /Reddit search unavailable \(rss:/);
  assert.equal((await db.getSource(sid)).consecutive_failures, 1);
  assert.ok((await db.getSource(sid)).next_collect_at > Date.now() + 25 * 60000); // real failure → long backoff

  process.env.REDDIT_PROVIDER = 'arctic';
  routes = [['subreddits/search', () => res({ data: [] })]]; // no community is named after this app
  const sid2 = await mentionSource('Coinbase');
  const arctic = await runner.collectSource(await db.getSource(sid2));
  assert.equal(arctic.status, 'error');
  assert.match(arctic.error, /No community named after this app was found/);

  process.env.REDDIT_PROVIDER = 'off';
  const sid3 = await mentionSource('Fidelity');
  const off = await runner.collectSource(await db.getSource(sid3));
  assert.equal(off.status, 'disabled');
  assert.equal((await db.getSource(sid3)).consecutive_failures, 0);
});

// ---------------------------------------------------------------- Reddit blocks this network (HTTP 403)
const arcticBrandRoutes = () => [
  ['arctic-shift.photon-reddit.com/api/subreddits/search', () => res(fx('reddit-subreddits-swiggy-arctic.json'))],
  ['arctic-shift.photon-reddit.com/api/posts/search', () => res(fx('reddit-posts-swiggy.json'))]
];

test('Reddit 403 (blocked network) → falls back to the app\'s own community via Arctic Shift, never touching reddit.com again', async () => {
  routes = [['search.rss', () => new Response('blocked', { status: 403 })], ...arcticBrandRoutes()];
  const sid = await mentionSource('Swiggy');
  const out = await runner.collectSource(await db.getSource(sid), { trigger: 'cli' });
  assert.equal(out.status, 'ok');
  assert.equal(out.provider, 'arctic');
  assert.equal(out.fetched, 10); // 5 posts from each of r/swiggy and r/SwiggyGold (same fixture)
  assert.equal(out.inserted, 2); // only real complaints: b1, b2 (weekly thread, praise and NSFW are dropped; duplicates collapse)
  assert.equal(callsTo('www.reddit.com'), 1); // the one search that was refused — the fallback used no reddit.com request
  const asked = calls.filter((c) => c.url.includes('posts/search')).map((c) => /subreddit=([^&]+)/.exec(c.url)[1]);
  assert.deepEqual(asked, ['swiggy', 'SwiggyGold']); // NSFW / private / tiny / unrelated-name communities were not read
  const row = await db.getSource(sid);
  assert.equal(row.last_status, 'ok');
  assert.match(row.last_error, /blocking this network, so only communities named after the app are read/);
  assert.equal(row.consecutive_failures, 0);
  const quotes = (await db.client.execute({ sql: 'SELECT source, source_url FROM pain_quotes WHERE source_id = ?', args: [sid] })).rows;
  assert.ok(quotes.every((q) => q.source === 'Reddit r/swiggy' || q.source === 'Reddit r/SwiggyGold'));
});

test('Reddit 403 and no app community found → clear "blocked" error, retried in 6 HOURS, not counted as a failure, no hammering', async () => {
  routes = [['search.rss', () => new Response('blocked', { status: 403 })], ['arctic-shift.photon-reddit.com/api/subreddits/search', () => res({ data: [] })]];
  const sid = await mentionSource('Totallyuniqueapp');
  const out = await runner.collectSource(await db.getSource(sid));
  assert.equal(out.status, 'error');
  assert.equal(out.blocked, true);
  assert.match(out.error, /blocking automated requests from this network \(HTTP 403\)/);
  assert.match(out.error, /official Reddit API fixes this/);
  assert.equal(callsTo('www.reddit.com'), 1); // exactly one refused request — we did not retry in a loop
  const row = await db.getSource(sid);
  assert.equal(row.consecutive_failures, 0);
  assert.ok(row.next_collect_at > Date.now() + 5.5 * 3600000 && row.next_collect_at < Date.now() + 6.5 * 3600000);
  assert.ok(row.last_error && !/Reddit search unavailable|www\.reddit\.com/.test(row.last_error)); // no raw internals in the UI message
});

test('403 beats 429 as the reported condition; community posts that hit 403 on every provider are reported as blocked too', async () => {
  routes = [['search.rss', () => new Response('x', { status: 403 })], ['arctic-shift.photon-reddit.com/api/subreddits/search', () => new Response('x', { status: 500 })]];
  await assert.rejects(reddit.collectMentions({ subject: 'Swiggy', external_id: 'swiggy' }), (e) => e.status === 403);
  process.env.REDDIT_PROVIDER = 'rss';
  routes = [['/new/.rss', () => new Response('x', { status: 403 })]];
  await assert.rejects(reddit.collect({ external_id: 'testsub' }, {}), (e) => e.status === 403);
});

test('official API is tried first; its failure (403) still falls through to RSS then the app community', async () => {
  process.env.REDDIT_CLIENT_ID = 'id'; process.env.REDDIT_CLIENT_SECRET = 's'; process.env.REDDIT_USER_AGENT = 'agent/1.0';
  routes = [
    ['api/v1/access_token', () => new Response('x', { status: 403 })],
    ['search.rss', () => new Response('x', { status: 403 })],
    ...arcticBrandRoutes()
  ];
  const { provider, items } = await reddit.collectMentions({ subject: 'Swiggy', external_id: 'swiggy' });
  assert.equal(provider, 'arctic');
  assert.ok(items.length > 0);
});

test('community posts count as "about the app" without naming it; the same posts elsewhere need the name', () => {
  const post = { external_id: 't3_x', kind: 'post', title: 'It happened again', body: 'I keep getting the wrong order and I hate it', published_at: 1 };
  const inBrand = pipeline.process([{ ...post, url: 'https://www.reddit.com/r/swiggy/comments/1/a/' }], { type: 'reddit_search', subject: 'Swiggy', external_id: 'swiggy', label: 'x' });
  assert.equal(inBrand.rows.length, 1);
  assert.equal(inBrand.rows[0].source, 'Reddit r/swiggy');
  const elsewhere = pipeline.process([{ ...post, url: 'https://www.reddit.com/r/india/comments/1/a/' }], { type: 'reddit_search', subject: 'Swiggy', external_id: 'swiggy', label: 'x' });
  assert.equal(elsewhere.rows.length, 0); // doesn't name Swiggy and isn't in its community
  assert.equal(pipeline.isBrandCommunity('https://www.reddit.com/r/SwiggyGold/comments/1/a/', 'Swiggy'), true);
  assert.equal(pipeline.isBrandCommunity('https://www.reddit.com/r/swigglyfans/comments/1/a/', 'Swiggy'), false);
  assert.equal(pipeline.isBrandCommunity('https://www.reddit.com/r/x/comments/1/a/', 'ab'), false); // too short to trust
});

test('Reddit rate limit (429): friendly message, retried in minutes, NOT counted as a failure; spaced searches; Reddit runs after App Store', async () => {
  routes = [['search.rss', () => new Response('slow down', { status: 429 })]];
  const sid = await mentionSource('Swiggy');
  const limited = await runner.collectSource(await db.getSource(sid));
  assert.equal(limited.status, 'error');
  assert.equal(limited.rate_limited, true);
  assert.match(limited.error, /limiting how fast .* retry automatically/);
  assert.doesNotMatch(limited.error, /429|www\.reddit\.com/); // no raw internals in the UI message
  const row = await db.getSource(sid);
  assert.equal(row.consecutive_failures, 0); // upstream busy ≠ broken source
  assert.ok(row.next_collect_at > Date.now() + 2 * 60000 && row.next_collect_at < Date.now() + 5 * 60000);
  assert.equal(callsTo('search.rss'), 1); // one request, no in-request retry storm

  // the next attempt succeeds and clears the error
  routes = [['search.rss', () => res(fx('reddit-search.rss'))]];
  const ok = await runner.collectSource(await db.getSource(sid));
  assert.equal(ok.status, 'ok');
  assert.equal((await db.getSource(sid)).last_error, null);

  // ordering: App Store sources are collected before Reddit ones, whatever their schedule order
  const reddit1 = await mentionSource('Order1');
  const store = await db.upsertSource({ type: 'app_store', external_id: `77${++srcN}00`, country: 'us', label: 'Order App (App Store, US)', url: 'u', subject: 'Order App' });
  routes = [['search.rss', () => res(fx('reddit-search.rss'))], ['page=1/', () => res(fx('appstore-reviews-page1.json'))], ['page=2/', () => res(fx('appstore-reviews-empty.json'))]];
  const out = await runner.runDue({ trigger: 'cli', ids: [reddit1, store], budgetMs: 60000 });
  assert.deepEqual(out.results.map((r) => r.source_id), [store, reddit1]);

  // searches ask the HTTP layer for a long gap before the NEXT Reddit request
  const gaps = [];
  http.configure({ fetchImpl: fakeFetch, sleep: (ms) => { gaps.push(ms); return new Promise((r) => setImmediate(r)); } });
  routes = [['search.rss', () => res(fx('reddit-search.rss'))]];
  const a = await mentionSource('GapA'); const b2 = await mentionSource('GapB');
  await runner.collectSource(await db.getSource(a));
  await runner.collectSource(await db.getSource(b2));
  assert.ok(gaps.some((ms) => ms > 10000), `second Reddit search should wait ~20 s, waits: ${gaps}`);
});

// ---------------------------------------------------------------- which app + when published
test('quotes report which app they are about, the subreddit, and when they were published', async () => {
  const u = await user();
  const r = await u.post('/api/setup', { ...profile, competitor_sources: apps(ROBINHOOD), locations: [{ country: 'us' }], competitor_mentions: true });
  const store = types(r.json, 'app_store')[0];
  const mention = types(r.json, 'reddit_search')[0];
  const published = Date.parse('2026-11-08T10:00:00Z');
  const row = (n, over) => ({ external_id: `w${++srcN}-${n}`, quote: `I keep struggling with unique-marker-${srcN}-${n} so much`, source: 'x', source_url: 'https://apps.apple.com/us/app/id1', rating: 1, pain_score: 0.5, content_hash: `wh${srcN}-${n}`, published_at: published, fetched_at: Date.now(), ...over });
  await db.insertQuotes(store.id, [row(1, { source: 'App Store review (★1)' })]);
  await db.insertQuotes(mention.id, [row(2, { source: 'Reddit r/wallstreetbets', rating: null, source_url: 'https://www.reddit.com/r/wallstreetbets/comments/z/y/' })]);
  // public sources are shared between tests, so pick this test's quotes by their unique marker
  const quotes = (await u.get('/api/pain-quotes?limit=100')).json.filter((x) => /unique-marker-/.test(x.quote));
  const review = quotes.find((x) => x.source_type === 'app_store');
  const post = quotes.find((x) => x.source_type === 'reddit_search');
  assert.equal(review.app, 'Robinhood: Trading & Investing');
  assert.equal(review.subreddit, null);
  assert.equal(review.published_at, published);
  assert.equal(post.app, 'Robinhood');
  assert.equal(post.subreddit, 'wallstreetbets');
  assert.equal(post.published_at, published);
  assert.match(review.source_label, /Robinhood.*\(App Store, US\)/);
});

test('migration 4 backfills the app name for sources created before it existed', async () => {
  const u = await user();
  await db.client.execute({ sql: "INSERT INTO sources (type, external_id, country, label, url) VALUES ('app_store', 'legacy1', 'us', 'Legacy Bank (App Store, US)', 'u')", args: [] });
  const sid = Number((await db.client.execute("SELECT id FROM sources WHERE external_id = 'legacy1'")).rows[0].id);
  await db.followSource(u.id, sid, 'competitor');
  await db.insertQuotes(sid, [{ external_id: 'l1', quote: 'I keep struggling with their login every day', source: 'App Store review (★1)', source_url: 'https://apps.apple.com/us/app/id1', rating: 1, pain_score: 0.6, content_hash: 'legacyh', published_at: Date.now(), fetched_at: Date.now() }]);
  assert.equal((await u.get('/api/pain-quotes')).json[0].app, 'Legacy Bank'); // derived from the label when no subject is stored
  await db.upsertSource({ type: 'app_store', external_id: 'legacy1', country: 'us', label: 'Legacy Bank (App Store, US)', url: 'u', subject: 'Legacy Bank: Mobile' });
  assert.equal((await u.get('/api/pain-quotes')).json[0].app, 'Legacy Bank: Mobile'); // an explicit subject wins
});

test('saved content keeps app, date and subreddit in its quote snapshot — even after the quote is pruned', async () => {
  const u = await user();
  const r = await u.post('/api/setup', { ...profile, competitor_sources: apps(ROBINHOOD), locations: [{ country: 'us' }], competitor_mentions: true });
  const mention = types(r.json, 'reddit_search')[0];
  const published = Date.parse('2026-11-07T10:00:00Z');
  await db.insertQuotes(mention.id, [{ external_id: 'snap1', quote: 'I keep failing to sell on Robinhood and I hate it', source: 'Reddit r/stocks', source_url: 'https://www.reddit.com/r/stocks/comments/q/r/', rating: null, pain_score: 0.7, content_hash: 'snaph', published_at: published, fetched_at: Date.now() }]);
  const qid = (await u.get('/api/pain-quotes')).json[0].id;
  const saved = await u.post('/api/content', { hooks: ['a', 'b', 'c', 'd', 'e'], script: 's', inspiration_quote_ids: [qid] });
  assert.equal(saved.status, 201);
  const snap = saved.json.inspiration_quotes[0];
  assert.equal(snap.app, 'Robinhood');
  assert.equal(snap.subreddit, 'stocks');
  assert.equal(snap.published_at, published);
  assert.equal(snap.source_type, 'reddit_search');
  await db.client.execute({ sql: 'DELETE FROM pain_quotes WHERE id = ?', args: [qid] });
  const again = (await u.get('/api/content')).json[0].inspiration_quotes[0];
  assert.equal(again.app, 'Robinhood');
  assert.equal(again.published_at, published);
});

// ---------------------------------------------------------------- Reddit must not be crowded out by higher-scoring reviews
async function skewedUser() {
  const u = await user();
  assert.equal((await u.post('/api/setup', { ...profile })).status, 200);
  // this test's own sources (public rows are shared between tests, so reusing Robinhood would pollute the counts)
  const store = { id: await db.upsertSource({ type: 'app_store', external_id: `66${++srcN}00`, country: 'us', label: 'Skew App (App Store, US)', url: 'u', subject: 'Skew App' }) };
  const mention = { id: await db.upsertSource({ type: 'reddit_search', external_id: `skew${srcN}`, country: '', label: 'Reddit: complaints about “Skew”', url: 'u', subject: `Skew${srcN}` }) };
  await db.followSource(u.id, store.id, 'competitor');
  await db.followSource(u.id, mention.id, 'competitor');
  const mk = (tag, n, over) => ({ external_id: `${tag}${++srcN}-${n}`, quote: `I keep struggling with ${tag}-marker-${srcN}-${n} so much`, source: 'x', source_url: 'https://apps.apple.com/us/app/id1', rating: 1, pain_score: 0.95, content_hash: `${tag}h${srcN}-${n}`, published_at: Date.now(), fetched_at: Date.now(), ...over });
  // 150 App Store reviews scoring 0.95 vs 5 Reddit posts scoring 0.6 — raw score ranking would never reach Reddit
  await db.insertQuotes(store.id, Array.from({ length: 150 }, (_, i) => mk('rev', i, {})));
  await db.insertQuotes(mention.id, Array.from({ length: 5 }, (_, i) => mk('red', i, { source: 'Reddit r/stocks', rating: null, pain_score: 0.6, source_url: `https://www.reddit.com/r/stocks/comments/p${i}/x/` })));
  return u;
}

test('sampling gives Reddit a fair share even when every review outscores every Reddit post', async () => {
  const u = await skewedUser();
  const counts = [];
  for (let i = 0; i < 25; i++) {
    const sample = await db.sampleUserQuotes(u.id, { limit: 10 });
    assert.equal(sample.length, 10);
    counts.push(sample.filter((q) => q.source_type !== 'app_store').length);
  }
  assert.ok(counts.every((n) => n >= 3), `Reddit quotes per 10: ${counts}`); // all 5 Reddit posts are in the pool, so ~half of each draw
  assert.ok(counts.some((n) => n >= 4));
  // the pool is balanced, so over many draws every Reddit post shows up
  const seen = new Set();
  for (let i = 0; i < 40; i++) for (const q of await db.sampleUserQuotes(u.id, { limit: 10 })) if (q.source_type !== 'app_store') seen.add(q.id);
  assert.equal(seen.size, 5);
  // a Reddit-only sample is capped by what exists; an App Store-only sample is unaffected
  assert.equal((await db.sampleUserQuotes(u.id, { limit: 10, sourceType: 'reddit' })).length, 5);
  assert.ok((await db.sampleUserQuotes(u.id, { limit: 10, sourceType: 'app_store' })).every((q) => q.source_type === 'app_store'));
});

test('GET /api/pain-quotes?source_type= filters by family; "reddit" includes competitor-complaint searches', async () => {
  const u = await skewedUser();
  const all = (await u.get('/api/pain-quotes?limit=100')).json;
  assert.equal(all.filter((q) => q.source_type !== 'app_store').length, 0); // the raw top-100 by score is all reviews (why a mixed top-N hid Reddit)
  const reddit = (await u.get('/api/pain-quotes?limit=50&source_type=reddit')).json;
  assert.equal(reddit.length, 5);
  assert.ok(reddit.every((q) => q.source_type === 'reddit_search' && q.subreddit === 'stocks'));
  const store = (await u.get('/api/pain-quotes?limit=5&source_type=app_store')).json;
  assert.equal(store.length, 5);
  assert.ok(store.every((q) => q.source_type === 'app_store'));
  assert.equal((await u.get('/api/pain-quotes?source_type=twitter')).status, 400);
});

test('isolation: another user never sees my competitors or mention sources', async () => {
  const a = await user();
  const b = await user();
  await a.post('/api/setup', { ...profile, competitor_sources: apps(ROBINHOOD, COINBASE), competitor_mentions: true });
  await b.post('/api/setup', profile);
  const bf = (await b.get('/api/founder')).json;
  assert.deepEqual(bf.competitors, []);
  assert.equal(bf.competitor_mentions, false);
  assert.equal(bf.sources.length, 0);
  assert.equal((await a.get('/api/founder')).json.competitors.length, 2);
});
