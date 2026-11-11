const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Temp DB + env must be set before the app loads. No test in this file touches the network.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thevoice-collect-test-'));
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.NODE_ENV = 'test';
delete process.env.REDDIT_PROVIDER;
delete process.env.REDDIT_CLIENT_ID;
delete process.env.REDDIT_CLIENT_SECRET;
delete process.env.REDDIT_USER_AGENT;
delete process.env.CRON_SECRET;

const app = require('../server');
const db = require('../database');
const http = require('../collectors/http');
const pipeline = require('../collectors/pipeline');
const appstore = require('../collectors/appstore');
const reddit = require('../collectors/reddit');
const runner = require('../collectors');
const { parseAtom } = reddit;

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const fxJson = (name) => JSON.parse(fx(name));

// ---- fake network ----
let calls = [];
let sleeps = [];
let routes = [];
const res = (body, init = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });
// routes: [[substring, handler]] where handler returns a Response | body | throws
function fakeFetch(url, init) {
  calls.push({ url, init });
  for (const [match, handler] of routes) {
    if (url.includes(match)) {
      const out = typeof handler === 'function' ? handler(url, init) : handler;
      return Promise.resolve(out instanceof Response ? out : res(out));
    }
  }
  return Promise.resolve(new Response('not found', { status: 404 }));
}
const setRoutes = (r) => { routes = r; };
const callsTo = (s) => calls.filter((c) => c.url.includes(s)).length;

let server, base, ipCounter = 100;
before(async () => {
  await db.init();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  calls = []; sleeps = []; routes = [];
  http.reset();
  http.configure({ fetchImpl: fakeFetch, sleep: (ms) => { sleeps.push(ms); return new Promise((r) => setImmediate(r)); } });
  reddit.resetToken();
  delete process.env.REDDIT_PROVIDER;
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;
  delete process.env.REDDIT_USER_AGENT;
});

// ---- helpers ----
let emailN = 0;
function client() {
  const ip = `10.1.0.${++ipCounter}`;
  let cookie = '';
  const call = async (method, url, body, extra = {}) => {
    const r = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(cookie && { cookie }), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, json };
  };
  return { call, get: (u) => call('GET', u), post: (u, b, h) => call('POST', u, b ?? {}, h), del: (u) => call('DELETE', u) };
}
async function user() {
  const c = client();
  const r = await c.post('/api/auth/signup', { email: `c${++emailN}@example.com`, password: 'password123' });
  assert.equal(r.status, 201);
  c.id = r.json.id;
  return c;
}
const profile = { app_description: 'A trading journal', target_user: 'Day traders', voice_tone: 'Direct', competitor_url: 'Fake Trading App' };
const mkSource = (over = {}) =>
  db.upsertSource({ type: 'app_store', external_id: String(900000 + ++emailN), country: 'us', label: 'Test App', url: 'https://apps.apple.com/us/app/id1', ...over });
const rowFor = (n, over = {}) => ({
  external_id: `e${n}`, quote: `quote number ${n} that is long enough`, source: 'App Store review (★1)',
  source_url: 'https://apps.apple.com/us/app/id1?see-all=reviews', rating: 1, pain_score: 0.5 + n / 1000,
  content_hash: `h${n}-${Math.random()}`, published_at: Date.now(), fetched_at: Date.now(), ...over
});
async function seedFor(userId, count = 3, sourceOver) {
  const sid = await mkSource(sourceOver);
  await db.followSource(userId, sid, 'competitor');
  await db.insertQuotes(sid, Array.from({ length: count }, (_, i) => rowFor(i + 1)));
  const ids = (await db.getUserQuotes(userId, { sourceId: sid, limit: 50 })).map((q) => q.id);
  return { sid, ids };
}

