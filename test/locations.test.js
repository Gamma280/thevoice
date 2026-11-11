const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Temp DB + env first. No network in this file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thevoice-loc-test-'));
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.NODE_ENV = 'test';
for (const k of ['REDDIT_PROVIDER', 'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT', 'CRON_SECRET']) delete process.env[k];

const app = require('../server');
const db = require('../database');
const http = require('../collectors/http');
const reddit = require('../collectors/reddit');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

// ---- fake network ----
let calls = [];
let routes = [];
const res = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });
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
const callsTo = (s) => calls.filter((c) => c.url.includes(s)).length;
const LOOKUP_OK = () => res(fx('apple-lookup.json'));
const LOOKUP_NONE = () => res(fx('apple-lookup-empty.json'));

let server, base, ipN = 0, emailN = 0;
before(async () => {
  await db.init();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  calls = []; routes = [];
  http.reset();
  http.configure({ fetchImpl: fakeFetch, sleep: () => new Promise((r) => setImmediate(r)) });
  reddit.resetToken();
  for (const k of ['REDDIT_PROVIDER', 'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT']) delete process.env[k];
});

function client() {
  const ip = `10.2.0.${++ipN}`;
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
  return { call, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), del: (u) => call('DELETE', u) };
}
async function user() {
  const c = client();
  const r = await c.post('/api/auth/signup', { email: `l${++emailN}@example.com`, password: 'password123' });
  assert.equal(r.status, 201);
  c.id = r.json.id;
  return c;
}
const profile = { app_description: 'A trading journal', target_user: 'Day traders', voice_tone: 'Direct', competitor_url: 'Fake Trading App' };
const app1 = { type: 'app_store', external_id: '938003185' };
const row = (n, over = {}) => ({
  external_id: `e${n}`, quote: `quote number ${n} that is long enough`, source: 'App Store review (★1)',
  source_url: 'https://apps.apple.com/us/app/id1?see-all=reviews', rating: 1, pain_score: 0.5 + n / 1000,
  content_hash: `h${n}-${Math.random()}`, published_at: Date.now(), fetched_at: Date.now(), ...over
});
const srcByLabel = (json, re) => json.sources.find((s) => re.test(s.label));

// =====================================================================
test('migrations 1-6 ran exactly once; location tables/columns exist', async () => {
  const versions = (await db.client.execute('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => Number(r.version));
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6]);
  const cols = (await db.client.execute('PRAGMA table_info(founder_sources)')).rows.map((r) => r.name);
  assert.ok(cols.includes('location_id'));
  const fcols = (await db.client.execute('PRAGMA table_info(founders)')).rows.map((r) => r.name);
  assert.ok(fcols.includes('location_mode'));
  await db.client.execute('SELECT 1 FROM founder_locations');
});

test('GET /api/countries is a protected list with the english flag', async () => {
  assert.equal((await client().get('/api/countries')).status, 401);
  const u = await user();
  const r = await u.get('/api/countries');
  assert.equal(r.status, 200);
  assert.ok(r.json.length >= 30);
  assert.equal(r.json.find((c) => c.code === 'in').english, true);
  assert.equal(r.json.find((c) => c.code === 'de').english, false);
});

