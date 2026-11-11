require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const db = require('./database');
const { init } = db;
const { authRouter, keyRouter, requireAuth, requireApiKey, requireCron, csrfGuard, rateLimit, userKey } = require('./auth');
const { handleMcp } = require('./mcp-server');
const appstore = require('./collectors/appstore');
const reddit = require('./collectors/reddit');
const { runDue } = require('./collectors');
const {
  HttpError, parse, profileSchema, contentSchema, contentUpdateSchema, feedbackSchema,
  resolveQuerySchema, sourceFollowSchema, quotesQuerySchema, suggestQuerySchema, locationModeSchema, MAX_COMMUNITIES
} = require('./validation');
const { COUNTRIES, countryName, locationKey, slug, subredditRelatedTo } = require('./locations');
const { keywordKey } = require('./keywords');

const app = express();
app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
        // only force https upgrades in production so plain-http localhost works
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
      }
    }
  })
);
app.use(express.json({ limit: '100kb' }));
// extensions:['html'] mirrors Vercel's cleanUrls locally (/dashboard -> dashboard.html)
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/health', async (req, res, next) => {
  try {
    await init();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});


// ---------------------------------------------------------------------------
// MCP (Bearer API key — not cookies, so no CSRF surface). Stateless Streamable HTTP, POST only.
// ---------------------------------------------------------------------------
const ensureDb = async (req, res, next) => { try { await init(); next(); } catch (err) { next(err); } };
app.post('/mcp', ensureDb, requireApiKey, rateLimit('mcp', userKey, 300, 60000), handleMcp);
app.all('/mcp', (req, res) => {
  res.set('Allow', 'POST').status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});

// ---------------------------------------------------------------------------
// API (cookie session auth). Everything under /api is user-scoped.
// ---------------------------------------------------------------------------
const api = express.Router();
api.use(csrfGuard);
api.use(async (req, res, next) => {
  try { await init(); next(); } catch (err) { next(err); }
});

api.use('/auth', authRouter);
api.use('/mcp-key', keyRouter);

// "Not yours" and "doesn't exist" are indistinguishable on purpose.
const parseId = (raw) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'Not found');
  return id;
};
const notFound = () => new HttpError(404, 'Not found');

const HOUR = 3600000;
const MANUAL_BUDGET_MS = 25000;
const CRON_BUDGET_MS = Number(process.env.COLLECT_BUDGET_MS) || 240000;
const upstream = (err, what) => (err instanceof HttpError ? err : new HttpError(502, `Could not reach ${what}. Try again shortly.`));

const redditInfo = () => ({ enabled: reddit.isEnabled(), provider: reddit.mode() });
const communityLabel = (name) => `r/${name}`;

async function upsertCommunity(name) {
  return db.upsertSource({
    type: 'reddit', external_id: name.toLowerCase(), country: '',
    label: communityLabel(name), url: `https://www.reddit.com/r/${name}/`
  });
}

// Group the founder's App Store sources into competitor apps (one entry per app, listing its countries).
function summarizeCompetitors(sources) {
  const apps = new Map();
  for (const x of sources) {
    if (x.role !== 'competitor' || x.type !== 'app_store') continue;
    const name = x.subject || x.label;
    const a = apps.get(x.external_id) || { external_id: x.external_id, name, brand: appstore.brandName(name), countries: [] };
    if (!a.countries.includes(x.country)) a.countries.push(x.country);
    apps.set(x.external_id, a);
  }
  return { competitors: [...apps.values()], competitor_mentions: sources.some((x) => x.type === 'reddit_search') };
}

const MIN_SUGGEST_SUBSCRIBERS = 1000;
const findLocation = (locations, country, region = '') => locations.find((l) => locationKey(l) === locationKey({ country, region }));