// =====================================================================
// pipeline (pure)
// =====================================================================
test('pipeline.clean strips PII, links, handles and caps length', () => {
  const out = pipeline.clean('Email bob@x.com or call +1 (415) 555-0199, see https://spam.io/x and @bobby u/someone **bold** I can&#39;t log in');
  assert.doesNotMatch(out, /@|https?:|415|u\/someone|\*\*/);
  assert.match(out, /I can't log in/);
  const long = `${'This is a sentence about pain. '.repeat(40)}`;
  const cut = pipeline.clean(long);
  assert.ok(cut.length <= 600);
  assert.match(cut, /\.$/); // cut at a sentence boundary
});

test('pipeline: filters, spam, language, hashing and scoring order', () => {
  assert.equal(pipeline.isEnglish('I can never log in and the app keeps crashing when I try'), true);
  assert.equal(pipeline.isEnglish('Esta aplicación es muy mala y no funciona nada bien'), false);
  assert.equal(pipeline.isSpam('Use my code ABC to earn $500'), true);
  assert.equal(pipeline.isSpam('see https://a.com and https://b.com'), true);
  assert.equal(pipeline.isSpam('The app is broken'), false);
  assert.equal(pipeline.contentHash('Hello, World!'), pipeline.contentHash('hello   world'));
  const strong = pipeline.painScore({ text: 'I hate this, I keep losing money every time and I cannot cash out', rating: 1, kind: 'review' });
  const meh = pipeline.painScore({ text: 'The app is okay for what it does and works fine overall for me', rating: 3, kind: 'review' });
  assert.ok(strong > meh, `${strong} should beat ${meh}`);
  assert.ok(strong <= 1 && meh >= 0);
});

test('pipeline.process on App Store fixture: keeps pain, drops praise/spam/foreign/short/duplicates', () => {
  const page = fxJson('appstore-reviews-page1.json').feed.entry.filter((e) => e['im:rating']);
  const raw = page.map((e) => ({
    external_id: e.id.label, kind: 'review', rating: Number(e['im:rating'].label),
    title: e.title.label, body: e.content.label, published_at: Date.parse(e.updated.label), url: 'https://apps.apple.com/x'
  }));
  const { rows, fetched, kept } = pipeline.process(raw, { label: 'App' });
  assert.equal(fetched, 8);
  const ids = rows.map((r) => r.external_id).sort();
  assert.deepEqual(ids, ['1001', '1003', '1006']); // 1007 is a duplicate of 1003; 1002 praise; 1004 spam; 1005 Spanish; 1008 too short
  assert.ok(kept >= rows.length);
  const first = rows.find((r) => r.external_id === '1001');
  assert.doesNotMatch(first.quote, /john@example|415/); // PII stripped
  assert.equal(first.source, 'App Store review (★1)');
  assert.equal(first.rating, 1);
});

test('pipeline.process on Reddit fixture: drops NSFW, stickied, removed, daily threads, non-pain', () => {
  const raw = fxJson('reddit-arctic.json').data.map(reddit.mapPost);
  const { rows } = pipeline.process(raw, { label: 'r/testsub' });
  assert.deepEqual(rows.map((r) => r.external_id).sort(), ['t3_a1', 't3_a7']);
  assert.equal(rows[0].source, 'Reddit r/testsub');
  assert.equal(rows[0].rating, null);
  assert.match(rows[0].source_url, /^https:\/\/www\.reddit\.com\/r\/testsub\/comments\//);
});

// =====================================================================
// http.js
// =====================================================================
test('http: host allowlist and HTTPS only — blocked before any request', async () => {
  await assert.rejects(http.fetchJson('https://evil.example/x'), /not allowed/);
  await assert.rejects(http.fetchJson('http://itunes.apple.com/lookup'), /not allowed/);
  await assert.rejects(http.fetchJson('https://itunes.apple.com.evil.example/x'), /not allowed/);
  await assert.rejects(http.fetchJson('not a url'), /Invalid URL/);
  assert.equal(calls.length, 0);
});

test('http: 429 is retried (Retry-After honored), then succeeds', async () => {
  let n = 0;
  setRoutes([['itunes.apple.com/lookup', () => (++n === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }) : res({ ok: true }))]]);
  const r = await http.fetchJson('https://itunes.apple.com/lookup?id=1');
  assert.deepEqual(r.json, { ok: true });
  assert.equal(n, 2);
  assert.ok(sleeps.includes(2000), `sleeps: ${sleeps}`);
});

test('http: persistent 5xx exhausts retries; 404 is not retried; timeout/network are retryable errors', async () => {
  setRoutes([['itunes.apple.com/a', () => new Response('x', { status: 503 })], ['itunes.apple.com/b', () => new Response('x', { status: 404 })]]);
  await assert.rejects(http.fetchJson('https://itunes.apple.com/a'), (e) => e.retryable === true && e.status === 503);
  assert.equal(callsTo('/a'), 3);
  await assert.rejects(http.fetchJson('https://itunes.apple.com/b'), (e) => e.status === 404 && e.retryable === false);
  assert.equal(callsTo('/b'), 1);
  setRoutes([['itunes.apple.com/c', () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }]]);
  await assert.rejects(http.fetchJson('https://itunes.apple.com/c'), /timeout/);
});