// ---------------------------------------------------------------- setup
test('setup with 2 locations: per-country competitor sources linked to locations; unavailable storefront → warning', async () => {
  const u = await user();
  routes = [['lookup?id=938003185&country=in', LOOKUP_OK], ['lookup?id=938003185&country=gb', LOOKUP_NONE]];
  const r = await u.post('/api/setup', {
    ...profile, competitor_source: app1,
    locations: [{ country: 'IN', region: ' Mumbai ' }, { country: 'gb' }]
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.locations.map((l) => [l.country, l.region]), [['in', 'Mumbai'], ['gb', '']]);
  assert.equal(r.json.location_mode, 'strict');
  const comp = r.json.sources.filter((s) => s.role === 'competitor');
  assert.equal(comp.length, 1);
  assert.match(comp[0].label, /\(App Store, IN\)/);
  assert.deepEqual(comp[0].location, { id: r.json.locations[0].id, country: 'in', region: '' }); // app reviews are country-level
  assert.equal(r.json.warnings.length, 1);
  assert.equal(r.json.warnings[0].country, 'gb');
  assert.match(r.json.warnings[0].message, /United Kingdom/);
  const founder = (await u.get('/api/founder')).json;
  assert.equal(founder.locations.length, 2);
});

test('setup with locations in two available storefronts creates two sources', async () => {
  const u = await user();
  routes = [['lookup?id=938003185&country=us', LOOKUP_OK], ['lookup?id=938003185&country=gb', LOOKUP_OK]];
  const r = await u.post('/api/setup', { ...profile, competitor_source: app1, locations: [{ country: 'us' }, { country: 'gb' }] });
  assert.equal(r.json.sources.filter((s) => s.role === 'competitor').length, 2);
  assert.deepEqual(r.json.sources.map((s) => s.country).sort(), ['gb', 'us']);
  assert.equal(r.json.warnings.length, 0);
});

test('setup: app unavailable in every country → 400; Apple down → 502; neither saves anything', async () => {
  const u = await user();
  routes = [['itunes.apple.com/lookup', LOOKUP_NONE]];
  assert.equal((await u.post('/api/setup', { ...profile, competitor_source: app1, locations: [{ country: 'in' }] })).status, 400);
  routes = [['itunes.apple.com/lookup', () => new Response('x', { status: 503 })]];
  assert.equal((await u.post('/api/setup', { ...profile, competitor_source: app1, locations: [{ country: 'in' }] })).status, 502);
  assert.equal((await u.get('/api/founder')).status, 404);
  assert.deepEqual(await db.listLocations(u.id), []);
});

test('re-saving locations re-links the existing competitor app to the new countries', async () => {
  const u = await user();
  routes = [['lookup?id=938003185', LOOKUP_OK]];
  await u.post('/api/setup', { ...profile, competitor_source: app1, locations: [{ country: 'us' }] });
  calls = [];
  const r = await u.post('/api/setup', { ...profile, locations: [{ country: 'us' }, { country: 'in' }] }); // no competitor_source this time
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.sources.filter((s) => s.role === 'competitor').map((s) => s.country).sort(), ['in', 'us']);
  assert.equal(callsTo('country=in'), 1);
});

test('setup validation: >3 locations, unknown country, duplicates, communities tied to unknown locations', async () => {
  const u = await user();
  routes = [['itunes.apple.com/lookup', LOOKUP_OK]];
  const four = ['us', 'gb', 'in', 'ca'].map((country) => ({ country }));
  assert.equal((await u.post('/api/setup', { ...profile, locations: four })).status, 400);
  assert.equal((await u.post('/api/setup', { ...profile, locations: [{ country: 'zz' }] })).status, 400);
  assert.equal((await u.post('/api/setup', { ...profile, locations: [] })).status, 400);
  assert.equal((await u.post('/api/setup', { ...profile, locations: [{ country: 'us' }], communities: [{ name: 'london', country: 'gb' }] })).status, 400);
  assert.equal((await u.post('/api/setup', { ...profile, communities: [{ name: 'london', region: 'Soho' }] })).status, 400);
  const dup = await u.post('/api/setup', { ...profile, locations: [{ country: 'in', region: 'Mumbai' }, { country: 'IN', region: 'mumbai' }] });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.locations.length, 1); // case-insensitive de-dupe
  // communities tied to an existing location, without resubmitting locations
  const ok = await u.post('/api/setup', { ...profile, communities: [{ name: 'mumbai', country: 'in', region: 'Mumbai' }, { name: 'Daytrading' }] });
  assert.equal(ok.status, 200);
  assert.deepEqual(srcByLabel(ok.json, /r\/mumbai/).location, { id: dup.json.locations[0].id, country: 'in', region: 'Mumbai' });
  assert.equal(srcByLabel(ok.json, /r\/Daytrading/).location, null);
  const tooMany = Array.from({ length: 9 }, (_, i) => ({ name: `sub${i}extra` }));
  assert.equal((await u.post('/api/setup', { ...profile, communities: tooMany })).status, 400);
});

