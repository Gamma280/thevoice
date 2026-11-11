const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./database');
const { HttpError, parse, signupSchema, loginSchema } = require('./validation');

const COOKIE = 'tv_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('timing-parity', 10);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;
const isProd = () => process.env.NODE_ENV === 'production';

// ---- cookies ----
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: isProd(), path: '/', maxAge: SESSION_MS
  });
}
const clearSessionCookie = (res) =>
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: isProd(), path: '/' });

// ---- sessions ----
async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.insertSession(sha256(token), userId, Date.now() + SESSION_MS);
  setSessionCookie(res, token);
}

async function loadUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const row = await db.getSessionUser(sha256(token));
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    await db.deleteSession(sha256(token));
    return null;
  }
  return { id: Number(row.id), email: row.email, hasProfile: Boolean(row.has_profile) };
}

async function requireAuth(req, res, next) {
  try {
    const user = await loadUser(req);
    if (!user) return next(new HttpError(401, 'Not logged in'));
    req.user = user;
    req.userId = user.id;
    next();
  } catch (err) {
    next(err);
  }
}

// ---- request guards ----
// CSRF defence for cookie-authenticated routes: JSON content type + same-origin Origin header.
function csrfGuard(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    return next(new HttpError(415, 'Content-Type must be application/json'));
  }
  const origin = req.headers.origin;
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).host; } catch { originHost = null; }
    const host = req.get('x-forwarded-host') || req.get('host');
    if (originHost !== host) return next(new HttpError(403, 'Cross-origin request blocked'));
  }
  next();
}

// DB-backed fixed-window limiter; works across serverless instances.
function rateLimit(name, keyFn, max = MAX_ATTEMPTS, windowMs = WINDOW_MS) {
  return async (req, res, next) => {
    try {
      const key = keyFn(req);
      if (!key) return next();
      const count = await db.hitRateLimit(`${name}:${key}`, windowMs);
      if (count > max) {
        res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
        return next(new HttpError(429, 'Too many attempts. Try again later.'));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
const ipKey = (req) => req.ip || 'unknown';
const userKey = (req) => (req.userId ? String(req.userId) : null);

// MCP auth: `Authorization: Bearer tv_…` → user. Unknown/revoked/malformed keys all look identical (401).
async function requireApiKey(req, res, next) {
  const fail = () => {
    // resource_metadata tells OAuth-capable clients (Claude's custom connector) where to start sign-in.
    res.set('WWW-Authenticate', `Bearer realm="thevoice", resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`);
    return next(new HttpError(401, 'Unauthorized'));
  };
  try {
    const m = /^Bearer (tvo?_[A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
    if (!m) return fail();
    if (m[1].startsWith('tvo_')) { // OAuth access token (Claude's custom connector)
      const tok = await db.findOAuthAccessToken(sha256(m[1]));
      if (!tok) return fail();
      req.userId = tok.userId;
      return next();
    }
    const key = await db.findActiveApiKey(sha256(m[1]));
    if (!key) return fail();
    await db.touchApiKey(key.id);
    req.userId = key.userId;
    next();
  } catch (err) {
    next(err);
  }
}

// Scheduler auth: constant-time compare of a Bearer secret. Fails closed when unset.
function requireCron(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return next(new HttpError(503, 'Cron is not configured'));
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(sha256(given));
  const b = Buffer.from(sha256(secret));
  if (!crypto.timingSafeEqual(a, b)) return next(new HttpError(401, 'Unauthorized'));
  next();
}
const emailKey = (req) => (typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : null);

// ---- routes ----
const authRouter = express.Router();

authRouter.post('/signup', rateLimit('signup-ip', ipKey), async (req, res, next) => {
  try {
    const { email, password } = parse(signupSchema, req.body);
    const hash = await bcrypt.hash(password, 10);
    let userId;
    try {
      userId = await db.createUser(email, hash);
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) throw new HttpError(409, 'Could not create an account with that email');
      throw err;
    }
    await startSession(res, userId);
    res.status(201).json({ id: userId, email, hasProfile: false });
  } catch (err) {
    next(err);
  }
});

authRouter.post(
  '/login',
  rateLimit('login-ip', ipKey),
  rateLimit('login-email', emailKey),
  async (req, res, next) => {
    try {
      const { email, password } = parse(loginSchema, req.body);
      const user = await db.getUserByEmail(email);
      const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
      if (!user || !ok) throw new HttpError(401, 'Invalid email or password');
      await startSession(res, Number(user.id));
      const profile = await db.getFounder(Number(user.id));
      res.json({ id: Number(user.id), email: user.email, hasProfile: Boolean(profile) });
    } catch (err) {
      next(err);
    }
  }
);

authRouter.post('/logout', async (req, res, next) => {
  try {
    const token = readCookie(req, COOKIE);
    if (token) await db.deleteSession(sha256(token));
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, (req, res) => res.json(req.user));

// ---- MCP API key management (cookie-authenticated; Phase 3 adds requireApiKey) ----
const keyRouter = express.Router();

keyRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const key = await db.getActiveApiKey(req.userId);
    res.json(key ? { exists: true, prefix: key.key_prefix, created_at: key.created_at, last_used_at: key.last_used_at } : { exists: false });
  } catch (err) {
    next(err);
  }
});

keyRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const key = `tv_${crypto.randomBytes(32).toString('base64url')}`;
    await db.rotateApiKey(req.userId, sha256(key), key.slice(0, 8));
    res.status(201).json({ key, prefix: key.slice(0, 8), note: 'Store this key now; it will not be shown again.' });
  } catch (err) {
    next(err);
  }
});

module.exports = { baseUrl, loadUser, readCookie, COOKIE, authRouter, keyRouter, requireAuth, requireApiKey, requireCron, csrfGuard, rateLimit, userKey, sha256 };