test('http: Arctic Shift\'s "slow down" 422 is retried patiently; a 422 from anyone else is a hard error', async () => {
  let n = 0;
  setRoutes([['arctic-shift.photon-reddit.com/api/x', () => (++n < 3 ? new Response('{"error":"Timeout. Maybe slow down a bit"}', { status: 422 }) : res({ data: [1] }))]]);
  const r = await http.fetchJson('https://arctic-shift.photon-reddit.com/api/x');
  assert.deepEqual(r.json, { data: [1] });
  assert.equal(n, 3);
  assert.ok(sleeps.filter((ms) => ms >= 3000).length >= 2, `waits: ${sleeps}`);
  setRoutes([['itunes.apple.com/y', () => new Response('x', { status: 422 })]]);
  await assert.rejects(http.fetchJson('https://itunes.apple.com/y'), (e) => e.status === 422 && e.retryable === false);
  assert.equal(callsTo('itunes.apple.com/y'), 1);
});

test('http: oversized responses and invalid JSON are rejected', async () => {
  setRoutes([['itunes.apple.com/big', () => res('x'.repeat(5000))], ['itunes.apple.com/bad', () => res('not json')]]);
  await assert.rejects(http.fetchJson('https://itunes.apple.com/big', { maxBytes: 1000 }), /too large/);
  await assert.rejects(http.fetchJson('https://itunes.apple.com/bad'), /invalid JSON/);
});

test('http: errors never leak the URL query or headers', async () => {
  setRoutes([['itunes.apple.com/secret', () => new Response('x', { status: 403 })]]);
  await assert.rejects(http.fetchJson('https://itunes.apple.com/secret?token=SUPERSECRET', { headers: { authorization: 'Bearer SUPERSECRET' } }), (e) => !/SUPERSECRET/.test(e.message));
});

// =====================================================================
// App Store adapter
// =====================================================================
test('appstore.resolve: search, URL and id parsing; lookup re-validates', async () => {
  setRoutes([
    ['itunes.apple.com/search', () => res(fx('apple-search.json'))],
    ['itunes.apple.com/lookup?id=938003185', () => res(fx('apple-lookup.json'))],
    ['itunes.apple.com/lookup?id=111111111', () => res(fx('apple-lookup-empty.json'))]
  ]);
  const found = await appstore.resolve('fake trading');
  assert.equal(found.length, 2);
  assert.deepEqual(Object.keys(found[0]).sort(), ['brand', 'country', 'developer', 'external_id', 'label', 'name', 'subject', 'type', 'url']);
  assert.equal(found[0].brand, 'Fake Trading App');
  assert.match(found[0].url, /^https:\/\/apps\.apple\.com\/us\/app\/id938003185/);
  const viaUrl = await appstore.resolve('https://apps.apple.com/gb/app/fake/id938003185');
  assert.equal(viaUrl[0].country, 'gb');
  assert.equal((await appstore.lookup('111111111', 'us')), null);
  assert.equal(await appstore.lookup('abc', 'us'), null);
  assert.equal(await appstore.lookup('938003185', 'USA'), null);
});

test('appstore.collect: maps reviews, skips metadata entry, pages until empty', async () => {
  setRoutes([
    ['page=1/', () => res(fx('appstore-reviews-page1.json'))],
    ['page=2/', () => res(fx('appstore-reviews-page2.json'))],
    ['page=3/', () => res(fx('appstore-reviews-empty.json'))]
  ]);
  const { items, provider } = await appstore.collect({ external_id: '938003185', country: 'us' });
  assert.equal(provider, 'itunes');
  assert.equal(items.length, 9); // 8 from page 1 (metadata skipped) + 1 from page 2
  assert.ok(items.every((i) => i.kind === 'review' && i.url === 'https://apps.apple.com/us/app/id938003185?see-all=reviews'));
  assert.equal(items[0].rating, 1);
  assert.equal(callsTo('customerreviews'), 3);
});

test('appstore.collect: caps at 10 pages; early-stops with `since`', async () => {
  setRoutes([['customerreviews', () => res(fx('appstore-reviews-page1.json'))]]);
  await appstore.collect({ external_id: '938003185', country: 'us' });
  assert.equal(callsTo('customerreviews'), 10);
  calls = [];
  await appstore.collect({ external_id: '938003185', country: 'us' }, { since: Date.parse('2026-12-01') });
  assert.equal(callsTo('customerreviews'), 1); // page 1 is entirely older than the last run
});