// ---------------------------------------------------------------- strict vs all
async function strictFixture() {
  const u = await user();
  routes = [['lookup?id=938003185&country=in', LOOKUP_OK]];
  const r = await u.post('/api/setup', { ...profile, competitor_source: app1, locations: [{ country: 'in', region: 'Mumbai' }], communities: [{ name: 'mumbai', country: 'in', region: 'Mumbai' }, { name: 'Daytrading' }] });
  assert.equal(r.status, 200);
  const local = srcByLabel(r.json, /App Store, IN/);
  const localSub = srcByLabel(r.json, /r\/mumbai/);
  const globalSub = srcByLabel(r.json, /r\/Daytrading/);
  await db.insertQuotes(local.id, [row(1)]);
  await db.insertQuotes(localSub.id, [row(2, { source: 'Reddit r/mumbai', quote: 'The Mumbai local trains make me lose my mind every single day' })]);
  await db.insertQuotes(globalSub.id, [row(3, { source: 'Reddit r/Daytrading', quote: 'I always revenge trade after a loss and hate it' })]);
  return { u, local, localSub, globalSub };
}

test('strict mode hides non-location quotes; "all" shows everything; no locations = unchanged', async () => {
  const { u, local, localSub, globalSub } = await strictFixture();
  const sourceIds = async () => (await u.get('/api/pain-quotes')).json.map((q) => q.source_id).sort((a, b) => a - b);
  assert.deepEqual(await sourceIds(), [local.id, localSub.id].sort((a, b) => a - b)); // global sub hidden
  assert.equal((await u.post('/api/location-mode', { location_mode: 'all' })).status, 200);
  assert.deepEqual(await sourceIds(), [local.id, localSub.id, globalSub.id].sort((a, b) => a - b));
  assert.equal((await u.get('/api/sources')).json.location_mode, 'all');
  await u.post('/api/location-mode', { location_mode: 'strict' });
  assert.equal((await u.get('/api/pain-quotes')).json.length, 2);

  // a founder with no locations sees everything they follow, regardless of mode
  const plain = await user();
  await plain.post('/api/setup', profile);
  const sid = await db.upsertSource({ type: 'reddit', external_id: 'plainsub', country: '', label: 'r/plainsub', url: 'u' });
  await db.followSource(plain.id, sid, 'community');
  await db.insertQuotes(sid, [row(9)]);
  assert.equal((await plain.get('/api/pain-quotes')).json.length, 1);
});

test('citing a hidden (non-location) quote in strict mode is rejected; allowed after switching to "all"', async () => {
  const { u, globalSub } = await strictFixture();
  const hiddenId = (await db.getUserQuotes(u.id, { sourceId: globalSub.id })).length; // 0 while hidden
  assert.equal(hiddenId, 0);
  await u.post('/api/location-mode', { location_mode: 'all' });
  const gid = (await db.getUserQuotes(u.id, { sourceId: globalSub.id }))[0].id;
  await u.post('/api/location-mode', { location_mode: 'strict' });
  const hooks = ['a', 'b', 'c', 'd', 'e'];
  assert.equal((await u.post('/api/content', { hooks, script: 's', inspiration_quote_ids: [gid] })).status, 400);
  await u.post('/api/location-mode', { location_mode: 'all' });
  assert.equal((await u.post('/api/content', { hooks, script: 's', inspiration_quote_ids: [gid] })).status, 201);
});

test('quotes carry their location (country-level for App Store) and ?location_id= filters', async () => {
  const { u, local, localSub } = await strictFixture();
  const quotes = (await u.get('/api/pain-quotes')).json;
  const appQ = quotes.find((q) => q.source_id === local.id);
  const subQ = quotes.find((q) => q.source_id === localSub.id);
  assert.deepEqual(appQ.location, { id: appQ.location.id, country: 'in', region: '' });
  assert.deepEqual(subQ.location, { id: subQ.location.id, country: 'in', region: 'Mumbai' });
  assert.equal((await u.get(`/api/pain-quotes?location_id=${appQ.location.id}`)).json.length, 2);
  assert.equal((await u.get('/api/pain-quotes?location_id=999999')).json.length, 0);
});