// Profile + locations + source links. Network lookups happen BEFORE any write so a failure never half-saves.
api.post('/setup', requireAuth, async (req, res, next) => {
  try {
    const body = parse(profileSchema, req.body);
    const userId = req.userId;
    const currentLocations = body.locations ? null : await db.listLocations(userId);
    const finalLocations = body.locations || currentLocations; // submitted ones have no ids yet

    // Community checks that need the final location set.
    const communities = body.communities;
    if (communities && communities.length && !reddit.isEnabled()) {
      throw new HttpError(400, 'Reddit collection is disabled on this server');
    }
    for (const [i, c] of (communities || []).entries()) {
      if (c.country && !findLocation(finalLocations, c.country, c.region)) {
        throw new HttpError(400, 'Invalid input', [{ field: `communities.${i}`, message: 'Community location must match one of your locations' }]);
      }
    }

    // Competitor apps (up to 5) are looked up in EVERY target storefront (App Store reviews are country-level).
    // One batched Apple request per country; all lookups happen before any write.
    const existing = await db.listUserSources(userId);
    const existingApps = [...new Set(existing.filter((x) => x.role === 'competitor' && x.type === 'app_store').map((x) => x.external_id))];
    const existingMentions = existing.some((x) => x.type === 'reddit_search');
    const relink = body.competitor_sources !== undefined || body.locations !== undefined || body.competitor_mentions !== undefined;
    const appIds = body.competitor_sources ? body.competitor_sources.map((x) => x.external_id) : existingApps;
    const mentionsWanted = body.competitor_mentions ?? existingMentions;
    if (body.competitor_mentions === true && !reddit.isEnabled()) throw new HttpError(400, 'Reddit collection is disabled on this server');

    const candidates = [];
    const warnings = [];
    if (relink && appIds.length) {
      const countries = finalLocations.length
        ? [...new Set(finalLocations.map((l) => l.country))]
        : [...new Set((body.competitor_sources || []).map((x) => x.country || 'us'))];
      if (!countries.length) countries.push('us');
      const names = new Map();
      const missing = [];
      for (const country of countries) {
        let found;
        try { found = await appstore.lookupMany(appIds, country); } catch (err) { throw upstream(err, 'the App Store'); }
        for (const id of appIds) {
          const cand = found.get(id);
          if (cand) { candidates.push(cand); names.set(id, cand.name); } else missing.push({ id, country });
        }
      }
      for (const m of missing) {
        warnings.push({ field: 'competitor_sources', country: m.country, message: `${names.get(m.id) || `App ${m.id}`} isn’t available in the ${countryName(m.country)} App Store` });
      }
      const unavailable = appIds.filter((id) => !names.has(id));
      if (unavailable.length) {
        throw new HttpError(400, 'Invalid input', [{ field: 'competitor_sources', message: finalLocations.length ? `App ${unavailable[0]} isn’t available in any selected country` : 'App not found' }]);
      }
    }

    const founder = await db.upsertFounder(userId, body);
    const locations = body.locations ? await db.replaceLocations(userId, body.locations) : currentLocations;

    if (relink) {
      const entries = [];
      const brands = new Map();
      for (const cand of candidates) {
        const sourceId = await db.upsertSource(cand);
        entries.push({ sourceId, locationId: locations.find((l) => l.country === cand.country)?.id ?? null });
        brands.set(cand.brand.toLowerCase(), cand.brand);
      }
      // Reddit complaints about each competitor: one global search source per app brand (not tied to a location)
      if (mentionsWanted && reddit.isEnabled()) {
        for (const [key, brand] of brands) {
          const sourceId = await db.upsertSource({
            type: 'reddit_search', external_id: key, country: '', subject: brand,
            label: `Reddit: complaints about “${brand}”`,
            url: `https://www.reddit.com/search/?q=${encodeURIComponent(`"${brand}"`)}&sort=new&t=month`
          });
          entries.push({ sourceId, locationId: null });
        }
      }
      await db.replaceFounderSources(userId, 'competitor', entries);
    }
    if (communities) {
      const entries = [];
      for (const c of communities) {
        const sourceId = await upsertCommunity(c.name);
        entries.push({ sourceId, locationId: c.country ? findLocation(locations, c.country, c.region)?.id ?? null : null });
      }
      await db.replaceFounderSources(userId, 'community', entries);
    }
    // Problems to find in their users: saved always (they also highlight matching quotes everywhere);
    // one shared Reddit-wide search source per problem when Reddit collection is on.
    if (body.problem_keywords !== undefined) {
      const kws = await db.replaceKeywords(userId, body.problem_keywords);
      const entries = [];
      if (reddit.isEnabled()) {
        for (const k of kws) {
          const sourceId = await db.upsertSource({
            type: 'reddit_keyword', external_id: keywordKey(k), country: '', subject: k,
            label: `Reddit: “${k}”`, url: `https://www.reddit.com/search/?q=${encodeURIComponent(k)}&sort=new&t=month`
          });
          entries.push({ sourceId, locationId: null });
        }
      }
      await db.replaceFounderSources(userId, 'keyword', entries);
    }
    const sources = await db.listUserSources(userId);
    res.json({ ...founder, locations, keywords: await db.listKeywords(userId), sources, ...summarizeCompetitors(sources), warnings });
  } catch (err) { next(err); }
});