test('appstore.collect: malformed payload is an error; 429 retried', async () => {
  setRoutes([['customerreviews', () => res(fx('appstore-malformed.json'))]]);
  await assert.rejects(appstore.collect({ external_id: '938003185', country: 'us' }), /unexpected format/);
  let n = 0;
  setRoutes([['page=1/', () => (++n === 1 ? new Response('x', { status: 429 }) : res(fx('appstore-reviews-page1.json')))], ['page=2/', () => res(fx('appstore-reviews-empty.json'))]]);
  const { items } = await appstore.collect({ external_id: '938003185', country: 'us' });
  assert.equal(items.length, 8);
});

// =====================================================================
// Reddit adapter (providers)
// =====================================================================
test('reddit.parseAtom: decodes escaped HTML, drops "submitted by" tail, never reads authors', () => {
  const items = parseAtom(fx('reddit-rss.xml'));
  assert.equal(items.length, 2);
  assert.equal(items[0].external_id, 't3_r1');
  assert.equal(items[0].title, 'Journal habits');
  assert.equal(items[0].body, "I never review my trades and I regret it & I'm tired of it");
  assert.doesNotMatch(JSON.stringify(items), /someone/);
});

test('reddit: auto chain = arctic → rss; falls back when arctic fails', async () => {
  assert.deepEqual(reddit.providerChain(), ['arctic', 'rss']);
  setRoutes([
    ['arctic-shift.photon-reddit.com', () => new Response('x', { status: 429 })],
    ['www.reddit.com/r/testsub/new/.rss', () => res(fx('reddit-rss.xml'))]
  ]);
  const { items, provider } = await reddit.collect({ external_id: 'testsub' }, {});
  assert.equal(provider, 'rss');
  assert.equal(items.length, 2);
});

test('reddit: uses arctic first and reads the flags', async () => {
  setRoutes([['arctic-shift.photon-reddit.com', () => res(fx('reddit-arctic.json'))]]);
  const { items, provider } = await reddit.collect({ external_id: 'testsub' }, { since: Date.parse('2026-11-01') });
  assert.equal(provider, 'arctic');
  assert.equal(items.length, 7);
  assert.match(calls[0].url, /after=2026-10-31/);
  assert.equal(items.find((i) => i.external_id === 't3_a2').flags.over_18, true);
  assert.equal(items.find((i) => i.external_id === 't3_a4').flags.removed, true);
  assert.equal(callsTo('reddit.com/r/'), 0); // no fallback needed
});

test('reddit: all providers failing raises one combined, secret-free error', async () => {
  setRoutes([['photon-reddit.com', () => new Response('x', { status: 500 })], ['www.reddit.com', () => new Response('x', { status: 403 })]]);
  await assert.rejects(reddit.collect({ external_id: 'testsub' }, {}), (e) => /Reddit unavailable/.test(e.message) && /arctic/.test(e.message) && /rss/.test(e.message));
});

test('reddit: off → no providers; official needs all three credentials and caches its token', async () => {
  process.env.REDDIT_PROVIDER = 'off';
  assert.equal(reddit.isEnabled(), false);
  assert.deepEqual(reddit.providerChain(), []);
  process.env.REDDIT_PROVIDER = 'official';
  assert.deepEqual(reddit.providerChain(), []); // not configured
  process.env.REDDIT_CLIENT_ID = 'id'; process.env.REDDIT_CLIENT_SECRET = 'secret'; process.env.REDDIT_USER_AGENT = 'test-agent/1.0';
  assert.deepEqual(reddit.providerChain(), ['official']);
  setRoutes([
    ['api/v1/access_token', () => res(fx('reddit-token.json'))],
    ['oauth.reddit.com/r/testsub/new', () => res(fx('reddit-official-listing.json'), { headers: { 'x-ratelimit-remaining': '0' } })],
    ['oauth.reddit.com/r/testsub/top', () => res(fx('reddit-official-listing.json'))]
  ]);
  const a = await reddit.collect({ external_id: 'testsub' }, {});
  assert.equal(a.provider, 'official');
  assert.equal(a.items.length, 1);
  assert.equal(callsTo('/top'), 0); // rate-limit budget exhausted → second listing skipped
  await reddit.collect({ external_id: 'testsub' }, {});
  assert.equal(callsTo('api/v1/access_token'), 1); // token cached
  const authHeader = calls.find((c) => c.url.includes('oauth.reddit.com')).init.headers.authorization;
  assert.equal(authHeader, 'bearer tok_fixture');
  process.env.REDDIT_PROVIDER = 'auto';
  assert.deepEqual(reddit.providerChain(), ['official', 'arctic', 'rss']);
});

