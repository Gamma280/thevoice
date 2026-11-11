const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Temp DB must be configured before the app (and database.js) is loaded.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thevoice-test-'));
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../database');

let server, base;
let ipCounter = 0;

before(async () => {
  await db.init();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.client.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// Each client gets its own fake IP (via X-Forwarded-For) so rate limits don't bleed between tests.
function client() {
  const ip = `10.0.0.${++ipCounter}`;
  let cookie = '';
  const call = async (method, url, body, extra = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(cookie && { cookie }), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers };
  };
  return { ip, call, get: (u) => call('GET', u), post: (u, b, extra) => call('POST', u, b ?? {}, extra), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u) };
}

const hooks = ['one', 'two', 'three', 'four', 'five'];
// Real quotes come from collection; tests insert rows directly (no hardcoded quote data in the app).
async function seedQuotes(userId, count = 3) {
  const sid = await db.upsertSource({ type: 'app_store', external_id: `55${userId}${Math.floor(Math.random() * 1e6)}`, country: 'us', label: 'Test App', url: 'https://apps.apple.com/us/app/id1' });
  await db.followSource(userId, sid, 'competitor');
  await db.insertQuotes(sid, Array.from({ length: count }, (_, i) => ({
    external_id: `q${i}`, quote: `I keep struggling with thing number ${i}`, source: 'App Store review (★1)',
    source_url: 'https://apps.apple.com/us/app/id1?see-all=reviews', rating: 1, pain_score: 0.5,
    content_hash: `hash-${sid}-${i}`, published_at: Date.now(), fetched_at: Date.now()
  })));
  return (await db.getUserQuotes(userId, { sourceId: sid })).map((q) => q.id);
}
async function signedUp(email) {
  const c = client();
  const r = await c.post('/api/auth/signup', { email, password: 'password123' });
  assert.equal(r.status, 201);
  return c;
}

test('unauthenticated requests are rejected', async () => {
  const c = client();
  for (const u of ['/api/founder', '/api/content', '/api/pain-quotes', '/api/mcp-key', '/api/auth/me']) {
    assert.equal((await c.get(u)).status, 401, u);
  }
  assert.equal((await c.post('/api/setup', {})).status, 401);
});