// ---------------------------------------------------------------- mentions_location
test('mentions_location flags + ranks quotes naming the founder\'s place; % and _ are literal', async () => {
  const { u, local, localSub } = await strictFixture();
  const q = (await u.get('/api/pain-quotes')).json;
  assert.equal(q.find((x) => x.source_id === localSub.id).mentions_location, true); // text names Mumbai
  assert.equal(q.find((x) => x.source_id === local.id).mentions_location, false);
  // sampling prefers place-mentioning quotes even when their score is lower
  await db.client.execute({ sql: 'UPDATE pain_quotes SET pain_score = 0.01 WHERE source_id = ?', args: [localSub.id] });
  for (let i = 0; i < 5; i++) {
    const [only] = await db.sampleUserQuotes(u.id, { limit: 1, top: 1 });
    assert.equal(only.source_id, localSub.id);
  }
  // wildcard characters in a region are matched literally (instr, not LIKE)
  const w = await user();
  await w.post('/api/setup', { ...profile, locations: [{ country: 'us', region: '100%' }, { country: 'gb', region: 'a_b' }] });
  const sid = await db.upsertSource({ type: 'app_store', external_id: String(800000 + ++emailN), country: 'us', label: 'W', url: 'u' });
  const locs = await db.listLocations(w.id);
  await db.followSource(w.id, sid, 'competitor', locs[0].id);
  await db.insertQuotes(sid, [row(21, { quote: 'I lost 1000 dollars and axb is on my mind' }), row(22, { quote: 'Down 100% on this trade, awful experience for me' })]);
  const got = Object.fromEntries((await w.get('/api/pain-quotes')).json.map((x) => [x.external_id ?? x.quote.slice(0, 6), x.mentions_location]));
  assert.equal(got['I lost'], false);
  assert.equal(got['Down 1'], true);
});

// ---------------------------------------------------------------- removing locations, isolation
test('removing a location drops its links but keeps shared source rows and other users\' follows', async () => {
  const a = await user();
  const b = await user();
  routes = [['lookup?id=938003185', LOOKUP_OK]];
  await a.post('/api/setup', { ...profile, competitor_source: app1, locations: [{ country: 'us' }, { country: 'in' }] });
  await b.post('/api/setup', { ...profile, competitor_source: app1, locations: [{ country: 'in' }] });
  const aIn = (await a.get('/api/sources')).json.sources.find((s) => s.country === 'in');
  const after = await a.post('/api/setup', { ...profile, locations: [{ country: 'us' }] });
  assert.deepEqual(after.json.sources.filter((s) => s.role === 'competitor').map((s) => s.country), ['us']);
  assert.ok(await db.getSource(aIn.id)); // shared source row stays
  assert.equal((await b.get('/api/sources')).json.sources.some((s) => s.id === aIn.id), true); // B still follows it
  assert.equal((await b.get('/api/founder')).json.locations.length, 1);
});

test('isolation: locations and mode are per user', async () => {
  const { u: a } = await strictFixture();
  const b = await user();
  assert.equal((await b.get('/api/founder')).status, 404);
  assert.equal((await b.post('/api/location-mode', { location_mode: 'all' })).status, 404); // no profile yet
  await b.post('/api/setup', profile);
  assert.deepEqual((await b.get('/api/founder')).json.locations, []);
  assert.equal((await b.post('/api/location-mode', { location_mode: 'all' })).status, 200);
  assert.equal((await a.get('/api/sources')).json.location_mode, 'strict'); // A unaffected
  assert.equal((await a.post('/api/location-mode', { location_mode: 'nope' })).status, 400);
  assert.equal((await client().post('/api/location-mode', { location_mode: 'all' })).status, 401);
});

// ---------------------------------------------------------------- resolve + follow
test('sources/resolve searches the founder\'s first storefront (or ?country=)', async () => {
  const u = await user();
  routes = [['lookup?id=938003185', LOOKUP_OK], ['itunes.apple.com/search', () => res(fx('apple-search.json'))]];
  await u.post('/api/setup', { ...profile, competitor_source: app1, locations: [{ country: 'gb' }, { country: 'us' }] });
  calls = [];
  const r = await u.get('/api/sources/resolve?q=fake');
  assert.equal(r.status, 200);
  assert.match(calls[0].url, /country=gb/);
  assert.equal(r.json[0].country, 'gb');
  calls = [];
  await u.get('/api/sources/resolve?q=fake&country=ca');
  assert.match(calls[0].url, /country=ca/);
  assert.equal((await u.get('/api/sources/resolve?q=fake&country=zz')).status, 400);
});

test('POST /api/sources can tie a community to one of the founder\'s locations', async () => {
  const u = await user();
  routes = [['lookup?id=938003185', LOOKUP_OK], ['/new/.rss', () => res(fx('reddit-rss.xml'))]];
  await u.post('/api/setup', { ...profile, competitor_source: app1, locations: [{ country: 'in', region: 'Mumbai' }] });
  const ok = await u.post('/api/sources', { type: 'reddit', external_id: 'mumbai', country: 'in', region: 'Mumbai' });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.location.country, 'in');
  assert.equal(ok.json.location.region, 'Mumbai');
  assert.equal((await u.post('/api/sources', { type: 'reddit', external_id: 'london', country: 'gb' })).status, 400);
});