test('reddit.resolve: exists / missing / unverifiable', async () => {
  setRoutes([['r/real/new/.rss', () => res(fx('reddit-rss.xml'))], ['r/ghost/new/.rss', () => new Response('x', { status: 404 })], ['r/blocked/new/.rss', () => new Response('x', { status: 429 })]]);
  assert.equal(await reddit.resolve('real'), true);
  assert.equal(await reddit.resolve('ghost'), false);
  assert.equal(await reddit.resolve('blocked'), null);
  assert.equal(await reddit.resolve('../etc'), false);
});

// =====================================================================
// runner
// =====================================================================
const itunesRoutes = () => [
  ['page=1/', () => res(fx('appstore-reviews-page1.json'))],
  ['page=2/', () => res(fx('appstore-reviews-empty.json'))]
];

test('runner: idempotent — second run inserts 0 and keeps counts stable', async () => {
  setRoutes(itunesRoutes());
  const sid = await mkSource();
  const src = await db.getSource(sid);
  const a = await runner.collectSource(src, { trigger: 'cli' });
  assert.equal(a.status, 'ok');
  assert.equal(a.inserted, 3);
  const b = await runner.collectSource(await db.getSource(sid), { trigger: 'cli' });
  assert.equal(b.status, 'ok');
  assert.equal(b.inserted, 0);
  const n = await db.client.execute({ sql: 'SELECT COUNT(*) n FROM pain_quotes WHERE source_id = ?', args: [sid] });
  assert.equal(Number(n.rows[0].n), 3);
  const after = await db.getSource(sid);
  assert.equal(after.last_status, 'ok');
  assert.equal(after.consecutive_failures, 0);
  assert.equal(after.locked_until, 0);
  assert.ok(after.next_collect_at > Date.now() + 5 * 3600000); // ~6h cadence
  const runs = await db.client.execute({ sql: 'SELECT status, fetched, kept, inserted FROM collection_runs WHERE source_id = ? ORDER BY id', args: [sid] });
  assert.equal(runs.rows.length, 2);
  assert.equal(Number(runs.rows[0].inserted), 3);
});

test('runner: one failing source never stops the others; error + backoff recorded', async () => {
  const good = await mkSource({ external_id: '777000001' });
  const bad = await mkSource({ external_id: '777000002' });
  setRoutes([['id=777000002', () => new Response('x', { status: 500 })], ...itunesRoutes()]);
  const out = await runner.runDue({ trigger: 'cli', ids: [bad, good], budgetMs: 60000 });
  const byId = Object.fromEntries(out.results.map((r) => [r.source_id, r]));
  assert.equal(byId[good].status, 'ok');
  assert.equal(byId[bad].status, 'error');
  const s = await db.getSource(bad);
  assert.equal(s.last_status, 'error');
  assert.equal(s.consecutive_failures, 1);
  assert.match(s.last_error, /500/);
  assert.ok(s.next_collect_at > Date.now() + 25 * 60000);
  assert.equal(s.locked_until, 0);
  assert.equal(s.last_collected_at, null);
});

test('runner: backoff doubles to a 24h cap; success resets failures', async () => {
  assert.equal(runner.backoffMs(1), 30 * 60000);
  assert.equal(runner.backoffMs(2), 60 * 60000);
  assert.equal(runner.backoffMs(3), 120 * 60000);
  assert.equal(runner.backoffMs(20), 24 * 3600000);
  const sid = await mkSource();
  setRoutes([['customerreviews', () => new Response('x', { status: 500 })]]);
  await runner.collectSource(await db.getSource(sid));
  await runner.collectSource(await db.getSource(sid));
  assert.equal((await db.getSource(sid)).consecutive_failures, 2);
  setRoutes(itunesRoutes());
  await runner.collectSource(await db.getSource(sid));
  const ok = await db.getSource(sid);
  assert.equal(ok.consecutive_failures, 0);
  assert.equal(ok.last_error, null);
});

test('runner: lease — concurrent collection of one source runs once', async () => {
  setRoutes(itunesRoutes());
  const sid = await mkSource();
  const src = await db.getSource(sid);
  const [a, b] = await Promise.all([runner.collectSource(src), runner.collectSource(src)]);
  assert.deepEqual([a.status, b.status].sort(), ['ok', 'skipped']);
  assert.equal(await db.claimSource(sid, Date.now(), 1000), true);
  assert.equal(await db.claimSource(sid, Date.now(), 1000), false); // lease held
});

