// Frontend tests: run the real public/app.js inside jsdom against the real Express app + DB.
// Only the outside world (Apple/Reddit) is faked. Each "browser" has its own cookie jar and IP.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thevoice-fe-test-'));
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.NODE_ENV = 'test';
for (const k of ['REDDIT_PROVIDER', 'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT', 'CRON_SECRET']) delete process.env[k];

const app = require('../server');
const db = require('../database');
const http = require('../collectors/http');
const reddit = require('../collectors/reddit');

const PUBLIC = path.join(__dirname, '..', 'public');
const APP_JS = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const res = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });

// ---- fake outside world (Apple + Reddit) ----
let routes = [];
const fakeFetch = (url) => {
  for (const [m, h] of routes) if (url.includes(m)) { const o = typeof h === 'function' ? h(url) : h; return Promise.resolve(o instanceof Response ? o : res(o)); }
  return Promise.resolve(new Response('not found', { status: 404 }));
};
const standardRoutes = () => [
  ['itunes.apple.com/search', () => res(fx('apple-search.json'))],
  ['itunes.apple.com/lookup', (url) => { // answers for exactly the ids that were asked about (batched, comma-separated)
    const known = { 938003185: 'Fake Trading App', 123456789: 'Other App' };
    const ids = (/[?&]id=([\d,]+)/.exec(url) || [])[1] || '';
    const results = ids.split(',').filter((i) => known[i]).map((i) => ({ trackId: Number(i), trackName: known[i], artistName: 'Dev', trackViewUrl: `https://apps.apple.com/us/app/x/id${i}` }));
    return res({ resultCount: results.length, results });
  }],
  ['page=1/', () => res(fx('appstore-reviews-page1.json'))],
  ['page=2/', () => res(fx('appstore-reviews-empty.json'))],
  ['subreddits/search', () => res(fx('reddit-subreddits-mumbai-arctic.json'))],
  ['arctic-shift.photon-reddit.com/api/posts', () => res(fx('reddit-arctic.json'))],
  ['/new/.rss', () => res(fx('reddit-rss.xml'))]
];

let server, base, ipN = 0, emailN = 0;
before(async () => {
  await db.init();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  routes = standardRoutes();
  http.reset();
  http.configure({ fetchImpl: fakeFetch, sleep: () => new Promise((r) => setImmediate(r)) });
  reddit.resetToken();
  delete process.env.REDDIT_PROVIDER;
});

// ---- a tiny browser: cookie jar + jsdom pages ----
function newBrowser() {
  const ip = `10.4.0.${++ipN}`;
  let cookie = '';
  const nodeFetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, base);
    const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), 'x-forwarded-for': ip, ...(cookie && { cookie }) } });
    const set = r.headers.get('set-cookie');
    if (set) cookie = /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(set) ? '' : set.split(';')[0];
    return r;
  };
  async function open(pathname) {
    const html = await (await nodeFetch(pathname)).text();
    const dom = new JSDOM(html, { url: base + pathname, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    const page = { window: w, document: w.document, copied: [], navigations: [], dom };
    w.fetch = (u, init) => nodeFetch(u, init);
    w.__navigate = (u) => page.navigations.push(u);
    Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t) => { page.copied.push(t); } }, configurable: true });
    w.eval(APP_JS);
    page.$ = (sel, root) => (root || w.document).querySelector(sel);
    page.$$ = (sel, root) => [...(root || w.document).querySelectorAll(sel)];
    page.text = (sel) => (page.$(sel) ? page.$(sel).textContent : '');
    page.byText = (sel, text, root) => page.$$(sel, root).find((n) => n.textContent.trim() === text);
    page.waitFor = async (fn, what = 'condition', ms = 4000) => {
      const start = Date.now();
      for (;;) {
        let v; try { v = fn(); } catch (e) { v = false; }
        if (v) return v;
        if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}\nPAGE: ${w.document.body.textContent.replace(/\s+/g, ' ').slice(0, 400)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    page.type = (sel, value) => { const n = page.$(sel); assert.ok(n, `no element ${sel}`); n.value = value; n.dispatchEvent(new w.Event('input', { bubbles: true })); n.dispatchEvent(new w.Event('change', { bubbles: true })); };
    page.click = (target) => { const n = typeof target === 'string' ? page.$(target) : target; assert.ok(n, `no element ${target}`); n.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); };
    page.submit = (sel) => { const f = page.$(sel); assert.ok(f, `no form ${sel}`); f.requestSubmit(); };
    page.settle = () => new Promise((r) => setTimeout(r, 40));
    page.close = () => w.close();
    pages.push(page);
    return page;
  }
  const pages = [];
  return { open, ip, fetch: nodeFetch, closeAll: () => pages.forEach((p) => p.window.close()), get cookie() { return cookie; } };
}

async function api(b, method, url, body) {
  const r = await b.fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let json; try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, json };
}
async function signedUp(profile = true) {
  const b = newBrowser();
  const s = await api(b, 'POST', '/api/auth/signup', { email: `fe${++emailN}@example.com`, password: 'password123' });
  assert.equal(s.status, 201);
  b.id = s.json.id;
  if (profile) {
    const r = await api(b, 'POST', '/api/setup', { app_description: 'A trading journal', target_user: 'Day traders', voice_tone: 'Direct', competitor_url: 'Fake' });
    assert.equal(r.status, 200);
  }
  return b;
}
const row = (n, over = {}) => ({
  external_id: `fe${n}-${Math.random()}`, quote: `I keep struggling with thing number ${n} every day`, source: 'App Store review (★1)',
  source_url: 'https://apps.apple.com/us/app/id1?see-all=reviews', rating: 1, pain_score: 0.6, content_hash: `feh-${n}-${Math.random()}`,
  published_at: Date.now(), fetched_at: Date.now(), ...over
});
async function seedQuotes(userId, n = 3, over = {}) {
  const sid = await db.upsertSource({ type: 'app_store', external_id: String(600000 + ++emailN), country: 'us', label: 'Seed App (App Store, US)', url: 'https://apps.apple.com/us/app/id1' });
  await db.followSource(userId, sid, 'competitor');
  await db.insertQuotes(sid, Array.from({ length: n }, (_, i) => row(i + 1, over)));
  await db.client.execute({ sql: 'UPDATE sources SET last_collected_at = ?, last_status = ? WHERE id = ?', args: [Date.now(), 'ok', sid] });
  return (await db.getUserQuotes(userId, { sourceId: sid })).map((q) => q.id);
}
const hooks = ['First hook', 'Second hook', 'Third hook', 'Fourth hook', 'Fifth hook'];
async function saveContent(b, extra = {}) {
  const r = await api(b, 'POST', '/api/content', { hooks, script: 'The full script', inspiration_quote_ids: [], ...extra });
  assert.equal(r.status, 201); return r.json;
}

// =====================================================================
// static pages + CSP hygiene
// =====================================================================
test('every page is served (also via clean URLs), with CSP, and contains no inline script/style/handlers', async () => {
  const pagesList = ['login', 'signup', 'index', 'dashboard', 'sources', 'connect'];
  for (const p of pagesList) {
    const r = await fetch(`${base}/${p}.html`);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(html, new RegExp(`<body data-page="${p}">`));
    assert.match(html, /<script src="\/app\.js" defer><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="\/style\.css">/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<title>[^<]{5,}<\/title>/);
    assert.doesNotMatch(html, /<script>|<style|\sstyle=|\son[a-z]+=|javascript:/i, `${p} has inline code/styles`);
    assert.equal((await fetch(`${base}/${p}`)).status, 200, `clean url /${p}`);
  }
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
  assert.match((await (await fetch(`${base}/`)).text()), /data-page="index"/);
});