api.get('/founder', requireAuth, async (req, res, next) => {
  try {
    const founder = await db.getFounder(req.userId);
    if (!founder) throw notFound();
    const sources = await db.listUserSources(req.userId);
    res.json({ ...founder, locations: await db.listLocations(req.userId), keywords: await db.listKeywords(req.userId), sources, ...summarizeCompetitors(sources) });
  } catch (err) { next(err); }
});

// ---- locations ----
api.get('/countries', requireAuth, (req, res) => res.json(COUNTRIES));

// Switch between "only my locations" (strict) and "everything I follow" (all).
api.post('/location-mode', requireAuth, async (req, res, next) => {
  try {
    const { location_mode } = parse(locationModeSchema, req.body);
    if (!(await db.setLocationMode(req.userId, location_mode))) throw notFound();
    res.json({ location_mode });
  } catch (err) { next(err); }
});

// Suggest LOCAL subreddits for a location (Reddit has no location filter; local communities are the proxy).
api.get('/locations/suggest', requireAuth, rateLimit('suggest', userKey, 30, HOUR), async (req, res, next) => {
  try {
    const { country, region } = parse(suggestQuerySchema, req.query);
    if (!reddit.isEnabled()) return res.json({ suggestions: [], note: 'Reddit collection is disabled on this server.' });
    const terms = [...(region ? [{ term: region, scope: 'region' }] : []), { term: countryName(country), scope: 'country' }];
    const found = new Map();
    let failures = 0;
    for (const { term, scope } of terms) {
      try {
        for (const sub of await reddit.searchSubreddits(term)) {
          const key = sub.name.toLowerCase();
          if (sub.subscribers < MIN_SUGGEST_SUBSCRIBERS || found.has(key)) continue;
          found.set(key, { name: sub.name, subscribers: sub.subscribers, scope, exact: slug(sub.name) === slug(term), country, region });
        }
      } catch { failures += 1; }
    }
    if (failures === terms.length) {
      return res.json({ suggestions: [], note: 'Could not search Reddit right now. You can type a subreddit name instead.' });
    }
    const rank = (scope) => [...found.values()].filter((s) => s.scope === scope)
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.subscribers - a.subscribers).slice(0, 3);
    res.json({ suggestions: [...rank('region'), ...rank('country')].map(({ exact, ...s }) => s) });
  } catch (err) { next(err); }
});

// ---- sources ----
api.get('/sources/resolve', requireAuth, rateLimit('resolve', userKey, 30, HOUR), async (req, res, next) => {
  try {
    const { q, country } = parse(resolveQuerySchema, req.query);
    // Search the founder's first target storefront unless a country is given.
    const storefront = country || (await db.listLocations(req.userId))[0]?.country || 'us';
    try { res.json(await appstore.resolve(q, storefront)); } catch (err) { throw upstream(err, 'the App Store'); }
  } catch (err) { next(err); }
});