test('signup/login: duplicates, generic errors, cookie flags', async () => {
  const c = client();
  const r = await c.post('/api/auth/signup', { email: 'Dup@Example.com', password: 'password123' });
  assert.equal(r.status, 201);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.doesNotMatch(cookie, /Secure/i); // only in production

  assert.equal((await c.post('/api/auth/signup', { email: 'dup@example.com', password: 'password123' })).status, 409);
  assert.equal((await c.post('/api/auth/signup', { email: 'x@example.com', password: 'short' })).status, 400);
  assert.equal((await c.post('/api/auth/signup', { email: 'not-an-email', password: 'password123' })).status, 400);

  const bad = await c.post('/api/auth/login', { email: 'dup@example.com', password: 'wrongpass1' });
  const unknown = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrongpass1' });
  assert.equal(bad.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(bad.json, unknown.json);

  const ok = await c.post('/api/auth/login', { email: 'DUP@example.com', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/auth/me')).json.email, 'dup@example.com');
});

test('logout ends the session', async () => {
  const c = await signedUp('logout@example.com');
  assert.equal((await c.get('/api/auth/me')).status, 200);
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  const stale = client();
  assert.equal((await stale.get('/api/auth/me')).status, 401);
});

test('profile setup, upsert and hasProfile', async () => {
  const c = await signedUp('profile@example.com');
  assert.equal((await c.get('/api/founder')).status, 404);
  assert.equal((await c.get('/api/auth/me')).json.hasProfile, false);

  const profile = { app_description: 'A trading journal', target_user: 'Day traders', voice_tone: 'Direct', competitor_url: 'Tradezella' };
  const r = await c.post('/api/setup', profile);
  assert.equal(r.status, 200);
  assert.equal(r.json.niche, '');
  assert.equal((await c.get('/api/auth/me')).json.hasProfile, true);

  assert.equal((await c.post('/api/setup', { ...profile, voice_tone: 'Sarcastic' })).status, 400);
  const upd = await c.post('/api/setup', { ...profile, app_description: 'Updated' });
  assert.equal(upd.json.app_description, 'Updated');
  assert.equal((await c.get('/api/founder')).json.app_description, 'Updated');
});

test('pain quotes: empty until sources are followed; then only followed quotes', async () => {
  const c = await signedUp('quotes@example.com');
  assert.deepEqual((await c.get('/api/pain-quotes')).json, []);
  const me = (await c.get('/api/auth/me')).json;
  await seedQuotes(me.id, 3);
  const r = await c.get('/api/pain-quotes');
  assert.equal(r.json.length, 3);
  assert.ok(r.json[0].id && r.json[0].quote && r.json[0].source && r.json[0].source_url);
  const other = await signedUp('quotes2@example.com');
  assert.deepEqual((await other.get('/api/pain-quotes')).json, []);
});

test('content CRUD, validation and soft delete', async () => {
  const c = await signedUp('content@example.com');
  const qids = await seedQuotes((await c.get('/api/auth/me')).json.id, 3);
  assert.equal((await c.post('/api/content', { hooks: hooks.slice(0, 4), script: 's' })).status, 400);
  assert.equal((await c.post('/api/content', { hooks, script: '' })).status, 400);
  assert.equal((await c.post('/api/content', { hooks, script: 's', inspiration_quote_ids: [99999] })).status, 400);

  const created = await c.post('/api/content', { hooks, script: 'my script', inspiration_quote_ids: [qids[0], qids[1]] });
  assert.equal(created.status, 201);
  assert.equal(created.json.status, 'draft');
  assert.equal(created.json.inspiration_quotes.length, 2);
  const id = created.json.id;

  const edited = await c.put(`/api/content/${id}`, { script: 'new script' });
  assert.equal(edited.json.status, 'edited');
  assert.equal(edited.json.script, 'new script');
  assert.deepEqual(edited.json.hooks, hooks);
  assert.ok(edited.json.modified_at);
  assert.equal((await c.put(`/api/content/${id}`, {})).status, 400);

  assert.equal((await c.post(`/api/feedback/${id}`, { feedback: 'loved', reason: '' })).status, 400);
  const fb = await c.post(`/api/feedback/${id}`, { feedback: 'approved', reason: 'Great hook' });
  assert.equal(fb.json.status, 'approved');
  assert.equal(fb.json.feedback_reason, 'Great hook');

  assert.equal((await c.del(`/api/content/${id}`)).status, 200);
  assert.equal((await c.get('/api/content')).json.length, 0);
  assert.equal((await c.del(`/api/content/${id}`)).status, 404); // already deleted
  // feedback after delete still works (dashboard: DELETE then reason)
  assert.equal((await c.post(`/api/feedback/${id}`, { feedback: 'deleted', reason: 'Too generic' })).status, 200);

  const row = await db.client.execute({ sql: 'SELECT status, feedback_reason FROM content WHERE id = ?', args: [id] });
  assert.equal(row.rows[0].status, 'deleted');
  assert.equal(row.rows[0].feedback_reason, 'Too generic');
});

test('user isolation: B cannot see or touch A content (404)', async () => {
  const a = await signedUp('a@example.com');
  const b = await signedUp('b@example.com');
  const { json } = await a.post('/api/content', { hooks, script: 'A secret', inspiration_quote_ids: [] });
  const id = json.id;

  assert.equal((await b.get('/api/content')).json.length, 0);
  assert.equal((await b.put(`/api/content/${id}`, { script: 'hacked' })).status, 404);
  assert.equal((await b.del(`/api/content/${id}`)).status, 404);
  assert.equal((await b.post(`/api/feedback/${id}`, { feedback: 'approved', reason: '' })).status, 404);

  const still = (await a.get('/api/content')).json;
  assert.equal(still.length, 1);
  assert.equal(still[0].script, 'A secret');
  assert.equal(still[0].status, 'draft');

  // profiles are isolated too
  await a.post('/api/setup', { app_description: 'A app', target_user: 'x', voice_tone: 'Casual', competitor_url: 'y' });
  assert.equal((await b.get('/api/founder')).status, 404);
});

test('MCP key: create, rotate, plaintext only once', async () => {
  const c = await signedUp('key@example.com');
  assert.deepEqual((await c.get('/api/mcp-key')).json, { exists: false });
  const k1 = await c.post('/api/mcp-key');
  assert.equal(k1.status, 201);
  assert.match(k1.json.key, /^tv_/);
  const meta = (await c.get('/api/mcp-key')).json;
  assert.equal(meta.exists, true);
  assert.equal(meta.prefix, k1.json.key.slice(0, 8));
  assert.equal(JSON.stringify(meta).includes(k1.json.key), false);
  const k2 = await c.post('/api/mcp-key');
  assert.notEqual(k1.json.key, k2.json.key);
  const active = await db.client.execute('SELECT COUNT(*) n FROM api_keys WHERE revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE email = \'key@example.com\')');
  assert.equal(Number(active.rows[0].n), 1);
});

test('CSRF guards: non-JSON and cross-origin mutations are rejected', async () => {
  const c = await signedUp('csrf@example.com');
  const noJson = await c.call('POST', '/api/setup', undefined, { 'content-type': 'text/plain' });
  assert.equal(noJson.status, 415);
  const cross = await c.post('/api/mcp-key', {}, { origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  const same = await c.call('POST', '/api/mcp-key', {}, { origin: base });
  assert.equal(same.status, 201);
});

test('invalid JSON body -> 400, unknown route -> 404', async () => {
  const c = client();
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
  assert.equal((await c.get('/api/nope')).status, 404);
});

test('login rate limit: 11th attempt in window -> 429', async () => {
  const c = client();
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await c.post('/api/auth/login', { email: 'ratelimit@example.com', password: 'wrongpass1' })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.equal(statuses[10], 429);
});

test('deploy safety: Vercel entry exports the app; on Vercel a local-file database is refused, a libsql:// one is accepted', async () => {
  const { execFile } = require('child_process');
  const run = (code, env) => new Promise((resolve) => {
    execFile(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, ...env } }, (err, out, errOut) => resolve({ code: err ? err.code : 0, out: out + errOut }));
  });
  const entry = require('../api/index.js');
  assert.equal(typeof entry, 'function');
  assert.equal(entry, require('../server')); // the same Express app, not a copy
  const refused = await run("require('./database')", { VERCEL: '1' });
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /TURSO_DATABASE_URL must be a libsql:\/\/ URL on Vercel/);
  const refusedFile = await run("require('./database')", { VERCEL: '1', TURSO_DATABASE_URL: 'file:local.db' });
  assert.notEqual(refusedFile.code, 0);
  const accepted = await run("require('./database'); console.log('ok')", { VERCEL: '1', TURSO_DATABASE_URL: 'libsql://example-db.turso.io', TURSO_AUTH_TOKEN: 'x' });
  assert.equal(accepted.code, 0, accepted.out);
  assert.match(accepted.out, /ok/);
  const local = await run("require('./database'); console.log('ok')", { TURSO_DATABASE_URL: 'file:/tmp/guard-test.db' }); // not on Vercel: files are fine
  assert.equal(local.code, 0, local.out);
});

test('expired sessions are rejected and removed', async () => {
  const c = await signedUp('expired@example.com');
  await db.client.execute("UPDATE sessions SET expires_at = 1 WHERE user_id = (SELECT id FROM users WHERE email = 'expired@example.com')");
  assert.equal((await c.get('/api/auth/me')).status, 401);
  const left = await db.client.execute('SELECT COUNT(*) n FROM sessions WHERE expires_at = 1');
  assert.equal(Number(left.rows[0].n), 0);
});
