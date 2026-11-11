// OAuth 2.1 authorization server for Claude's "Add custom connector" screen.
// Public clients only (PKCE S256, no client secret), dynamic client registration (RFC 7591),
// discovery metadata (RFC 8414 / RFC 9728). The user signs in with their normal TheVoice session
// and approves on a consent page; Claude then holds a short-lived access token (tvo_…) plus a
// rotating refresh token (tvr_…). The static `tv_` API key keeps working for the mcp-remote bridge.
const crypto = require('crypto');
const express = require('express');
const db = require('./database');
const { sha256, baseUrl, loadUser, readCookie, COOKIE, rateLimit } = require('./auth');
const { HttpError } = require('./validation');

const CODE_MS = 5 * 60 * 1000;
const ACCESS_MS = 60 * 60 * 1000;
const REFRESH_MS = 90 * 24 * 3600 * 1000;
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:']);

const rand = (prefix) => `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
const ipKey = (req) => req.ip || 'unknown';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oauthError = (res, status, error, description) => res.status(status).json({ error, error_description: description });

// https, loopback http, or an app's custom scheme (claude://…). Never script-capable schemes; no fragments.
function validRedirectUri(raw) {
  if (typeof raw !== 'string' || raw.length > 500) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.hash || FORBIDDEN_SCHEMES.has(u.protocol)) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return true;
}

const cors = (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
};

const router = express.Router();
router.use(async (req, res, next) => { try { await db.init(); next(); } catch (err) { next(err); } });

// ---- discovery ----
const resourceMeta = (req, res) => {
  const base = baseUrl(req);
  res.json({ resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: ['mcp'] });
};
router.get('/.well-known/oauth-protected-resource', cors, resourceMeta);
router.get('/.well-known/oauth-protected-resource/mcp', cors, resourceMeta);
router.get('/.well-known/oauth-authorization-server', cors, (req, res) => {
  const base = baseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp']
  });
});

// ---- dynamic client registration ----
router.options(['/oauth/register', '/oauth/token'], cors);
router.post('/oauth/register', cors, rateLimit('oauth-register', ipKey, 30, 3600 * 1000), async (req, res, next) => {
  try {
    const body = req.body || {};
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(validRedirectUri)) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be 1–5 https, loopback http or app-scheme URIs.');
    }
    const name = typeof body.client_name === 'string' ? body.client_name.trim().slice(0, 80) : '';
    const clientId = rand('tvc_');
    await db.insertOAuthClient(clientId, name, [...new Set(uris)]);
    res.status(201).json({
      client_id: clientId, client_name: name, redirect_uris: [...new Set(uris)],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', client_id_issued_at: Math.floor(Date.now() / 1000)
    });
  } catch (err) { next(err); }
});

// ---- authorize (browser) ----
function page(res, status, title, bodyHtml, extraHead = '') {
  res.status(status).set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark"><title>${esc(title)} — TheVoice</title><link rel="stylesheet" href="/style.css">${extraHead}</head>
<body><header id="site-header"><div class="inner"><a class="logo" href="/">The<span>Voice</span></a></div></header>
<main class="container narrow">${bodyHtml}</main></body></html>`);
}

const consentToken = (req) => sha256(`oauth-consent:${readCookie(req, COOKIE) || ''}`);

// Validates the parts of the request that must be trusted before we may redirect anywhere.
async function loadAuthRequest(p) {
  const client = p.client_id ? await db.getOAuthClient(String(p.client_id)) : null;
  if (!client) return { fatal: 'This connection request is not valid (unknown application). Start again from Claude.' };
  if (!p.redirect_uri || !client.redirectUris.includes(String(p.redirect_uri))) {
    return { fatal: 'This connection request is not valid (redirect address not registered). Start again from Claude.' };
  }
  const challenge = String(p.code_challenge || '');
  let error = null;
  if (p.response_type !== 'code') error = ['unsupported_response_type', 'Only response_type=code is supported.'];
  else if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || p.code_challenge_method !== 'S256') error = ['invalid_request', 'PKCE with S256 is required.'];
  return { client, redirectUri: String(p.redirect_uri), challenge, state: p.state === undefined ? undefined : String(p.state).slice(0, 500), error };
}

function redirectTo(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}
// A 200 page with a meta refresh instead of a 302: Chrome applies `form-action` to redirects that follow a form POST.
function goBack(res, url) {
  page(res, 200, 'Returning to Claude', `<h1>Returning to Claude…</h1><p class="muted">If nothing happens, <a href="${esc(url)}">continue</a>.</p>`,
    `<meta http-equiv="refresh" content="0;url=${esc(url)}">`);
}