// ---------------------------------------------------------------- suggestions
const arcticRoutes = () => [
  ['subreddit_prefix=mumbai', () => res(fx('reddit-subreddits-mumbai-arctic.json'))],
  ['subreddit_prefix=india', () => res(fx('reddit-subreddits-india-arctic.json'))]
];

test('suggest (Arctic fallback): drops NSFW/private/tiny subs, exact match first, then by subscribers', async () => {
  const u = await user();
  routes = arcticRoutes();
  const r = await u.get('/api/locations/suggest?country=in&region=Mumbai');
  assert.equal(r.status, 200);
  const names = r.json.suggestions.map((s) => s.name);
  assert.deepEqual(names, ['mumbai', 'MumbaiIndians', 'mumbai_rain', 'india', 'IndiaInvestments', 'indiasocial']);
  assert.ok(!names.includes('mumbaiGWild') && !names.includes('privatemumbai') && !names.includes('tinymumbai') && !names.includes('indiansub'));
  assert.deepEqual(r.json.suggestions[0], { name: 'mumbai', subscribers: 861052, scope: 'region', country: 'in', region: 'Mumbai' });
  assert.equal(r.json.suggestions.find((s) => s.name === 'india').scope, 'country');
  assert.equal(callsTo('oauth.reddit.com'), 0);
});

test('suggest uses the official API when credentials are set; falls back to Arctic if it fails', async () => {
  const u = await user();
  process.env.REDDIT_CLIENT_ID = 'id'; process.env.REDDIT_CLIENT_SECRET = 'secret'; process.env.REDDIT_USER_AGENT = 'agent/1.0';
  routes = [
    ['api/v1/access_token', () => res(fx('reddit-token.json'))],
    ['oauth.reddit.com/subreddits/search?q=Mumbai', () => res(fx('reddit-subreddits-mumbai-official.json'))],
    ['oauth.reddit.com/subreddits/search?q=India', () => res(fx('reddit-subreddits-india-official.json'))],
    ...arcticRoutes()
  ];
  const r = await u.get('/api/locations/suggest?country=in&region=Mumbai');
  assert.equal(r.json.suggestions[0].name, 'mumbai');
  assert.equal(callsTo('arctic-shift'), 0);
  assert.equal(calls.find((c) => c.url.includes('subreddits/search')).init.headers.authorization, 'bearer tok_fixture');
  // official breaks → Arctic answers
  reddit.resetToken();
  calls = [];
  routes = [['api/v1/access_token', () => new Response('x', { status: 500 })], ...arcticRoutes()];
  const fb = await u.get('/api/locations/suggest?country=in&region=Mumbai');
  assert.equal(fb.json.suggestions[0].name, 'mumbai');
  assert.ok(callsTo('arctic-shift') > 0);
});

test('suggest: country only; every provider failing → 200 [] + note; reddit off → note; auth; rate limit', async () => {
  const u = await user();
  routes = arcticRoutes();
  const countryOnly = await u.get('/api/locations/suggest?country=in');
  assert.ok(countryOnly.json.suggestions.every((s) => s.scope === 'country' && s.region === ''));
  routes = [['arctic-shift', () => new Response('x', { status: 500 })]];
  const down = await u.get('/api/locations/suggest?country=in&region=Mumbai');
  assert.equal(down.status, 200);
  assert.deepEqual(down.json.suggestions, []);
  assert.match(down.json.note, /type a subreddit name/);
  process.env.REDDIT_PROVIDER = 'off';
  const off = await u.get('/api/locations/suggest?country=in');
  assert.deepEqual(off.json.suggestions, []);
  assert.match(off.json.note, /disabled/);
  assert.equal((await client().get('/api/locations/suggest?country=in')).status, 401);
  assert.equal((await u.get('/api/locations/suggest?country=zz')).status, 400);

  const limited = await user();
  routes = arcticRoutes();
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await limited.get('/api/locations/suggest?country=in')).status);
  assert.equal(statuses.filter((s) => s === 200).length, 30);
  assert.equal(statuses[30], 429);
});

test('no hardcoded quotes in locations.js (config only)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'locations.js'), 'utf8');
  assert.doesNotMatch(src, /revenge trade|losing streak/i);
});