test('runner: due selection honors schedule and budget stops new sources', async () => {
  setRoutes(itunesRoutes());
  const sid = await mkSource();
  const due = await db.listDueSources({});
  assert.ok(due.some((s) => s.id === sid)); // never collected → due
  const blocked = await runner.runDue({ trigger: 'manual', budgetMs: 0, ids: [sid] });
  assert.equal(blocked.collected, 0);
  assert.equal(blocked.skipped_for_budget, 1);
  await runner.collectSource(await db.getSource(sid));
  assert.ok(!(await db.listDueSources({})).some((s) => s.id === sid)); // scheduled for +6h
  const forced = await db.listDueSources({ minIntervalMs: 1000, now: Date.now() + 2000 });
  assert.ok(forced.some((s) => s.id === sid)); // manual interval elapsed
});

test('runner: disabled source type is reported, not counted as a failure', async () => {
  process.env.REDDIT_PROVIDER = 'off';
  const sid = await db.upsertSource({ type: 'reddit', external_id: 'testsub', country: '', label: 'r/testsub', url: 'https://www.reddit.com/r/testsub/' });
  const r = await runner.collectSource(await db.getSource(sid));
  assert.equal(r.status, 'disabled');
  const s = await db.getSource(sid);
  assert.equal(s.last_status, 'disabled');
  assert.equal(s.consecutive_failures, 0);
  assert.equal(calls.length, 0);
});

test('runner: reddit end-to-end through the pipeline (arctic fixture)', async () => {
  setRoutes([['photon-reddit.com', () => res(fx('reddit-arctic.json'))]]);
  const sid = await db.upsertSource({ type: 'reddit', external_id: 'e2esub', country: '', label: 'r/e2esub', url: 'https://www.reddit.com/r/e2esub/' });
  const r = await runner.collectSource(await db.getSource(sid));
  assert.equal(r.status, 'ok');
  assert.equal(r.provider, 'arctic');
  assert.equal(r.inserted, 2);
});

test('retention: old rows, per-source cap, run history, orphan sources', async () => {
  const sid = await mkSource();
  const old = Date.now() - 200 * 86400000;
  await db.insertQuotes(sid, [rowFor(1, { published_at: old, fetched_at: old }), rowFor(2), rowFor(3, { pain_score: 0.9 }), rowFor(4, { pain_score: 0.1 })]);
  const prevCap = db.RETENTION.maxPerSource;
  db.RETENTION.maxPerSource = 2;
  try { await db.runRetention(); } finally { db.RETENTION.maxPerSource = prevCap; }
  const left = (await db.client.execute({ sql: 'SELECT pain_score FROM pain_quotes WHERE source_id = ? ORDER BY pain_score DESC', args: [sid] })).rows.map((r) => Number(r.pain_score));
  assert.equal(left.length, 2);
  assert.equal(left[0], 0.9); // the lowest-scoring and the >180-day row are gone
  // orphan source (unfollowed, older than 7 days) is removed along with its quotes
  const orphan = await mkSource();
  await db.insertQuotes(orphan, [rowFor(9)]);
  await db.client.execute({ sql: "UPDATE sources SET created_at = datetime('now', '-30 days') WHERE id = ?", args: [orphan] });
  await db.runRetention();
  assert.equal(await db.getSource(orphan), null);
  assert.equal(Number((await db.client.execute({ sql: 'SELECT COUNT(*) n FROM pain_quotes WHERE source_id = ?', args: [orphan] })).rows[0].n), 0);
  // followed sources are kept even when old
  const u = await user();
  const kept = await mkSource();
  await db.followSource(u.id, kept, 'community');
  await db.client.execute({ sql: "UPDATE sources SET created_at = datetime('now', '-30 days') WHERE id = ?", args: [kept] });
  await db.runRetention();
  assert.ok(await db.getSource(kept));
});