test('app.js has no dangerous DOM sinks; style.css defines the brand tokens', () => {
  assert.doesNotMatch(APP_JS, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\(|document\.write\(|\beval\(|new Function\(/);
  assert.doesNotMatch(APP_JS, /\.setAttribute\(\s*['"]style['"]/);
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  for (const token of ['#0f0f0f', '#6366f1', '#f5f5f5']) assert.ok(css.includes(token), token);
  assert.match(css, /@media \(min-width/);
  assert.match(css, /:focus-visible/);
});

// =====================================================================
// auth pages + guards
// =====================================================================
test('protected pages redirect logged-out visitors to /login.html', async () => {
  const b = newBrowser();
  for (const p of ['/dashboard.html', '/sources.html', '/connect.html', '/index.html']) {
    const page = await b.open(p);
    await page.waitFor(() => page.navigations.includes('/login.html'), `redirect from ${p}`);
  }
  b.closeAll();
});

test('signup form creates an account, then sends a new user to onboarding; duplicate shows an inline error', async () => {
  const b = newBrowser();
  const page = await b.open('/signup.html');
  assert.equal(page.$('#site-header').textContent.includes('Dashboard'), false); // logged-out header has no app nav
  page.type('#email', 'new@example.com'); page.type('#password', 'short');
  page.submit('#auth-form');
  await page.waitFor(() => page.text('#form-error').includes('at least 8'), 'password error');
  assert.deepEqual(page.navigations, []);
  page.type('#password', 'password123'); page.submit('#auth-form');
  await page.waitFor(() => page.navigations.includes('/index.html'), 'redirect to onboarding');

  const again = await newBrowser().open('/signup.html');
  again.type('#email', 'NEW@example.com'); again.type('#password', 'password123'); again.submit('#auth-form');
  await again.waitFor(() => again.$('#form-error .alert.error'), 'duplicate error');
  assert.match(again.text('#form-error'), /Could not create an account/);
  assert.equal(again.$('#submit').disabled, false); // can retry
  b.closeAll();
});

test('login: wrong password shows a generic error; correct login goes to the dashboard (profile) or onboarding (none)', async () => {
  const withProfile = await signedUp(true);
  const email = (await api(withProfile, 'GET', '/api/auth/me')).json.email;
  const b = newBrowser();
  const page = await b.open('/login.html');
  page.type('#email', email); page.type('#password', 'wrongpass1'); page.submit('#auth-form');
  await page.waitFor(() => page.$('#form-error .alert.error'), 'login error');
  assert.match(page.text('#form-error'), /Invalid email or password/);
  page.type('#password', 'password123'); page.submit('#auth-form');
  await page.waitFor(() => page.navigations.includes('/dashboard.html'), 'redirect to dashboard');

  const noProfile = await signedUp(false);
  const again = await noProfile.open('/login.html'); // already logged in → bounced
  await again.waitFor(() => again.navigations.includes('/index.html'), 'logged-in visitor redirected');
  withProfile.closeAll(); b.closeAll(); noProfile.closeAll();
});

test('dashboard bounces a user who has not finished onboarding; header nav + log out work', async () => {
  const fresh = await signedUp(false);
  const d = await fresh.open('/dashboard.html');
  await d.waitFor(() => d.navigations.includes('/index.html'), 'redirect to onboarding');

  const user = await signedUp(true);
  const page = await user.open('/dashboard.html');
  await page.waitFor(() => page.byText('#site-header a', 'Sources'), 'nav');
  assert.equal(page.byText('#site-header a', 'Dashboard').getAttribute('aria-current'), 'page');
  page.click(page.byText('#site-header button', 'Log out'));
  await page.waitFor(() => page.navigations.includes('/login.html'), 'logout redirect');
  assert.equal((await api(user, 'GET', '/api/auth/me')).status, 401); // session really ended
  fresh.closeAll(); user.closeAll();
});

// =====================================================================
// onboarding
// =====================================================================
test('onboarding: pick an app, add a second location + communities, submit → collected quotes shown → continue to connect', async () => {
  const b = await signedUp(false);
  const page = await b.open('/index.html');
  await page.waitFor(() => page.$('#loc-country-0'), 'location row');
  assert.equal(page.$('#loc-country-0').value, 'us');
  assert.ok(page.$$('#loc-country-0 option').length >= 30);
  assert.equal(page.$('#voice_tone').value, 'Direct');

  page.type('#app_description', 'A trading journal'); page.type('#target_user', 'Day traders'); page.type('#niche', 'trading psychology');
  page.type('#competitor', 'fake trading'); page.click('#find-app');
  await page.waitFor(() => page.$$('#competitor-result .pick').length === 2, 'app results');
  page.click(page.$('#app-0')); // "Add"
  await page.waitFor(() => page.text('#chosen-competitors').includes('Fake Trading App'), 'competitor added');
  assert.match(page.text('#chosen-competitors'), /1\/5 competitors/);
  assert.equal(page.$('#mentions').checked, true); // Reddit complaints about competitors default on

  page.click('#add-location');
  await page.waitFor(() => page.$('#loc-country-1'), 'second location');
  page.type('#loc-country-1', 'gb'); page.type('#loc-region-1', 'London');
  await page.waitFor(() => page.$('#loc-country-1').value === 'gb', 'second country');

  page.click('#suggest');
  await page.waitFor(() => page.$$('#communities label.pick').length > 0, 'suggestions');
  const mumbai = page.$$('#communities label.pick').find((l) => l.textContent.includes('r/mumbai'));
  assert.ok(mumbai, 'suggested r/mumbai');
  page.click(mumbai.querySelector('input'));
  await page.waitFor(() => page.$$('#chosen .chip').some((c) => c.textContent.includes('r/mumbai')), 'chosen community');

  page.type('#comm-name', 'r/UKPersonalFinance'); page.type('#comm-loc', '1'); page.click('#add-community');
  await page.waitFor(() => page.$$('#chosen .chip').some((c) => c.textContent.includes('r/UKPersonalFinance')), 'manual community');

  page.submit('#setup-form');
  await page.waitFor(() => page.$('#continue'), 'collection result panel', 8000);
  assert.match(page.text('#main'), /You’re set up/);
  assert.match(page.text('#main'), /new quotes/);
  assert.equal(page.$('#continue').getAttribute('href'), '/connect.html'); // first time → connect

  const founder = (await api(b, 'GET', '/api/founder')).json;
  assert.equal(founder.niche, 'trading psychology');
  assert.deepEqual(founder.locations.map((l) => [l.country, l.region]), [['us', ''], ['gb', 'London']]);
  assert.equal(founder.sources.filter((s) => s.role === 'competitor' && s.type === 'app_store').length, 2); // one per country
  assert.equal(founder.sources.filter((s) => s.type === 'reddit_search').length, 1); // + Reddit complaints about the competitor
  assert.equal(founder.competitors.length, 1);
  assert.deepEqual([...founder.competitors[0].countries].sort(), ['gb', 'us']);
  assert.deepEqual(founder.sources.filter((s) => s.role === 'community').map((s) => s.label).sort(), ['r/UKPersonalFinance', 'r/mumbai']);
  const quotes = (await api(b, 'GET', '/api/pain-quotes?limit=100')).json;
  assert.ok(quotes.length > 0);
  b.closeAll();
});

test('onboarding: ZERO competitors is allowed — a founder can save a profile with no competitor, problem or community', async () => {
  const b = await signedUp(false);
  const page = await b.open('/index.html');
  await page.waitFor(() => page.$('#loc-country-0'), 'form');
  assert.ok(page.$$('legend').some((l) => /Your competitors.*optional/.test(l.textContent)));
  page.type('#app_description', 'A journal'); page.type('#target_user', 'Traders');
  page.submit('#setup-form');
  await page.waitFor(() => page.$('#continue'), 'saved with no competitors', 8000);
  assert.match(page.text('#main'), /nothing to collect/); // honest note, not an error
  const founder = (await api(b, 'GET', '/api/founder')).json;
  assert.deepEqual(founder.competitors, []);
  assert.equal(founder.competitor_url, '');
  assert.equal(founder.sources.length, 0);
  b.closeAll();
});

test('onboarding validation: stale location tie, no results message, English warning', async () => {
  const b = await signedUp(false);
  const page = await b.open('/index.html');
  await page.waitFor(() => page.$('#loc-country-0'), 'form');
  page.type('#app_description', 'x'); page.type('#target_user', 'y');

  page.type('#competitor', 'a'); page.click('#find-app');
  await page.waitFor(() => page.text('#competitor-result').includes('at least 2'), 'short query message');

  routes = [['itunes.apple.com/search', () => res({ resultCount: 0, results: [] })], ...standardRoutes()];
  page.type('#competitor', 'zzzzzz'); page.click('#find-app');
  await page.waitFor(() => page.text('#competitor-result').includes('No apps found'), 'no apps found');

  page.type('#loc-country-0', 'de');
  await page.waitFor(() => page.$('.alert.warn'), 'english warning');
  assert.match(page.text('#locations'), /isn't primarily English/);
  page.type('#loc-country-0', 'us');

  // a community tied to a location whose region is edited afterwards is caught before the request
  page.type('#loc-region-0', 'Austin');
  page.type('#comm-name', 'austin'); page.type('#comm-loc', '0'); page.click('#add-community');
  await page.waitFor(() => page.$$('#chosen .chip').length === 1, 'community added');
  page.type('#loc-region-0', 'Dallas');
  page.type('#competitor', 'typed only');
  page.submit('#setup-form');
  await page.waitFor(() => page.text('#form-error').includes('r/austin'), 'stale tie error');
  assert.equal((await api(b, 'GET', '/api/founder')).status, 404); // nothing was saved
  b.closeAll();
});

test('onboarding edit mode: everything is prefilled; dropping a competitor and unticking Reddit re-links the sources', async () => {
  const b = await signedUp(false);
  const first = await b.open('/index.html');
  await first.waitFor(() => first.$('#loc-country-0'), 'form');
  first.type('#app_description', 'Journal'); first.type('#target_user', 'Traders'); first.type('#competitor', 'fake'); first.click('#find-app');
  await first.waitFor(() => first.$('#app-0') && first.$('#app-1'), 'results');
  first.click(first.$('#app-0')); first.click(first.$('#app-1'));
  await first.waitFor(() => first.$$('#chosen-competitors .chip').length === 2, 'two competitors chosen');
  first.type('#loc-region-0', 'Austin');
  first.submit('#setup-form');
  await first.waitFor(() => first.$('#continue'), 'saved', 8000);
  assert.equal((await api(b, 'GET', '/api/founder')).json.competitors.length, 2);

  const again = await b.open('/index.html');
  await again.waitFor(() => again.$('#app_description') && again.$('#app_description').value === 'Journal', 'prefill');
  assert.equal(again.$('#target_user').value, 'Traders');
  assert.equal(again.$('#loc-region-0').value, 'Austin');
  await again.waitFor(() => again.$$('#chosen-competitors .chip').length === 2, 'competitor chips prefilled');
  assert.equal(again.$('#mentions').checked, true);

  again.click(again.$('#chosen-competitors .chip button')); // drop the first competitor
  await again.waitFor(() => again.$$('#chosen-competitors .chip').length === 1, 'one left');
  again.click('#mentions'); // untick Reddit complaints
  assert.equal(again.$('#mentions').checked, false);
  again.submit('#setup-form');
  await again.waitFor(() => again.$('#continue'), 'saved again', 8000);
  assert.equal(again.$('#continue').getAttribute('href'), '/dashboard.html'); // not the first time
  const after = (await api(b, 'GET', '/api/founder')).json;
  assert.equal(after.competitors.length, 1);
  assert.equal(after.competitor_mentions, false);
  assert.equal(after.sources.filter((s) => s.type === 'reddit_search').length, 0);
  b.closeAll();
});

// =====================================================================
// dashboard
// =====================================================================
test('dashboard empty states: "still collecting" with no quotes, "connect" once quotes exist', async () => {
  const b = await signedUp(true);
  const p1 = await b.open('/dashboard.html');
  await p1.waitFor(() => !p1.$('#empty').hidden, 'empty state');
  assert.match(p1.text('#empty'), /still collecting/);
  assert.equal(p1.$('#empty a').getAttribute('href'), '/sources.html');

  await seedQuotes(b.id, 2);
  const p2 = await b.open('/dashboard.html');
  await p2.waitFor(() => !p2.$('#empty').hidden, 'empty state 2');
  assert.match(p2.text('#empty'), /Connect TheVoice to Claude to generate your first content →/);
  assert.equal(p2.$('#empty a').getAttribute('href'), '/connect.html');
  b.closeAll();
});

test('dashboard: cards show preview + badge, expand shows 5 hooks, script and linked quotes; generate copies the prompt', async () => {
  const b = await signedUp(true);
  const ids = await seedQuotes(b.id, 2);
  await saveContent(b, { inspiration_quote_ids: ids });
  const page = await b.open('/dashboard.html');
  await page.waitFor(() => page.$('article.card'), 'card');
  const card = page.$('article.card');
  assert.match(card.querySelector('.card-title').textContent, /First hook/);
  assert.equal(card.querySelector('.badge').textContent, 'draft');
  const head = card.querySelector('.card-head');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(card.querySelector('.card-body').hidden, true);
  page.click(head);
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  const body = card.querySelector('.card-body');
  assert.equal(body.hidden, false);
  assert.equal(body.querySelectorAll('ol.hooks li').length, 5);
  assert.match(body.querySelector('.script').textContent, /The full script/);
  const links = [...body.querySelectorAll('.quote a')];
  assert.equal(links.length, 2);
  assert.ok(links.every((a) => a.href.startsWith('https://') && a.rel.includes('noopener') && a.target === '_blank'));

  page.click('#generate');
  await page.waitFor(() => page.copied.length === 1, 'clipboard');
  assert.match(page.copied[0], /Use TheVoice: read my profile, pain quotes and history/);
  await page.waitFor(() => page.text('#toast-region').includes('Prompt copied'), 'toast');
  b.closeAll();
});

test('XSS: hostile hooks, script and quotes render as inert text; non-https source links are not links', async () => {
  const b = await signedUp(true);
  const evil = '<img src=x onerror="window.__xss=1">';
  const ids = await seedQuotes(b.id, 1, { quote: `${evil} I hate this app so much and I keep failing`, source_url: 'javascript:alert(1)' });
  await saveContent(b, { hooks: [evil, '<script>window.__xss=2</script>', 'ok', 'ok2', 'ok3'], script: `${evil}\n<b>bold</b>`, inspiration_quote_ids: ids });
  const page = await b.open('/dashboard.html');
  await page.waitFor(() => page.$('article.card'), 'card');
  page.click(page.$('.card-head'));
  const card = page.$('article.card');
  assert.equal(card.querySelectorAll('img, script, b').length, 0);
  assert.ok(card.textContent.includes(evil), 'markup shown literally');
  assert.equal(page.window.__xss, undefined);
  assert.equal(card.querySelectorAll('.quote a').length, 0); // javascript: URL rejected
  assert.match(card.querySelector('.quote .src').textContent, /App Store review/);

  const sources = await b.open('/sources.html');
  await sources.waitFor(() => sources.$('#quotes .quote'), 'quotes preview');
  assert.equal(sources.$$('#quotes img, #quotes script').length, 0);
  assert.equal(sources.window.__xss, undefined);
  b.closeAll();
});

test('dashboard approve / edit / delete each ask for a reason and call the API in order', async () => {
  const b = await signedUp(true);
  const c1 = await saveContent(b);
  const page = await b.open('/dashboard.html');
  await page.waitFor(() => page.$('article.card'), 'card');
  page.click(page.$('.card-head'));
  const body = () => page.$('article.card .card-body');

  // --- approve
  page.click(page.byText('button', 'Approve', body()));
  await page.waitFor(() => page.$('.modal'), 'approve modal');
  assert.match(page.text('.modal h2'), /What worked well\?/);
  assert.match(page.text('.modal'), /Optional/);
  page.type('#modal-input', 'Sounds like my users');
  page.click(page.byText('button', 'Approve', page.$('.modal')));
  await page.waitFor(() => !page.$('.modal') && page.$('article.card .badge.approved'), 'approved');
  let current = (await api(b, 'GET', '/api/content')).json[0];
  assert.equal(current.status, 'approved');
  assert.equal(current.feedback_reason, 'Sounds like my users');
  assert.equal(page.byText('button', 'Approved', page.$('article.card')).disabled, true);
  assert.equal(page.$('article.card .card-body').hidden, false); // stays expanded across reload

  // --- edit: cancel with Escape changes nothing
  page.click(page.byText('button', 'Edit', body()));
  await page.waitFor(() => page.$$('.edit-hook').length === 5, 'editor');
  page.type('.edit-hook', 'Brand new first hook');
  page.click(page.byText('button', 'Save', body()));
  await page.waitFor(() => page.$('.modal'), 'edit modal');
  assert.match(page.text('.modal h2'), /What made you change this\?/);
  page.document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await page.waitFor(() => !page.$('.modal'), 'modal closed');
  assert.equal((await api(b, 'GET', '/api/content')).json[0].hooks[0], 'First hook');
  // --- edit: save with a reason
  page.click(page.byText('button', 'Save', body()));
  await page.waitFor(() => page.$('.modal'), 'edit modal 2');
  page.type('#modal-input', 'Punchier');
  page.click(page.byText('button', 'Save changes', page.$('.modal')));
  await page.waitFor(() => !page.$('.modal') && page.$('article.card .badge.edited'), 'edited');
  current = (await api(b, 'GET', '/api/content')).json[0];
  assert.equal(current.hooks[0], 'Brand new first hook');
  assert.equal(current.founder_feedback, 'edited');
  assert.equal(current.feedback_reason, 'Punchier');
  assert.match(page.text('article.card .card-title'), /Brand new first hook/);

  // --- edit validation: empty hook is rejected client-side
  page.click(page.byText('button', 'Edit', body()));
  await page.waitFor(() => page.$$('.edit-hook').length === 5, 'editor 2');
  page.type('.edit-hook', '   ');
  page.click(page.byText('button', 'Save', body()));
  await page.waitFor(() => page.$('article.card .alert.error'), 'validation');
  assert.ok(!page.$('.modal'));
  page.click(page.byText('button', 'Cancel', body()));

  // --- delete (reason optional → skip it)
  page.click(page.byText('button', 'Delete', body()));
  await page.waitFor(() => page.$('.modal'), 'delete modal');
  assert.match(page.text('.modal h2'), /Delete this content\?/);
  assert.match(page.text('.modal'), /What didn’t work about this\?/);
  page.click(page.byText('button', 'Delete', page.$('.modal')));
  await page.waitFor(() => !page.$('article.card') && !page.$('#empty').hidden, 'card gone');
  assert.deepEqual((await api(b, 'GET', '/api/content')).json, []);
  const row = (await db.client.execute({ sql: 'SELECT status, founder_feedback FROM content WHERE id = ?', args: [c1.id] })).rows[0];
  assert.equal(row.status, 'deleted'); // soft delete + feedback recorded even without a reason
  assert.equal(row.founder_feedback, 'deleted');
  b.closeAll();
});

test('dashboard modal: focus is trapped and returns to the opener', async () => {
  const b = await signedUp(true);
  await saveContent(b);
  const page = await b.open('/dashboard.html');
  await page.waitFor(() => page.$('article.card'), 'card');
  page.click(page.$('.card-head'));
  const approve = page.byText('button', 'Approve', page.$('.card-body'));
  approve.focus();
  page.click(approve);
  await page.waitFor(() => page.$('.modal'), 'modal');
  assert.equal(page.document.activeElement.id, 'modal-input'); // focus moved in
  assert.equal(page.$('.modal').getAttribute('role'), 'dialog');
  assert.equal(page.$('.modal').getAttribute('aria-modal'), 'true');
  const last = page.byText('button', 'Approve', page.$('.modal'));
  last.focus();
  page.document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(page.document.activeElement.id, 'modal-input'); // wrapped to the first control, not out of the dialog
  assert.ok(page.$('.modal').contains(page.document.activeElement));
  page.click(page.byText('button', 'Cancel', page.$('.modal')));
  await page.waitFor(() => !page.$('.modal'), 'closed');
  assert.equal(page.document.activeElement, approve);
  b.closeAll();
});

test('dashboard shows an error banner when the API fails', async () => {
  const b = await signedUp(true);
  const page = await b.open('/dashboard.html');
  await page.waitFor(() => page.$('#empty') && !page.$('#empty').hidden, 'loaded');
  page.window.fetch = async () => { throw new Error('offline'); };
  page.click('#refresh');
  await page.waitFor(() => page.$('#status .alert.error'), 'error banner');
  assert.match(page.text('#status'), /Could not reach the server/);
  b.closeAll();
});

// =====================================================================
// sources
// =====================================================================
test('sources page: statuses, strict toggle, add/remove community, collect now, quote preview with location chips', async () => {
  const b = await signedUp(false);
  assert.equal((await api(b, 'POST', '/api/setup', {
    app_description: 'a', target_user: 'b', voice_tone: 'Direct', competitor_url: 'Fake', competitor_source: { type: 'app_store', external_id: '938003185' },
    locations: [{ country: 'in', region: 'Mumbai' }], communities: [{ name: 'mumbai', country: 'in', region: 'Mumbai' }]
  })).status, 200);
  // Sources and quotes are public rows shared between tests, so reset these two to a known "never collected" state.
  for (const s of (await api(b, 'GET', '/api/sources')).json.sources) {
    await db.client.execute({ sql: 'DELETE FROM pain_quotes WHERE source_id = ?', args: [s.id] });
    await db.client.execute({ sql: 'UPDATE sources SET last_status = NULL, last_error = NULL, last_collected_at = NULL, next_collect_at = 0, consecutive_failures = 0 WHERE id = ?', args: [s.id] });
  }
  const page = await b.open('/sources.html');
  await page.waitFor(() => page.$$('#sources li[data-source]').length === 2, 'two sources');
  assert.ok(page.$$('#sources .chip.pending').length === 2); // not collected yet
  assert.match(page.text('#sources'), /r\/mumbai/);
  assert.match(page.text('#sources'), /Mumbai, IN/);
  assert.equal(page.$('#strict').checked, true);

  page.click('#collect');
  await page.waitFor(() => page.$('#results .card'), 'collect results', 8000);
  assert.match(page.text('#results'), /fetched/);
  await page.waitFor(() => page.$$('#sources .chip.ok').length === 2, 'sources ok');
  await page.waitFor(() => page.$$('#quotes .quote').length > 0, 'quote preview');
  assert.ok(page.$$('#quotes .chip.loc').length > 0);

  // collect again → nothing due
  page.click('#collect');
  await page.waitFor(() => page.text('#results').includes('nothing is due'), 'nothing due');

  // strict toggle
  page.click('#strict');
  await page.waitFor(() => page.$('#strict') && page.$('#strict').checked === false && page.text('#toast-region').includes('everything you follow'), 'toggled off');
  assert.equal((await api(b, 'GET', '/api/sources')).json.location_mode, 'all');

  // add + remove a community
  page.type('#add-name', 'Daytrading'); page.type('#add-loc', '');
  page.click('#add-btn');
  await page.waitFor(() => page.$$('#sources li[data-source]').length === 3, 'community added');
  page.type('#add-name', 'bad name!'); page.click('#add-btn');
  await page.waitFor(() => page.$('#sources .alert.error'), 'validation error');
  const remove = page.$('#sources li[data-source]:last-child button') || page.byText('#sources button', 'Remove');
  page.click(remove);
  await page.waitFor(() => page.$('.modal'), 'confirm remove');
  page.click(page.byText('button', 'Remove', page.$('.modal')));
  await page.waitFor(() => page.$$('#sources li[data-source]').length === 2, 'removed');
  b.closeAll();
});

test('sources page: a failing source shows its error; disabled Reddit is explained honestly', async () => {
  const b = await signedUp(true);
  const sid = await db.upsertSource({ type: 'reddit', external_id: 'brokensub', country: '', label: 'r/brokensub', url: 'https://www.reddit.com/r/brokensub/' });
  await db.followSource(b.id, sid, 'community');
  await db.client.execute({ sql: "UPDATE sources SET last_status='error', last_error='Reddit unavailable (arctic: 500)' WHERE id = ?", args: [sid] });
  const page = await b.open('/sources.html');
  await page.waitFor(() => page.$$('#sources li[data-source]').length === 1, 'source');
  assert.ok(page.$('#sources .chip.error'));
  assert.match(page.text('#sources'), /Reddit unavailable \(arctic: 500\)/);

  process.env.REDDIT_PROVIDER = 'off';
  const off = await b.open('/sources.html');
  await off.waitFor(() => off.text('#sources').includes('switched off on this server'), 'reddit off note');
  assert.equal(off.$('#add-btn'), null);
  const onboarding = await b.open('/index.html');
  await onboarding.waitFor(() => onboarding.text('#communities').includes('switched off on this server'), 'onboarding note');
  b.closeAll();
});

test('collect now: a rate-limited user sees a friendly message, not a crash', async () => {
  const b = await signedUp(true);
  const page = await b.open('/sources.html');
  await page.waitFor(() => page.$('#collect'), 'page');
  for (let i = 0; i < 6; i++) await api(b, 'POST', '/api/collect', {});
  page.click('#collect');
  await page.waitFor(() => page.text('#results').includes('collected a lot'), 'rate limit message');
  b.closeAll();
});

// =====================================================================
// connect
// =====================================================================
test('connect: create key (shown once), config uses the real origin + key, key works on /mcp, regenerate revokes the old one', async () => {
  const b = await signedUp(true);
  const page = await b.open('/connect.html');
  await page.waitFor(() => page.text('#key-meta').includes("don’t have a key"), 'no key yet');
  assert.equal(page.text('#mcp-url'), `${base}/mcp`);
  assert.match(page.text('#config-json'), /YOUR_KEY/);
  const cfg0 = JSON.parse(page.text('#config-json'));
  assert.deepEqual(cfg0.mcpServers.thevoice.args.slice(0, 3), ['-y', 'mcp-remote', `${base}/mcp`]);
  assert.equal(cfg0.mcpServers.thevoice.args[3], '--header');
  assert.equal(cfg0.mcpServers.thevoice.args[4], 'Authorization:${AUTH_HEADER}');

  page.click('#make-key');
  await page.waitFor(() => page.$('#key-value'), 'key shown');
  const key = page.text('#key-value');
  assert.match(key, /^tv_[A-Za-z0-9_-]{30,}$/);
  assert.match(page.text('#key-box'), /shown only once/);
  assert.equal(JSON.parse(page.text('#config-json')).mcpServers.thevoice.env.AUTH_HEADER, `Bearer ${key}`);
  await page.waitFor(() => page.text('#key-meta').includes(key.slice(0, 8)), 'prefix shown');
  assert.ok(!page.text('#key-meta').includes(key), 'meta never shows the full key');
  assert.equal(page.text('#make-key'), 'Regenerate key');

  page.click('#copy-key'); await page.waitFor(() => page.copied.includes(key), 'key copied');
  page.click('#copy-url'); await page.waitFor(() => page.copied.includes(`${base}/mcp`), 'url copied');
  page.click('#copy-prompt'); await page.waitFor(() => page.copied.includes('Generate 5 hooks for my app using TheVoice'), 'prompt copied');
  page.click('#copy-config'); await page.waitFor(() => page.copied.some((t) => t.includes(`Bearer ${key}`)), 'config copied');

  const rpc = (k) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${k}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
  assert.equal((await rpc(key)).status, 200);

  page.click('#make-key'); // regenerate → must confirm
  await page.waitFor(() => page.$('.modal'), 'confirm modal');
  assert.match(page.text('.modal'), /stops working immediately/);
  page.click(page.byText('button', 'Cancel', page.$('.modal')));
  await page.waitFor(() => !page.$('.modal'), 'cancelled');
  assert.equal((await rpc(key)).status, 200); // cancel changed nothing
  page.click('#make-key');
  await page.waitFor(() => page.$('.modal'), 'confirm modal 2');
  page.click(page.byText('button', 'Regenerate', page.$('.modal')));
  await page.waitFor(() => page.text('#key-value') && page.text('#key-value') !== key, 'new key');
  const key2 = page.text('#key-value');
  assert.equal((await rpc(key)).status, 401);
  assert.equal((await rpc(key2)).status, 200);
  b.closeAll();
});

// =====================================================================
// which app + when published
// =====================================================================
test('quotes show WHICH APP they are about and WHEN they were published (dashboard + sources), incl. Reddit complaints', async () => {
  const b = await signedUp(true);
  const store = await db.upsertSource({ type: 'app_store', external_id: String(500000 + ++emailN), country: 'us', label: 'Robinhood: Trading & Investing (App Store, US)', url: 'https://apps.apple.com/us/app/id1', subject: 'Robinhood: Trading & Investing' });
  const mention = await db.upsertSource({ type: 'reddit_search', external_id: `robinhood${emailN}`, country: '', label: 'Reddit: complaints about “Robinhood”', url: 'https://www.reddit.com/search/', subject: 'Robinhood' });
  await db.followSource(b.id, store, 'competitor');
  await db.followSource(b.id, mention, 'competitor');
  const published = Date.parse('2026-11-08T12:00:00Z');
  const expected = new Date(published).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  await db.insertQuotes(store, [row(1, { quote: 'I keep struggling with the unique-review-marker every day', source: 'App Store review (★1)', published_at: published })]);
  await db.insertQuotes(mention, [row(2, { quote: 'I keep failing and hate the unique-post-marker so much', source: 'Reddit r/wallstreetbets', source_url: 'https://www.reddit.com/r/wallstreetbets/comments/a/b/', rating: null, published_at: published })]);
  const quotes = (await api(b, 'GET', '/api/pain-quotes?limit=50')).json;
  const ids = quotes.filter((q) => /unique-(review|post)-marker/.test(q.quote)).map((q) => q.id);
  assert.equal(ids.length, 2);
  await saveContent(b, { inspiration_quote_ids: ids });

  const dash = await b.open('/dashboard.html');
  await dash.waitFor(() => dash.$('article.card'), 'card');
  dash.click(dash.$('.card-head'));
  const metas = dash.$$('article.card .quote .src').map((n) => n.textContent);
  const review = metas.find((t) => t.includes('App Store review'));
  const post = metas.find((t) => t.includes('Reddit r/wallstreetbets'));
  assert.ok(review && post, metas.join(' | '));
  assert.match(review, /of Robinhood: Trading & Investing/);
  assert.ok(review.includes(`Published ${expected}`), review);
  assert.match(post, /about Robinhood/);
  assert.ok(post.includes(`Published ${expected}`), post);
  assert.ok(dash.$$('article.card .quote .src strong.app').length === 2);

  const src = await b.open('/sources.html');
  await src.waitFor(() => src.$$('#quotes .quote .src').length >= 2, 'quote preview');
  const previews = src.$$('#quotes .quote .src').map((n) => n.textContent);
  const prevPost = previews.find((t) => t.includes('about Robinhood'));
  assert.ok(prevPost, previews.join(' | '));
  assert.ok(prevPost.includes('all regions'), 'Reddit complaints are labelled as not tied to a place');
  assert.ok(prevPost.includes(`Published ${expected}`));
  assert.ok(previews.some((t) => t.includes('of Robinhood: Trading & Investing') && t.includes(`Published ${expected}`)));
  assert.match(src.text('#sources'), /Searching all of Reddit for “Robinhood”/);
  assert.match(src.text('#sources'), /r\/wallstreetbets · 1/); // the specific subreddit the complaints came from
  b.closeAll();
});

test('onboarding: add problems (button or Enter), duplicates/short/over-cap are refused, chips are removable, saved and prefilled on edit', async () => {
  const b = await signedUp(false);
  const page = await b.open('/index.html');
  await page.waitFor(() => page.$('#loc-country-0'), 'form');
  assert.match(page.text('#chosen-problems'), /0\/8 problems/);
  const addVia = (text, how = 'button') => {
    page.type('#problem-input', text);
    if (how === 'enter') page.$('#problem-input').dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    else page.click('#add-problem');
  };
  addVia('revenge trading');
  assert.equal(page.$$('#chosen-problems .chip.kw').length, 1);
  assert.equal(page.$('#problem-input').value, ''); // cleared after adding
  addVia('not following my system', 'enter'); // Enter works and does not submit the whole form
  assert.equal(page.$$('#chosen-problems .chip.kw').length, 2);
  assert.equal(page.$('#continue'), null);
  assert.match(page.text('#chosen-problems'), /2\/8 problems/);

  addVia('REVENGE   Trading'); // duplicate (case/space-insensitive)
  assert.match(page.text('#problem-error'), /already added/);
  assert.equal(page.$$('#chosen-problems .chip.kw').length, 2);
  addVia('ab');
  assert.match(page.text('#problem-error'), /at least 3 characters/);
  addVia('   '); // blank → nothing happens
  assert.equal(page.$$('#chosen-problems .chip.kw').length, 2);
  for (let i = 0; i < 6; i++) addVia(`extra problem number ${i}`);
  assert.equal(page.$$('#chosen-problems .chip.kw').length, 8);
  addVia('one problem too many');
  assert.match(page.text('#problem-error'), /up to 8 problems/);
  page.click(page.$$('#chosen-problems .chip.kw button')[7]); // remove the last
  assert.equal(page.$$('#chosen-problems .chip.kw').length, 7);
  for (let i = 0; i < 5; i++) page.click(page.$$('#chosen-problems .chip.kw button')[2]); // keep just the first two + one
  assert.equal(page.$$('#chosen-problems .chip.kw').length, 2);

  page.type('#app_description', 'A journal'); page.type('#target_user', 'Traders');
  page.submit('#setup-form');
  await page.waitFor(() => page.$('#continue'), 'saved', 8000);
  const founder = (await api(b, 'GET', '/api/founder')).json;
  assert.deepEqual(founder.keywords, ['revenge trading', 'not following my system']);
  assert.equal(founder.sources.filter((s) => s.type === 'reddit_keyword').length, 2);

  const again = await b.open('/index.html');
  await again.waitFor(() => again.$$('#chosen-problems .chip.kw').length === 2, 'problems prefilled');
  assert.deepEqual(again.$$('#chosen-problems .chip.kw').map((c) => c.textContent.replace('×', '').trim()), ['“revenge trading”', '“not following my system”']);
  again.click(again.$('#chosen-problems .chip.kw button'));
  again.submit('#setup-form');
  await again.waitFor(() => again.$('#continue'), 'saved again', 8000);
  assert.deepEqual((await api(b, 'GET', '/api/founder')).json.keywords, ['not following my system']);
  b.closeAll();
});

test('Sources page: "Problems you’re tracking" shows each problem with matching quotes, Reddit search status and plain-language errors; matching quotes get their own preview group', async () => {
  const b = await signedUp(true);
  const n = ++emailN;
  const k1 = `pivot${n} trading`, k2 = `slip${n} system`;
  const set = await api(b, 'POST', '/api/setup', { app_description: 'a', target_user: 'b', voice_tone: 'Direct', competitor_url: '', problem_keywords: [k1, k2] });
  assert.equal(set.status, 200);
  const s1 = set.json.sources.find((s) => s.type === 'reddit_keyword' && s.subject === k1);
  const s2 = set.json.sources.find((s) => s.type === 'reddit_keyword' && s.subject === k2);
  await db.insertQuotes(s1.id, [row(1, { quote: `I keep ${k1} again and again and I hate it`, source: 'Reddit r/Forex', rating: null, source_url: 'https://www.reddit.com/r/Forex/comments/a/b/' })]);
  await db.client.execute({ sql: "UPDATE sources SET last_status='ok', last_collected_at=? WHERE id = ?", args: [Date.now(), s1.id] });
  await db.client.execute({ sql: "UPDATE sources SET last_status='error', last_error='Reddit search unavailable (rss: www.reddit.com responded 403)' WHERE id = ?", args: [s2.id] });

  const page = await b.open('/sources.html');
  await page.waitFor(() => page.$('#problems li[data-problem]'), 'problems card');
  assert.match(page.text('#problems h2'), /Problems you’re tracking/);
  const row1 = page.$$('#problems li[data-problem]').find((li) => li.getAttribute('data-problem') === k1);
  const row2 = page.$$('#problems li[data-problem]').find((li) => li.getAttribute('data-problem') === k2);
  assert.match(row1.textContent, /1 matching quotes/);
  assert.ok(row1.querySelector('.chip.ok'));
  assert.match(row1.textContent, /r\/Forex · 1/);
  assert.ok(row2.querySelector('.chip.error'));
  assert.match(row2.textContent, /Reddit is blocking automated requests from this network/); // old raw 403 text is translated
  assert.doesNotMatch(row2.textContent, /403|www\.reddit\.com/);
  assert.match(page.text('#problems'), /Promotions .* are filtered out/);

  // preview: a third group first, with the matching quote and its problem chip
  await page.waitFor(() => page.$$('#quotes h3').length === 3, 'three groups');
  assert.deepEqual(page.$$('#quotes h3').map((h) => h.textContent), ['Matching your problems', 'App Store reviews', 'Reddit posts']);
  const matching = page.$$('#quotes .quote').find((q) => q.textContent.includes(`I keep ${k1} again`));
  assert.ok(matching);
  assert.ok([...matching.querySelectorAll('.chip.kw')].some((c) => c.textContent === `“${k1}”`));
  b.closeAll();
});

test('Sources page without problems shows how to add them and no "matching" group; Reddit-off problems explain themselves', async () => {
  const b = await signedUp(true);
  const page = await b.open('/sources.html');
  await page.waitFor(() => page.$('#problems'), 'problems card');
  assert.match(page.text('#problems'), /No problems yet/);
  assert.match(page.text('#problems'), /revenge trading/);
  await page.waitFor(() => page.$$('#quotes h3').length === 2, 'two groups only');
  assert.ok(!page.$$('#quotes h3').some((h) => h.textContent === 'Matching your problems'));

  process.env.REDDIT_PROVIDER = 'off';
  const c = await signedUp(false);
  await api(c, 'POST', '/api/setup', { app_description: 'a', target_user: 'b', voice_tone: 'Direct', competitor_url: '', problem_keywords: [`offtopic${++emailN} thing`] });
  const p2 = await c.open('/sources.html');
  await p2.waitFor(() => p2.$('#problems li[data-problem]'), 'problem row');
  assert.ok(p2.$$('#problems .chip').some((x) => x.textContent === 'Reddit search off'));
  assert.match(p2.text('#problems'), /only highlights matching quotes from your other sources/);
  b.closeAll(); c.closeAll();
});

test('Sources page groups by company: picked country, App Store entry per country, and that company\'s specific Reddit communities', async () => {
  const b = await signedUp(false);
  routes = [['itunes.apple.com/lookup', (url) => {
    const ids = ((/[?&]id=([\d,]+)/.exec(url) || [])[1] || '').split(',');
    const names = { 938003185: 'Swiggy: Food Instamart Dineout', 886427730: 'Zomato: Food Delivery' };
    const results = ids.filter((i) => names[i]).map((i) => ({ trackId: Number(i), trackName: names[i], artistName: 'Dev', trackViewUrl: `https://apps.apple.com/in/app/x/id${i}` }));
    return res({ resultCount: results.length, results });
  }], ...routes];
  const setup = await api(b, 'POST', '/api/setup', {
    app_description: 'a', target_user: 'b', voice_tone: 'Direct', competitor_url: 'Swiggy, Zomato',
    competitor_sources: [{ type: 'app_store', external_id: '938003185' }, { type: 'app_store', external_id: '886427730' }],
    competitor_mentions: true, locations: [{ country: 'in' }]
  });
  assert.equal(setup.status, 200);
  const swiggy = setup.json.sources.find((s) => s.type === 'reddit_search' && s.subject === 'Swiggy');
  const mk = (n, url) => row(n, { source: 'Reddit', source_url: url, rating: null, quote: `I keep failing and hate the unique-swiggy-${n} so much` });
  await db.insertQuotes(swiggy.id, [mk(1, 'https://www.reddit.com/r/swiggy/comments/a/b/'), mk(2, 'https://www.reddit.com/r/swiggy/comments/c/d/'), mk(3, 'https://www.reddit.com/r/CreditCardsIndia/comments/e/f/')]);
  await db.client.execute({ sql: "UPDATE sources SET last_status='ok', last_collected_at=? WHERE id = ?", args: [Date.now(), swiggy.id] });
  const zomato = setup.json.sources.find((s) => s.type === 'reddit_search' && s.subject === 'Zomato');
  await db.client.execute({ sql: "UPDATE sources SET last_status='error', last_error='Reddit search unavailable (rss: www.reddit.com responded 429)' WHERE id = ?", args: [zomato.id] });

  const page = await b.open('/sources.html');
  await page.waitFor(() => page.$$('#sources .company').length === 2, 'two company cards');
  const card = (name) => page.$$('#sources .company').find((c) => c.querySelector('h3').textContent.startsWith(name));
  const sw = card('Swiggy');
  assert.ok(sw, 'Swiggy card');
  assert.ok([...sw.querySelectorAll('.chip.loc')].some((c) => c.textContent === 'India'), 'shows the country you picked');
  assert.match(sw.textContent, /App Store reviews/);
  assert.match(sw.textContent, /Reddit complaints/);
  assert.match(sw.textContent, /Searching all of Reddit for “Swiggy”/);
  assert.match(sw.textContent, /Your countries:\s*India/);
  const subs = [...sw.querySelectorAll('.subs .chip')].map((c) => c.textContent.trim());
  assert.deepEqual(subs, ['r/swiggy · 2', 'r/CreditCardsIndia · 1 ✓']); // specific subreddits, most first; ✓ marks the India-related one
  assert.match(sw.textContent, /✓ = a community whose name relates to your country/);

  const zo = card('Zomato');
  assert.match(zo.textContent, /Reddit is limiting how fast we can search/); // friendly, not "429 www.reddit.com"
  assert.doesNotMatch(zo.textContent, /429|www\.reddit\.com/);
  assert.ok(zo.querySelector('.chip.error'));
  b.closeAll();
});

test('Reddit blocked (403): plain-language message for old and new errors; an OK source shows its "narrower results" note', async () => {
  const b = await signedUp(false);
  routes = [['itunes.apple.com/lookup', () => res({ resultCount: 2, results: [
    { trackId: 938003185, trackName: 'Swiggy: Food Delivery', artistName: 'Dev', trackViewUrl: 'https://apps.apple.com/in/app/x/id938003185' },
    { trackId: 123456789, trackName: 'Zomato: Food Delivery', artistName: 'Dev', trackViewUrl: 'https://apps.apple.com/in/app/x/id123456789' }] })], ...routes];
  const setup = await api(b, 'POST', '/api/setup', { app_description: 'a', target_user: 'b', voice_tone: 'Direct', competitor_url: 'x',
    competitor_sources: [{ type: 'app_store', external_id: '938003185' }, { type: 'app_store', external_id: '123456789' }], competitor_mentions: true, locations: [{ country: 'in' }] });
  assert.equal(setup.status, 200);
  const sw = setup.json.sources.find((s) => s.type === 'reddit_search' && s.subject === 'Swiggy');
  const zo = setup.json.sources.find((s) => s.type === 'reddit_search' && s.subject === 'Zomato');
  // Swiggy: an OLD raw error stored before the friendly messages existed
  await db.client.execute({ sql: "UPDATE sources SET last_status='error', last_error='Reddit search unavailable (rss: www.reddit.com responded 403)' WHERE id = ?", args: [sw.id] });
  // Zomato: collected through the app-community fallback, with its remark
  await db.client.execute({ sql: "UPDATE sources SET last_status='ok', last_collected_at=?, last_error='Reddit is blocking this network, so only communities named after the app are read — not all of Reddit.' WHERE id = ?", args: [Date.now(), zo.id] });
  const page = await b.open('/sources.html');
  await page.waitFor(() => page.$$('#sources .company').length === 2, 'cards');
  const card = (n) => page.$$('#sources .company').find((c) => c.querySelector('h3').textContent.startsWith(n));
  const swiggy = card('Swiggy').textContent;
  assert.match(swiggy, /Reddit is blocking automated requests from this network/);
  assert.match(swiggy, /official Reddit API fixes this/);
  assert.doesNotMatch(swiggy, /403|www\.reddit\.com|Reddit search unavailable/);
  const zomato = card('Zomato');
  assert.ok(zomato.querySelector('.reddit-note'));
  assert.match(zomato.querySelector('.reddit-note').textContent, /only communities named after the app are read/);
  assert.equal(zomato.querySelector('.reddit-row .field-error'), null); // an OK source is not shown as an error
  b.closeAll();
});

test('a company without the Reddit option shows that Reddit is off for it, not a broken row', async () => {
  const b = await signedUp(false);
  assert.equal((await api(b, 'POST', '/api/setup', {
    app_description: 'a', target_user: 'b', voice_tone: 'Direct', competitor_url: 'Fake', competitor_sources: [{ type: 'app_store', external_id: '938003185' }], competitor_mentions: false, locations: [{ country: 'us' }]
  })).status, 200);
  const page = await b.open('/sources.html');
  await page.waitFor(() => page.$('#sources .company'), 'company card');
  assert.match(page.text('#sources .company'), /Reddit complaints/);
  assert.match(page.text('#sources .company'), /Turn on “Also collect complaints from Reddit”/);
  assert.ok(page.$$('#sources .company .chip').some((c) => c.textContent === 'off'));
  b.closeAll();
});

test('"What Claude will see" shows App Store reviews AND Reddit posts as separate groups, even when reviews score higher', async () => {
  const b = await signedUp(true);
  // own sources: the public Fake-app source is shared with other tests and would add higher-scoring quotes
  const store = { id: await db.upsertSource({ type: 'app_store', external_id: String(400000 + ++emailN), country: 'us', label: 'Split App (App Store, US)', url: 'https://apps.apple.com/us/app/id1', subject: 'Split App' }) };
  const mention = { id: await db.upsertSource({ type: 'reddit_search', external_id: `split${emailN}`, country: '', label: 'Reddit: complaints about “Split”', url: 'https://www.reddit.com/search/', subject: `Split${emailN}` }) };
  await db.followSource(b.id, store.id, 'competitor');
  await db.followSource(b.id, mention.id, 'competitor');
  await db.insertQuotes(store.id, Array.from({ length: 12 }, (_, i) => row(100 + i, { pain_score: 0.97, quote: `I keep struggling with unique-store-${i} every day` })));
  await db.insertQuotes(mention.id, [row(200, { pain_score: 0.55, source: 'Reddit r/stocks', rating: null, source_url: 'https://www.reddit.com/r/stocks/comments/z/y/', quote: 'I keep failing and hate the unique-reddit-post so much' })]);
  const page = await b.open('/sources.html');
  await page.waitFor(() => page.$$('#quotes .quote').length >= 2, 'preview');
  const headings = page.$$('#quotes h3').map((h) => h.textContent);
  assert.deepEqual(headings, ['App Store reviews', 'Reddit posts']);
  const text = page.text('#quotes');
  assert.match(text, /unique-reddit-post/); // present although 12 higher-scoring reviews exist
  assert.equal(page.$$('#quotes .quote').filter((n) => n.textContent.includes('unique-store')).length, 5); // reviews capped at 5
  assert.ok(page.$$('#quotes .quote').some((n) => n.textContent.includes('about') && n.textContent.includes('r/stocks')));
  assert.equal(page.$('#reddit-empty'), null);
  b.closeAll();
});

test('Reddit group explains WHY it is empty (no sources / failing / nothing passed the filter)', async () => {
  // no Reddit sources at all
  const a = await signedUp(false);
  await api(a, 'POST', '/api/setup', { app_description: 'a', target_user: 'b', voice_tone: 'Direct', competitor_url: 'Fake', competitor_sources: [{ type: 'app_store', external_id: '938003185' }], competitor_mentions: false, locations: [{ country: 'us' }] });
  const p1 = await a.open('/sources.html');
  await p1.waitFor(() => p1.$('#reddit-empty'), 'empty note');
  assert.match(p1.text('#reddit-empty'), /No Reddit sources yet/);

  // Reddit source that failed
  const b = await signedUp(true);
  const sid = await db.upsertSource({ type: 'reddit', external_id: `emptysub${++emailN}`, country: '', label: 'r/emptysub', url: 'https://www.reddit.com/r/emptysub/' });
  await db.followSource(b.id, sid, 'community');
  await db.client.execute({ sql: "UPDATE sources SET last_status='error', last_error='Reddit is limiting how fast we can search. It will retry automatically in a few minutes.' WHERE id = ?", args: [sid] });
  const p2 = await b.open('/sources.html');
  await p2.waitFor(() => p2.$('#reddit-empty'), 'empty note 2');
  assert.match(p2.text('#reddit-empty'), /hasn’t returned anything yet/);

  // Reddit collected fine but nothing passed the filter
  await db.client.execute({ sql: "UPDATE sources SET last_status='ok', last_error=NULL, last_collected_at=? WHERE id = ?", args: [Date.now(), sid] });
  const p3 = await b.open('/sources.html');
  await p3.waitFor(() => p3.$('#reddit-empty'), 'empty note 3');
  assert.match(p3.text('#reddit-empty'), /nothing collected so far passed the complaint filter/);
  a.closeAll(); b.closeAll();
});

test('Reddit quotes offer "Copy link" and an old.reddit.com alternative (for networks Reddit blocks); App Store quotes do not', async () => {
  const b = await signedUp(true);
  const sid = await db.upsertSource({ type: 'reddit', external_id: `blocksub${++emailN}`, country: '', label: 'r/blocksub', url: 'https://www.reddit.com/r/blocksub/' });
  await db.followSource(b.id, sid, 'community');
  await db.insertQuotes(sid, [row(1, { source: 'Reddit r/blocksub', rating: null, source_url: 'https://www.reddit.com/r/blocksub/comments/abc/some_post/', quote: 'I keep failing and hate the unique-blocked-marker so much' })]);
  const store = await seedQuotes(b.id, 1, { quote: 'I keep struggling with the unique-appstore-marker every day' });
  void store;
  const page = await b.open('/sources.html');
  await page.waitFor(() => page.$$('#quotes .quote').length >= 2, 'quotes');
  const redditQuote = page.$$('#quotes .quote').find((n) => n.textContent.includes('unique-blocked-marker'));
  const storeQuote = page.$$('#quotes .quote').find((n) => n.textContent.includes('unique-appstore-marker'));
  assert.ok(redditQuote && storeQuote);
  assert.ok(redditQuote.querySelector('button.copy-link'));
  const alt = redditQuote.querySelector('a.old-reddit');
  assert.equal(alt.href, 'https://old.reddit.com/r/blocksub/comments/abc/some_post/');
  assert.equal(alt.rel.includes('noopener'), true);
  assert.equal(storeQuote.querySelector('button.copy-link'), null);
  assert.equal(storeQuote.querySelector('a.old-reddit'), null);
  page.click(redditQuote.querySelector('button.copy-link'));
  await page.waitFor(() => page.copied.includes('https://www.reddit.com/r/blocksub/comments/abc/some_post/'), 'link copied');
  await page.waitFor(() => page.text('#toast-region').includes('Link copied'), 'toast');
  b.closeAll();
});

test('older saved content without app/date in its snapshot still renders ("date unknown", no crash)', async () => {
  const b = await signedUp(true);
  const made = await saveContent(b);
  const legacy = JSON.stringify([{ id: 1, quote: 'An old snapshot quote about pain', source: 'App Store review (★2)', source_url: 'https://apps.apple.com/us/app/id1' }]);
  await db.client.execute({ sql: 'UPDATE content SET inspiration_snapshot = ? WHERE id = ?', args: [legacy, made.id] });
  const page = await b.open('/dashboard.html');
  await page.waitFor(() => page.$('article.card'), 'card');
  page.click(page.$('.card-head'));
  const meta = page.$('article.card .quote .src').textContent;
  assert.match(meta, /App Store review \(★2\)/);
  assert.match(meta, /date unknown/);
  assert.equal(page.$$('article.card .quote strong.app').length, 0);
  b.closeAll();
});

test('onboarding: competitor cap of 5 disables Add and the Reddit-complaints option explains it is not tied to a place', async () => {
  const b = await signedUp(false);
  const page = await b.open('/index.html');
  await page.waitFor(() => page.$('#loc-country-0'), 'form');
  assert.match(page.text('#mentions-wrap'), /all regions/);
  assert.match(page.text('#mentions-wrap'), /Searches all of Reddit/);
  // search results are the same two apps each time, so fake a full set by searching and adding both, then check the counter
  page.type('#competitor', 'fake'); page.click('#find-app');
  await page.waitFor(() => page.$('#app-0') && page.$('#app-1'), 'results');
  page.click(page.$('#app-0')); page.click(page.$('#app-1'));
  await page.waitFor(() => page.text('#chosen-competitors').includes('2/5 competitors'), 'counter');
  b.closeAll();
});

test('competitor results are toggles: selecting highlights the row, clicking again deselects, chips stay in sync', async () => {
  const b = await signedUp(false);
  const page = await b.open('/index.html');
  await page.waitFor(() => page.$('#loc-country-0'), 'form');
  page.type('#competitor', 'fake'); page.click('#find-app');
  await page.waitFor(() => page.$('#app-0') && page.$('#app-1'), 'results');
  const row = (i) => page.$(`#app-${i}`).closest('.pick');
  assert.equal(row(0).classList.contains('selected'), false);
  assert.equal(page.$('#app-0').getAttribute('aria-pressed'), 'false');
  assert.equal(page.$('#app-0').textContent, 'Select');

  page.click(page.$('#app-0')); // select → highlighted
  assert.equal(row(0).classList.contains('selected'), true);
  assert.equal(row(1).classList.contains('selected'), false); // only the chosen one
  assert.equal(page.$('#app-0').getAttribute('aria-pressed'), 'true');
  assert.match(page.$('#app-0').textContent, /Selected/);
  assert.match(page.$('#app-0').getAttribute('aria-label'), /^Deselect /);
  assert.equal(page.$$('#chosen-competitors .chip').length, 1);
  assert.equal(page.$('#app-0').disabled, false); // still clickable so it can be undone

  page.click(page.$('#app-0')); // deselect → highlight gone, chip gone
  assert.equal(row(0).classList.contains('selected'), false);
  assert.equal(page.$('#app-0').getAttribute('aria-pressed'), 'false');
  assert.equal(page.$$('#chosen-competitors .chip').length, 0);
  assert.match(page.text('#chosen-competitors'), /0\/5 competitors/);

  page.click(page.$('#app-0')); page.click(page.$('#app-1'));
  assert.equal(page.$$('.pick.selected').length, 2);
  page.click(page.$('#chosen-competitors .chip button')); // removing a chip also un-highlights its result row
  assert.equal(page.$$('.pick.selected').length, 1);
  assert.equal(page.$$('#chosen-competitors .chip').length, 1);
  b.closeAll();
});

test('competitor cap: at 5 selected, unselected results are disabled but selected ones can still be deselected', async () => {
  const b = await signedUp(false);
  const page = await b.open('/index.html');
  await page.waitFor(() => page.$('#loc-country-0'), 'form');
  const apps = [[11111111, 'Aaa'], [22222222, 'Bbb'], [33333333, 'Ccc'], [44444444, 'Ddd'], [55555555, 'Eee'], [66666666, 'Fff']];
  routes = [['itunes.apple.com/search', () => res({ resultCount: 6, results: apps.map(([id, n]) => ({ trackId: id, trackName: `${n} App`, artistName: 'Dev', trackViewUrl: `https://apps.apple.com/us/app/x/id${id}` })) })], ...routes];
  page.type('#competitor', 'many'); page.click('#find-app');
  await page.waitFor(() => page.$$('#competitor-result .pick').length === 6, 'six results');
  for (let i = 0; i < 5; i++) page.click(page.$(`#app-${i}`));
  assert.equal(page.$$('.pick.selected').length, 5);
  assert.match(page.text('#chosen-competitors'), /5\/5 competitors/);
  assert.equal(page.$('#app-5').disabled, true); // the sixth can't be added
  assert.match(page.$('#app-5').getAttribute('title'), /up to 5/);
  assert.equal(page.$('#app-0').disabled, false); // selected ones stay toggleable
  page.click(page.$('#app-0')); // free a slot
  assert.equal(page.$('#app-5').disabled, false);
  page.click(page.$('#app-5'));
  assert.equal(page.$$('.pick.selected').length, 5);
  assert.equal(page.$('#app-5').closest('.pick').classList.contains('selected'), true);
  b.closeAll();
});

test('selection survives a new search: results already chosen show as selected', async () => {
  const b = await signedUp(false);
  const page = await b.open('/index.html');
  await page.waitFor(() => page.$('#loc-country-0'), 'form');
  page.type('#competitor', 'fake'); page.click('#find-app');
  await page.waitFor(() => page.$('#app-0'), 'results');
  page.click(page.$('#app-0'));
  page.click('#find-app'); // search again
  await page.waitFor(() => page.$('#app-0') && page.$('#app-0').closest('.pick').classList.contains('selected'), 'still selected after re-search');
  assert.equal(page.$$('#chosen-competitors .chip').length, 1);
  b.closeAll();
});