router.get('/oauth/authorize', async (req, res, next) => {
  try {
    const r = await loadAuthRequest(req.query);
    if (r.fatal) return page(res, 400, 'Cannot connect', `<h1>Cannot connect</h1><p class="muted">${esc(r.fatal)}</p>`);
    if (r.error) return res.redirect(redirectTo(r.redirectUri, { error: r.error[0], error_description: r.error[1], state: r.state }));
    const user = await loadUser(req);
    if (!user) return res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
    const hidden = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state']
      .filter((k) => req.query[k] !== undefined)
      .map((k) => `<input type="hidden" name="${k}" value="${esc(req.query[k])}">`).join('');
    page(res, 200, 'Connect Claude', `<h1>Connect ${esc(r.client.name || 'Claude')} to TheVoice?</h1>
<p class="muted">Signed in as <strong>${esc(user.email)}</strong>.</p>
<form method="post" action="/oauth/authorize" class="card stack">
<p><strong>${esc(r.client.name || 'This app')}</strong> will be able to read your founder profile, your collected audience quotes and your content history, and to save drafts and feedback for you. It cannot see your password or change your account.</p>
${hidden}<input type="hidden" name="csrf" value="${esc(consentToken(req))}">
<div class="actions"><button type="submit" name="decision" value="allow" class="btn">Allow</button>
<button type="submit" name="decision" value="deny" class="btn secondary">Cancel</button></div></form>
<p class="hint">You can revoke access any time by regenerating your key on the Connect page, or by removing the connector in Claude.</p>`);
  } catch (err) { next(err); }
});

router.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '20kb' }), async (req, res, next) => {
  try {
    const origin = req.headers.origin;
    if (origin) {
      let h; try { h = new URL(origin).host; } catch { h = null; }
      if (h !== (req.get('x-forwarded-host') || req.get('host'))) throw new HttpError(403, 'Cross-origin request blocked');
    }
    const user = await loadUser(req);
    if (!user) throw new HttpError(401, 'Not logged in');
    const given = Buffer.from(sha256(String(req.body.csrf || '')));
    if (!crypto.timingSafeEqual(given, Buffer.from(sha256(consentToken(req))))) throw new HttpError(403, 'Invalid or expired form. Start again from Claude.');
    const r = await loadAuthRequest(req.body);
    if (r.fatal) return page(res, 400, 'Cannot connect', `<h1>Cannot connect</h1><p class="muted">${esc(r.fatal)}</p>`);
    if (r.error) return goBack(res, redirectTo(r.redirectUri, { error: r.error[0], error_description: r.error[1], state: r.state }));
    if (req.body.decision !== 'allow') return goBack(res, redirectTo(r.redirectUri, { error: 'access_denied', state: r.state }));
    const code = rand('tvk_');
    await db.insertOAuthCode(sha256(code), r.client.clientId, user.id, r.redirectUri, r.challenge, Date.now() + CODE_MS);
    goBack(res, redirectTo(r.redirectUri, { code, state: r.state }));
  } catch (err) { next(err); }
});

// ---- token ----
async function issueTokens(res, clientId, userId) {
  const access = rand('tvo_'), refresh = rand('tvr_');
  const now = Date.now();
  await db.insertOAuthToken(sha256(access), sha256(refresh), clientId, userId, now + ACCESS_MS, now + REFRESH_MS);
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).json({
    access_token: access, token_type: 'Bearer', expires_in: ACCESS_MS / 1000, refresh_token: refresh, scope: 'mcp'
  });
}

router.post('/oauth/token', cors, express.urlencoded({ extended: false, limit: '20kb' }),
  rateLimit('oauth-token', ipKey, 120, 15 * 60 * 1000), async (req, res, next) => {
    try {
      const b = req.body || {};
      const clientId = String(b.client_id || '');
      if (b.grant_type === 'authorization_code') {
        const verifier = String(b.code_verifier || '');
        const row = b.code ? await db.consumeOAuthCode(sha256(String(b.code))) : null;
        const challenge = /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ? crypto.createHash('sha256').update(verifier).digest('base64url') : null;
        if (!row || row.expiresAt < Date.now() || row.clientId !== clientId || row.redirectUri !== String(b.redirect_uri || '') || row.challenge !== challenge) {
          return oauthError(res, 400, 'invalid_grant', 'The authorization code is invalid, expired, or already used.');
        }
        return issueTokens(res, row.clientId, row.userId);
      }
      if (b.grant_type === 'refresh_token') {
        const row = b.refresh_token ? await db.consumeOAuthRefresh(sha256(String(b.refresh_token))) : null;
        if (!row || row.refreshExpiresAt < Date.now() || row.clientId !== clientId) {
          return oauthError(res, 400, 'invalid_grant', 'The refresh token is invalid or expired. Reconnect TheVoice in Claude.');
        }
        return issueTokens(res, row.clientId, row.userId);
      }
      oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
    } catch (err) { next(err); }
  });

module.exports = { oauthRouter: router };
