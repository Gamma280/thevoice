// App Store adapter: resolve apps (iTunes Search/Lookup) and fetch customer reviews
// from Apple's public review feed (no key; ≤50/page, ≤10 pages ≈ 500 newest per country).
const { z } = require('zod');
const { fetchJson, UpstreamError } = require('./http');

const MAX_PAGES = 10;
const DAY_MS = 86400000;

const lookupSchema = z.object({
  results: z.array(
    z.object({
      trackId: z.number(),
      trackName: z.string(),
      artistName: z.string().optional().default(''),
      trackViewUrl: z.string().optional().default('')
    }).passthrough()
  )
}).passthrough();

const label = (v) => (v && typeof v === 'object' ? v.label : undefined);
const entrySchema = z.object({
  id: z.object({ label: z.string() }).passthrough(),
  updated: z.object({ label: z.string() }).passthrough().optional(),
  'im:rating': z.object({ label: z.string() }).passthrough().optional(),
  title: z.object({ label: z.string() }).passthrough().optional(),
  content: z.object({ label: z.string() }).passthrough().optional()
}).passthrough();
const feedSchema = z.object({ feed: z.object({ entry: z.union([z.array(z.unknown()), z.object({}).passthrough()]).optional() }).passthrough() });

const COUNTRY = /^[a-z]{2}$/;
const appUrl = (id, country) => `https://apps.apple.com/${country}/app/id${id}?see-all=reviews`;

// "Robinhood: Trading & Investing" -> "Robinhood" (the name people actually write in posts; used as the Reddit search term).
function brandName(name) {
  const first = String(name || '').split(/\s*[:–—|]\s*|\s+-\s+/)[0].trim().slice(0, 60);
  return first.length >= 3 ? first : String(name || '').trim().slice(0, 60);
}

function toCandidate(r, country) {
  return {
    type: 'app_store',
    external_id: String(r.trackId),
    country,
    label: `${r.trackName} (App Store, ${country.toUpperCase()})`,
    name: r.trackName,           // full store name = the "subject" shown next to each review
    subject: r.trackName,
    brand: brandName(r.trackName),
    developer: r.artistName || '',
    url: appUrl(r.trackId, country)
  };
}

// Pull storefront + app id out of an App Store URL or "id123456789".
function parseAppStoreQuery(q) {
  const id = q.match(/\bid(\d{5,15})\b/);
  if (!id) return null;
  const cc = q.match(/apps\.apple\.com\/([a-z]{2})\//i);
  return { id: id[1], country: cc ? cc[1].toLowerCase() : null };
}

// Re-validate several apps in ONE request per storefront (Apple accepts comma-separated ids).
// Never trust client-supplied labels/URLs. Returns Map(external_id -> candidate); unavailable apps are simply absent.
async function lookupMany(ids, country = 'us') {
  const valid = [...new Set(ids.map(String))].filter((id) => /^\d{5,15}$/.test(id));
  const found = new Map();
  if (!valid.length || !COUNTRY.test(country)) return found;
  const { json } = await fetchJson(`https://itunes.apple.com/lookup?id=${valid.join(',')}&country=${country}&entity=software`);
  const parsed = lookupSchema.safeParse(json);
  if (!parsed.success) throw new UpstreamError('App Store lookup returned an unexpected format');
  for (const r of parsed.data.results) {
    if (valid.includes(String(r.trackId))) found.set(String(r.trackId), toCandidate(r, country));
  }
  return found;
}

async function lookup(id, country = 'us') {
  return (await lookupMany([id], country)).get(String(id)) || null;
}

// `country` = the storefront to search (the founder's first target location; default 'us').
async function resolve(q, country = 'us') {
  if (!COUNTRY.test(country)) country = 'us';
  const direct = parseAppStoreQuery(q);
  if (direct) {
    const app = await lookup(direct.id, direct.country || country);
    return app ? [app] : [];
  }
  const { json } = await fetchJson(
    `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=software&limit=5&country=${country}`
  );
  const parsed = lookupSchema.safeParse(json);
  if (!parsed.success) throw new UpstreamError('App Store search returned an unexpected format');
  return parsed.data.results.map((r) => toCandidate(r, country));
}

// Fetch reviews newest-first. With `since` (last successful run) we stop once a page is entirely older.
async function collect(source, { since, maxPages = MAX_PAGES } = {}) {
  const country = COUNTRY.test(source.country) ? source.country : 'us';
  const items = [];
  const cutoff = since ? since - DAY_MS : null; // 1-day slack for clock/ordering skew
  for (let page = 1; page <= maxPages; page++) {
    let json;
    try {
      ({ json } = await fetchJson(
        `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${source.external_id}/sortby=mostrecent/json`
      ));
    } catch (err) {
      if (page > 1 && err instanceof UpstreamError && err.status >= 400 && err.status < 500) break; // ran past the last page
      throw err;
    }
    const feed = feedSchema.safeParse(json);
    if (!feed.success) throw new UpstreamError('App Store review feed returned an unexpected format');
    const raw = feed.data.feed.entry;
    const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
    // entries without a rating are app metadata, not reviews
    const reviews = entries.map((e) => entrySchema.safeParse(e)).filter((p) => p.success && p.data['im:rating']).map((p) => p.data);
    if (!reviews.length) break;
    let newest = 0;
    for (const e of reviews) {
      const published = e.updated ? Date.parse(e.updated.label) : NaN;
      if (Number.isFinite(published)) newest = Math.max(newest, published);
      const rating = parseInt(e['im:rating'].label, 10);
      items.push({
        external_id: e.id.label,
        kind: 'review',
        rating: Number.isInteger(rating) ? rating : null,
        title: label(e.title) || '',
        body: label(e.content) || '',
        published_at: Number.isFinite(published) ? published : null,
        url: appUrl(source.external_id, country)
      });
    }
    if (cutoff && newest && newest < cutoff) break; // nothing newer than our last run on this page
  }
  return { items, provider: 'itunes' };
}

module.exports = { resolve, lookup, lookupMany, collect, parseAppStoreQuery, brandName, MAX_PAGES };
