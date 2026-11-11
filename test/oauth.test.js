const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thevoice-oauth-test-'));
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.NODE_ENV = 'test';
for (const k of ['REDDIT_PROVIDER', 'CRON_SECRET']) delete process.env[k];

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const app = require('../server');
const db = require('../database');

let server, base, n = 0;
before(async () => {
  await db.init();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.client.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const ip = () => `10.9.0.${++n}`;
const form = (o) => new URLSearchParams(o).toString();
const b64 = (b) => b.toString('base64url');

async function signup() {
  const r = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() },
    body: JSON.stringify({ email: `o${++n}@example.com`, password: 'password123' })
  });
  assert.equal(r.status, 201);
  return r.headers.get('set-cookie').split(';')[0];
}
async function register(redirect_uris = [REDIRECT]) {
  const r = await fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris })
  });
  return { status: r.status, json: await r.json() };
}
function pkce() {
  const verifier = b64(crypto.randomBytes(32));
  return { verifier, challenge: b64(crypto.createHash('sha256').update(verifier).digest()) };
}
const authUrl = (c, p, extra = {}) => `${base}/oauth/authorize?${form({
  response_type: 'code', client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256', state: 'xyz', ...extra })}`;

// Runs the consent step like a browser: GET page, pull the csrf token, POST the decision.
async function consent(cookie, url, decision = 'allow') {
  const page = await fetch(url, { headers: { cookie }, redirect: 'manual' });
  assert.equal(page.status, 200);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const u = new URL(url);
  const body = { ...Object.fromEntries(u.searchParams), csrf, decision };
  const r = await fetch(`${base}/oauth/authorize`, { method: 'POST', headers: { cookie, origin: 'null', 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });
  const out = await r.text();
  const href = /<a href="([^"]+)">continue/.exec(out);
  return { status: r.status, url: href ? new URL(href[1].replace(/&amp;/g, '&')) : null };
}
const token = (o) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip() }, body: form(o) });
const mcpCall = (t) => fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${t}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
});

test('discovery: 401 points at metadata; metadata describes the endpoints', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);
  const res = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(res.resource, `${base}/mcp`);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.authorization_endpoint, `${base}/oauth/authorize`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.registration_endpoint, `${base}/oauth/register`);
});

test('register rejects unsafe redirect URIs', async () => {
  for (const bad of [[], ['javascript:alert(1)'], ['http://evil.example/cb'], ['https://x.example/cb#frag'], ['not a url']]) {
    const r = await register(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.error, 'invalid_redirect_uri');
  }
  assert.equal((await register(['http://localhost:6274/cb'])).status, 201);
  assert.equal((await register(['claude://auth/callback'])).status, 201);
});

test('full flow: login → consent → code → token → /mcp works, refresh rotates', async () => {
  const cookie = await signup();
  const c = (await register()).json, p = pkce();
  const anon = await fetch(authUrl(c, p), { redirect: 'manual' });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get('location'), /^\/login\.html\?next=%2Foauth%2Fauthorize%3F/);

  const { url } = await consent(cookie, authUrl(c, p));
  assert.equal(url.origin + url.pathname, REDIRECT);
  assert.equal(url.searchParams.get('state'), 'xyz');
  const code = url.searchParams.get('code');

  const t = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: c.client_id, code_verifier: p.verifier });
  assert.equal(t.status, 200);
  const tok = await t.json();
  assert.match(tok.access_token, /^tvo_/);
  assert.equal(tok.token_type, 'Bearer');

  // the real MCP SDK client works with the OAuth token
  const client = new Client({ name: 'oauth-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } } }));
  assert.equal((await client.listTools()).tools.length, 5);
  await client.close();

  // code is single use
  const again = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: c.client_id, code_verifier: p.verifier });
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error, 'invalid_grant');

  // refresh rotates: new tokens work, old refresh + old access are dead
  const rt = await token({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: c.client_id });
  assert.equal(rt.status, 200);
  const tok2 = await rt.json();
  assert.notEqual(tok2.access_token, tok.access_token);
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: c.client_id })).status, 400);
  assert.equal((await mcpCall(tok.access_token)).status, 401);
  assert.equal((await mcpCall(tok2.access_token)).status, 200);
});

test('token endpoint refuses wrong verifier, wrong client, wrong redirect, expired code', async () => {
  const cookie = await signup();
  const c = (await register()).json, other = (await register()).json, p = pkce();
  const get = async () => (await consent(cookie, authUrl(c, p))).url.searchParams.get('code');
  const good = { grant_type: 'authorization_code', redirect_uri: REDIRECT, client_id: c.client_id, code_verifier: p.verifier };
  assert.equal((await token({ ...good, code: await get(), code_verifier: pkce().verifier })).status, 400);
  assert.equal((await token({ ...good, code: await get(), client_id: other.client_id })).status, 400);
  assert.equal((await token({ ...good, code: await get(), redirect_uri: 'https://claude.ai/other' })).status, 400);
  const code = await get();
  await db.client.execute({ sql: 'UPDATE oauth_codes SET expires_at = 1', args: [] });
  assert.equal((await token({ ...good, code })).status, 400);
  assert.equal((await token({ grant_type: 'password' })).status, 400);
});

test('authorize: bad client/redirect never redirects; missing PKCE redirects with an error', async () => {
  const cookie = await signup();
  const c = (await register()).json, p = pkce();
  const bad1 = await fetch(authUrl(c, p, { client_id: 'tvc_nope' }), { headers: { cookie }, redirect: 'manual' });
  assert.equal(bad1.status, 400);
  const bad2 = await fetch(authUrl(c, p, { redirect_uri: 'https://evil.example/cb' }), { headers: { cookie }, redirect: 'manual' });
  assert.equal(bad2.status, 400);
  const nopkce = await fetch(authUrl(c, p, { code_challenge_method: 'plain' }), { headers: { cookie }, redirect: 'manual' });
  assert.equal(nopkce.status, 302);
  assert.match(nopkce.headers.get('location'), /error=invalid_request/);
});

test('deny returns access_denied; consent POST needs the csrf token, a session and same origin', async () => {
  const cookie = await signup();
  const c = (await register()).json, p = pkce();
  const denied = await consent(cookie, authUrl(c, p), 'deny');
  assert.equal(denied.url.searchParams.get('error'), 'access_denied');
  assert.equal(denied.url.searchParams.get('code'), null);
  const u = new URL(authUrl(c, p));
  const body = form({ ...Object.fromEntries(u.searchParams), decision: 'allow', csrf: 'forged' });
  const post = (headers) => fetch(`${base}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
  assert.equal((await post({ cookie })).status, 403);
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ cookie, origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ cookie, 'sec-fetch-site': 'cross-site' })).status, 403);
  // a null Origin (same-site form post under no-referrer) is not rejected for being cross-origin: it reaches the csrf check
  const withNull = await post({ cookie, origin: 'null' });
  assert.equal(withNull.status, 403);
  assert.match((await withNull.json()).error, /Invalid or expired form/);
});

test('consent page escapes the client name; a tv_ API key still works', async () => {
  const cookie = await signup();
  const r = await fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() },
    body: JSON.stringify({ client_name: '<img src=x onerror=alert(1)>', redirect_uris: [REDIRECT] })
  });
  const c = await r.json(), p = pkce();
  const html = await (await fetch(authUrl(c, p), { headers: { cookie } })).text();
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x'));
  const key = (await (await fetch(`${base}/api/mcp-key`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).json()).key;
  assert.equal((await mcpCall(key)).status, 200);
});