// =====================================================================
// API: sources, setup, collect, cron, quotes
// =====================================================================
test('cron endpoint: 503 when unset, 401 wrong/missing, 200 with the secret; no cookie works', async () => {
  const c = client();
  assert.equal((await c.get('/api/cron/collect')).status, 503);
  process.env.CRON_SECRET = 'test-secret';
  try {
    assert.equal((await c.get('/api/cron/collect')).status, 401);
    assert.equal((await c.call('GET', '/api/cron/collect', undefined, { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await c.call('GET', '/api/cron/collect', undefined, { authorization: 'Basic test-secret' })).status, 401);
    const ok = await c.call('GET', '/api/cron/collect', undefined, { authorization: 'Bearer test-secret' });
    assert.equal(ok.status, 200);
    assert.ok('results' in ok.json);
    const u = await user(); // a logged-in user's session is NOT enough
    assert.equal((await u.get('/api/cron/collect')).status, 401);
  } finally { delete process.env.CRON_SECRET; }
});

test('GET /api/sources/resolve: results, validation, upstream failure → 502', async () => {
  const u = await user();
  setRoutes([['itunes.apple.com/search', () => res(fx('apple-search.json'))]]);
  const r = await u.get('/api/sources/resolve?q=fake');
  assert.equal(r.status, 200);
  assert.equal(r.json[0].external_id, '938003185');
  assert.equal((await u.get('/api/sources/resolve?q=a')).status, 400);
  assert.equal((await client().get('/api/sources/resolve?q=fake')).status, 401);
  setRoutes([['itunes.apple.com/search', () => new Response('x', { status: 503 })]]);
  assert.equal((await u.get('/api/sources/resolve?q=fake')).status, 502);
});

test('POST /api/setup links the competitor + communities; server rebuilds label/url', async () => {
  const u = await user();
  setRoutes([['itunes.apple.com/lookup?id=938003185', () => res(fx('apple-lookup.json'))]]);
  const r = await u.post('/api/setup', {
    ...profile, niche: 'trading psychology',
    competitor_source: { type: 'app_store', external_id: '938003185', country: 'us', label: 'HACKED', url: 'https://evil.example' },
    subreddits: ['Daytrading', 'r/Trading', 'daytrading']
  });
  assert.equal(r.status, 200);
  const byRole = (role) => r.json.sources.filter((s) => s.role === role);
  assert.equal(byRole('competitor').length, 1);
  assert.equal(byRole('competitor')[0].label, 'Fake Trading App (App Store, US)');
  assert.match(byRole('competitor')[0].url, /^https:\/\/apps\.apple\.com\//);
  assert.deepEqual(byRole('community').map((s) => s.label).sort(), ['r/Daytrading', 'r/Trading']);
  assert.equal(r.json.niche, 'trading psychology');
  // re-saving the profile without sources keeps the links; empty subreddits clears the communities
  assert.equal((await u.post('/api/setup', profile)).json.sources.length, 3);
  assert.equal((await u.post('/api/setup', { ...profile, subreddits: [] })).json.sources.length, 1);
  assert.equal((await u.get('/api/founder')).json.sources.length, 1);
});

test('POST /api/setup: unknown app → 400; Apple down → 502 and nothing is saved; reddit off → 400', async () => {
  const u = await user();
  setRoutes([['itunes.apple.com/lookup', () => res(fx('apple-lookup-empty.json'))]]);
  const bad = await u.post('/api/setup', { ...profile, competitor_source: { type: 'app_store', external_id: '111111111' } });
  assert.equal(bad.status, 400);
  setRoutes([['itunes.apple.com/lookup', () => new Response('x', { status: 503 })]]);
  const down = await u.post('/api/setup', { ...profile, competitor_source: { type: 'app_store', external_id: '938003185' } });
  assert.equal(down.status, 502);
  assert.equal((await u.get('/api/founder')).status, 404); // no partial save
  process.env.REDDIT_PROVIDER = 'off';
  assert.equal((await u.post('/api/setup', { ...profile, subreddits: ['Daytrading'] })).status, 400);
  assert.equal((await u.post('/api/setup', { ...profile, competitor_source: { type: 'app_store', external_id: 'abc' } })).status, 400);
});

test('sources API: follow/unfollow subreddits, max 8, status listing', async () => {
  const u = await user();
  setRoutes([['/new/.rss', (url) => (url.includes('/r/ghostsub/') ? new Response('x', { status: 404 }) : res(fx('reddit-rss.xml')))]]);
  const first = await u.post('/api/sources', { type: 'reddit', external_id: 'Trading' });
  assert.equal(first.status, 201);
  assert.equal(first.json.label, 'r/Trading');
  assert.equal(first.json.role, 'community');
  assert.equal((await u.post('/api/sources', { type: 'reddit', external_id: 'Trading' })).status, 201); // idempotent
  assert.equal((await u.post('/api/sources', { type: 'reddit', external_id: 'ghostsub' })).status, 400);
  assert.equal((await u.post('/api/sources', { type: 'reddit', external_id: '../x' })).status, 400);
  for (const n of ['subone', 'subtwo', 'subthree', 'subfour', 'subfive', 'subsix', 'subseven']) assert.equal((await u.post('/api/sources', { type: 'reddit', external_id: n })).status, 201);
  assert.equal((await u.post('/api/sources', { type: 'reddit', external_id: 'suberr' })).status, 400); // 9th community (max 8)
  const list = await u.get('/api/sources');
  assert.equal(list.json.sources.length, 8);
  assert.equal(list.json.reddit.enabled, true);
  const id = list.json.sources[0].id;
  assert.equal((await u.del(`/api/sources/${id}`)).status, 200);
  assert.equal((await u.del(`/api/sources/${id}`)).status, 404);
  assert.equal((await u.del('/api/sources/abc')).status, 404);
});

test('POST /api/collect: only the caller\'s sources; rate limited to 6/hour', async () => {
  const a = await user();
  const b = await user();
  setRoutes(itunesRoutes());
  const mine = await mkSource();
  const theirs = await mkSource();
  await db.followSource(a.id, mine, 'competitor');
  await db.followSource(b.id, theirs, 'competitor');
  const r = await a.post('/api/collect');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.map((x) => x.source_id), [mine]);
  assert.equal((await db.getSource(theirs)).last_status, null); // B's source untouched
  assert.equal((await a.post('/api/collect')).json.collected, 0); // just collected → not due again
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await a.post('/api/collect')).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 429]); // 2 earlier calls + 4 more = 6 allowed, the 7th is limited
  assert.equal((await client().post('/api/collect')).status, 401);
});