// Company-grouped view for the Sources page: per competitor → its App Store entry per picked country + its Reddit
// complaints (status, count, and the SPECIFIC subreddits they came from, flagged when they look related to your countries).
api.get('/competitors', requireAuth, async (req, res, next) => {
  try {
    const [sources, locations] = await Promise.all([db.listUserSources(req.userId), db.listLocations(req.userId)]);
    const { competitors } = summarizeCompetitors(sources);
    const slim = (x) => ({ source_id: x.id, status: x.last_status, last_error: x.last_error, last_collected_at: x.last_collected_at, quote_count: x.quote_count, url: x.url });
    const out = [];
    for (const c of competitors) {
      const stores = sources.filter((x) => x.type === 'app_store' && x.role === 'competitor' && x.external_id === c.external_id)
        .map((x) => ({ ...slim(x), country: x.country, country_name: countryName(x.country) }));
      const m = sources.find((x) => x.type === 'reddit_search' && (x.subject || '').toLowerCase() === c.brand.toLowerCase());
      let redditInfo = null;
      if (m) {
        const subs = await db.subredditCounts(m.id);
        redditInfo = { ...slim(m), search_term: m.subject, subreddits: subs.map((x) => ({ ...x, related: subredditRelatedTo(x.name, locations) })) };
      }
      out.push({ external_id: c.external_id, name: c.name, brand: c.brand, countries: c.countries.map((code) => ({ code, name: countryName(code) })), stores, reddit: redditInfo });
    }
    res.json({
      competitors: out,
      locations: locations.map((l) => ({ ...l, country_name: countryName(l.country) })),
      reddit: redditInfo()
    });
  } catch (err) { next(err); }
});

// The problems the founder is tracking: each one's Reddit search status, where its matching posts came from, and how many
// of their quotes match it overall (any source — so it works even while Reddit-wide search is blocked).
api.get('/problems', requireAuth, async (req, res, next) => {
  try {
    const [keywords, sources] = await Promise.all([db.listKeywords(req.userId), db.listUserSources(req.userId)]);
    const out = [];
    for (const k of keywords) {
      const src = sources.find((x) => x.type === 'reddit_keyword' && x.external_id === keywordKey(k));
      out.push({
        keyword: k,
        matching_quotes: await db.countKeywordMatches(req.userId, k),
        search: src ? {
          source_id: src.id, status: src.last_status, last_error: src.last_error, last_collected_at: src.last_collected_at,
          quote_count: src.quote_count, url: src.url, subreddits: await db.subredditCounts(src.id)
        } : null
      });
    }
    res.json({ problems: out, reddit: redditInfo() });
  } catch (err) { next(err); }
});

api.get('/sources', requireAuth, async (req, res, next) => {
  try {
    const founder = await db.getFounder(req.userId);
    res.json({
      sources: await db.listUserSources(req.userId),
      reddit: redditInfo(),
      locations: await db.listLocations(req.userId),
      location_mode: founder ? founder.location_mode : 'strict'
    });
  } catch (err) { next(err); }
});

api.post('/sources', requireAuth, async (req, res, next) => {
  try {
    const { external_id: name, country, region } = parse(sourceFollowSchema, req.body);
    if (!reddit.isEnabled()) throw new HttpError(400, 'Reddit collection is disabled on this server');
    let locationId = null;
    if (country) {
      const loc = findLocation(await db.listLocations(req.userId), country, region);
      if (!loc) throw new HttpError(400, 'Invalid input', [{ field: 'country', message: 'Community location must match one of your locations' }]);
      locationId = loc.id;
    }
    if ((await reddit.resolve(name)) === false) {
      throw new HttpError(400, 'Invalid input', [{ field: 'external_id', message: 'Subreddit not found' }]);
    }
    const sourceId = await upsertCommunity(name);
    if (!(await db.isFollowing(req.userId, sourceId))) {
      if ((await db.countCommunities(req.userId)) >= MAX_COMMUNITIES) {
        throw new HttpError(400, `You can follow at most ${MAX_COMMUNITIES} communities`);
      }
      await db.followSource(req.userId, sourceId, 'community', locationId);
    }
    const mine = (await db.listUserSources(req.userId)).find((s) => s.id === sourceId);
    res.status(201).json(mine);
  } catch (err) { next(err); }
});

