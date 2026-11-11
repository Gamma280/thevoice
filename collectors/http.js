// The ONLY place outbound HTTP happens. Fixed host allowlist (SSRF boundary), HTTPS only,
// timeout, size cap, retries with backoff + jitter, Retry-After, per-host concurrency + spacing.
// Never logs headers, bodies or full URLs (they may carry tokens or user-chosen names).

const ALLOWED_HOSTS = new Set([
  'itunes.apple.com',
  'www.reddit.com',
  'oauth.reddit.com',
  'arctic-shift.photon-reddit.com'
]);
// Minimum spacing between request starts per host (Reddit throttles unauthenticated clients hard).
const HOST_GAP_MS = { 'www.reddit.com': 2500, 'oauth.reddit.com': 1000, 'arctic-shift.photon-reddit.com': 500 };
const MAX_CONCURRENCY = 2;
const MAX_RETRY_AFTER_MS = 30000;

class UpstreamError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryable = retryable;
  }
}

const state = {
  fetchImpl: (...args) => fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now()
};
const hosts = new Map();

// Tests inject fetch/sleep/now so nothing touches the network or waits.
function configure(overrides) { Object.assign(state, overrides); }
function reset() {
  state.fetchImpl = (...args) => fetch(...args);
  state.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  state.now = () => Date.now();
  hosts.clear();
}

const userAgent = () => `TheVoice/1.0 (+${process.env.BASE_URL || 'https://thevoice.example'})`;

async function acquire(host, gapOverride) {
  const h = hosts.get(host) || { active: 0, nextAt: 0 };
  hosts.set(host, h);
  while (h.active >= MAX_CONCURRENCY) await state.sleep(25);
  h.active += 1;
  const gap = gapOverride ?? (HOST_GAP_MS[host] || 0); // gapOverride: how long the NEXT request to this host must wait
  const startAt = Math.max(state.now(), h.nextAt);
  h.nextAt = startAt + gap;
  const wait = startAt - state.now();
  if (wait > 0) await state.sleep(wait);
  return () => { h.active -= 1; };
}

async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (declared && declared > maxBytes) throw new UpstreamError('Response too large', { status: res.status });
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    if (t.length > maxBytes) throw new UpstreamError('Response too large', { status: res.status });
    return t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new UpstreamError('Response too large', { status: res.status });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

function retryDelay(res, attempt) {
  const ra = res && Number(res.headers.get('retry-after'));
  if (ra && Number.isFinite(ra)) return Math.min(ra * 1000, MAX_RETRY_AFTER_MS);
  // Arctic Shift answers 422 "Timeout. Maybe slow down a bit" when it is overloaded: give it a few seconds, not 0.5 s.
  if (res && res.status === 422) return 3000 * (attempt + 1) + Math.floor(Math.random() * 500);
  return Math.min(500 * 2 ** attempt + Math.floor(Math.random() * 250), MAX_RETRY_AFTER_MS);
}

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 8000, maxBytes = 2 * 1024 * 1024, retries = 2, gapMs } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new UpstreamError('Invalid URL'); }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new UpstreamError('Blocked request to a host that is not allowed');
  }
  const host = u.hostname;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const release = await acquire(host, gapMs);
    let res;
    try {
      res = await state.fetchImpl(url, {
        method,
        headers: { 'user-agent': userAgent(), accept: 'application/json, application/atom+xml, text/xml, */*', ...headers },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.url) {
        try {
          if (!ALLOWED_HOSTS.has(new URL(res.url).hostname)) throw new UpstreamError('Redirected to a host that is not allowed');
        } catch (e) { if (e instanceof UpstreamError) throw e; }
      }
      if (res.status >= 200 && res.status < 300) {
        const text = await readLimited(res, maxBytes);
        return { status: res.status, headers: res.headers, text };
      }
      const retryable = res.status === 429 || res.status >= 500 || (host === 'arctic-shift.photon-reddit.com' && res.status === 422);
      lastError = new UpstreamError(`${host} responded ${res.status}`, { status: res.status, retryable });
      if (!retryable) throw lastError;
    } catch (err) {
      if (err instanceof UpstreamError && !err.retryable) throw err;
      if (!(err instanceof UpstreamError)) {
        // network error / timeout
        lastError = new UpstreamError(`${host} request failed (${err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network'})`, { retryable: true });
      }
    } finally {
      release();
    }
    if (attempt < retries) await state.sleep(retryDelay(res, attempt));
  }
  throw lastError;
}

async function fetchText(url, opts) { return (await request(url, opts)).text; }

async function fetchJson(url, opts) {
  const r = await request(url, opts);
  try {
    return { json: JSON.parse(r.text), headers: r.headers, status: r.status };
  } catch {
    throw new UpstreamError(`${new URL(url).hostname} returned invalid JSON`, { status: r.status });
  }
}

module.exports = { request, fetchJson, fetchText, configure, reset, UpstreamError, ALLOWED_HOSTS };