test('GET /api/pain-quotes only returns quotes from followed sources (shared sources, private follows)', async () => {
  const a = await user();
  const b = await user();
  const shared = await mkSource();
  await db.insertQuotes(shared, [rowFor(1), rowFor(2)]);
  await db.followSource(a.id, shared, 'competitor');
  await db.followSource(b.id, shared, 'competitor');
  const aOnly = await mkSource();
  await db.insertQuotes(aOnly, [rowFor(3)]);
  await db.followSource(a.id, aOnly, 'community');
  const unfollowed = await mkSource();
  await db.insertQuotes(unfollowed, [rowFor(4)]);

  const aq = (await a.get('/api/pain-quotes')).json;
  const bq = (await b.get('/api/pain-quotes')).json;
  assert.equal(aq.length, 3);
  assert.equal(bq.length, 2);
  assert.ok(aq[0].pain_score >= aq[aq.length - 1].pain_score); // best first
  assert.deepEqual(Object.keys(aq[0]).sort(), ['app', 'id', 'location', 'matched_keywords', 'mentions_location', 'pain_score', 'published_at', 'quote', 'rating', 'source', 'source_id', 'source_label', 'source_type', 'source_url', 'subreddit']);
  assert.deepEqual((await b.get(`/api/pain-quotes?source_id=${aOnly}`)).json, []); // not followed → empty, no error
  assert.equal((await a.get(`/api/pain-quotes?source_id=${aOnly}`)).json.length, 1);
  assert.equal((await a.get('/api/pain-quotes?limit=1&offset=1')).json.length, 1);
  assert.equal((await a.get('/api/pain-quotes?limit=0')).status, 400);

  // B unfollowing does not affect A; B cannot unfollow A's private source
  assert.equal((await b.del(`/api/sources/${shared}`)).status, 200);
  assert.equal((await b.del(`/api/sources/${aOnly}`)).status, 404);
  assert.equal((await a.get('/api/pain-quotes')).json.length, 3);
  assert.equal((await b.get('/api/pain-quotes')).json.length, 0);
});

test('content must cite followed quotes; snapshot survives quote deletion', async () => {
  const a = await user();
  const b = await user();
  const { ids } = await seedFor(a.id, 2);
  const hooks = ['h1', 'h2', 'h3', 'h4', 'h5'];
  assert.equal((await b.post('/api/content', { hooks, script: 's', inspiration_quote_ids: [ids[0]] })).status, 400); // B doesn't follow it
  assert.equal((await a.post('/api/content', { hooks, script: 's', inspiration_quote_ids: [999999] })).status, 400);
  const made = await a.post('/api/content', { hooks, script: 'my script', inspiration_quote_ids: [ids[0], ids[0], ids[1]] });
  assert.equal(made.status, 201);
  assert.equal(made.json.inspiration_quotes.length, 2); // de-duplicated
  assert.ok(made.json.inspiration_quotes[0].quote && made.json.inspiration_quotes[0].source_url);
  await db.client.execute('DELETE FROM pain_quotes WHERE id IN (' + ids.join(',') + ')');
  const again = (await a.get('/api/content')).json[0];
  assert.equal(again.inspiration_quotes.length, 2); // history intact after pruning
  assert.match(again.inspiration_quotes[0].quote, /quote number/);
});

test('no hardcoded quote data leaked into runtime code', () => {
  const runtime = ['server.js', 'database.js', 'auth.js', 'validation.js', 'collectors/index.js', 'collectors/pipeline.js', 'collectors/appstore.js', 'collectors/reddit.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  assert.doesNotMatch(runtime, /SEED_QUOTES|I keep breaking my own trading rules|revenge trade after losses/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'scraper.js')), false);
});