api.delete('/sources/:id', requireAuth, async (req, res, next) => {
  try {
    if (!(await db.unfollowSource(req.userId, parseId(req.params.id)))) throw notFound();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- collection ----
// "Collect now": only this user's sources; at most once per hour per source unless never collected.
api.post('/collect', requireAuth, rateLimit('collect', userKey, 6, HOUR), async (req, res, next) => {
  try {
    res.json(await runDue({ trigger: 'manual', budgetMs: MANUAL_BUDGET_MS, userId: req.userId, minIntervalMs: HOUR }));
  } catch (err) { next(err); }
});

// Scheduler (Vercel Cron sends GET + Bearer CRON_SECRET). Not reachable with a session or MCP key.
api.get('/cron/collect', requireCron, async (req, res, next) => {
  try { res.json(await runDue({ trigger: 'cron', budgetMs: CRON_BUDGET_MS })); } catch (err) { next(err); }
});

api.get('/pain-quotes', requireAuth, async (req, res, next) => {
  try {
    const q = parse(quotesQuerySchema, req.query);
    res.json(await db.getUserQuotes(req.userId, { sourceId: q.source_id, sourceType: q.source_type, locationId: q.location_id, keywordsOnly: q.problems === '1', limit: q.limit, offset: q.offset }));
  } catch (err) { next(err); }
});

api.get('/content', requireAuth, async (req, res, next) => {
  try { res.json(await db.listContent(req.userId)); } catch (err) { next(err); }
});

api.post('/content', requireAuth, async (req, res, next) => {
  try {
    const body = parse(contentSchema, req.body);
    const id = await db.createContent(req.userId, body);
    res.status(201).json(await db.getContent(req.userId, id));
  } catch (err) { next(err); }
});

api.put('/content/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const body = parse(contentUpdateSchema, req.body);
    if (!(await db.updateContent(req.userId, id, body))) throw notFound();
    res.json(await db.getContent(req.userId, id));
  } catch (err) { next(err); }
});

api.delete('/content/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await db.softDeleteContent(req.userId, id))) throw notFound();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/feedback/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const { feedback, reason } = parse(feedbackSchema, req.body);
    if (!(await db.setFeedback(req.userId, id, feedback, reason))) throw notFound();
    res.json(await db.getContent(req.userId, id, { includeDeleted: true }));
  } catch (err) { next(err); }
});

api.use((req, res, next) => next(notFound()));
app.use('/api', api);

// Central error handler: JSON only, no stack traces in production.
app.use((err, req, res, next) => {
  console.error(err.message);
  if (res.headersSent) return next(err);
  // Only errors we raised on purpose (HttpError) or body-parser's client errors may set the status/message.
  // Anything else (library/upstream errors) is reported generically so internals never leak.
  const trusted = err instanceof HttpError || err.expose === true;
  if (!trusted) return res.status(500).json({ error: 'Internal server error' });
  res.status(err.status || 500).json({
    error: err.type === 'entity.parse.failed' ? 'Invalid JSON' : err.message,
    ...(err.details && { details: err.details })
  });
});

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  init()
    .then(() => app.listen(port, () => console.log(`TheVoice running at http://localhost:${port}`)))
    .catch((err) => {
      console.error('Failed to initialize database:', err.message);
      process.exit(1);
    });
}
