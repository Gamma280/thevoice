// Shared validation (used by REST now and by MCP tools in Phase 3).
const { z } = require('zod');
const { isCountry, normalizeRegion, locationKey, MAX_LOCATIONS, MAX_REGION_CHARS } = require('./locations');
const { MAX_KEYWORDS, MIN_KEYWORD_CHARS, MAX_KEYWORD_CHARS, tidyKeyword, keywordKey, keywordStems } = require('./keywords');

const TONES = ['Casual', 'Direct', 'Motivational', 'Technical'];
const FEEDBACK = ['approved', 'edited', 'deleted'];

const trimmed = (max) => z.string().trim().min(1, 'Required').max(max, `Max ${max} characters`);

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email address');

const signupSchema = z.object({
  email,
  password: z.string().min(8, 'Password must be at least 8 characters').max(128, 'Password too long')
});

const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128)
});

const competitorSourceSchema = z.object({
  type: z.literal('app_store'),
  external_id: z.string().regex(/^\d{5,15}$/, 'Invalid App Store id'),
  country: z.string().trim().toLowerCase().regex(/^[a-z]{2}$/, 'Invalid country code').optional()
});

const subredditName = z
  .string()
  .trim()
  .transform((s) => s.replace(/^\/?r\//i, ''))
  .pipe(z.string().regex(/^[A-Za-z0-9_]{2,21}$/, 'Invalid subreddit name'));

const countryCode = z.string().trim().toLowerCase().refine(isCountry, 'Unknown country');
const regionField = z.string().max(MAX_REGION_CHARS, `Max ${MAX_REGION_CHARS} characters`).default('').transform(normalizeRegion);

const locationSchema = z.object({ country: countryCode, region: regionField });
const locationsSchema = z
  .array(locationSchema)
  .min(1, 'Add at least one location')
  .max(MAX_LOCATIONS, `At most ${MAX_LOCATIONS} locations`)
  .transform((list) => {
    const seen = new Map(); // case-insensitive de-dupe on country+region
    for (const l of list) if (!seen.has(locationKey(l))) seen.set(locationKey(l), l);
    return [...seen.values()];
  });

// A community is global (no country) or local to one of the founder's locations.
const communitySchema = z.object({
  name: subredditName,
  country: countryCode.optional(),
  region: regionField
});

// A problem the founder wants to find in their users, e.g. "revenge trading" (≤ 8, de-duplicated case-insensitively).
const keywordText = z
  .string()
  .transform(tidyKeyword)
  .pipe(z.string().min(MIN_KEYWORD_CHARS, `At least ${MIN_KEYWORD_CHARS} characters`).max(MAX_KEYWORD_CHARS, `At most ${MAX_KEYWORD_CHARS} characters`)
    .refine((k) => keywordStems(k).length > 0, 'Use real words'));
const keywordsSchema = z
  .array(keywordText)
  .max(MAX_KEYWORDS, `At most ${MAX_KEYWORDS} problems`)
  .transform((list) => {
    const seen = new Map();
    for (const k of list) if (!seen.has(keywordKey(k))) seen.set(keywordKey(k), k);
    return [...seen.values()];
  });

const MAX_COMMUNITIES = 8;
const MAX_COMPETITORS = 5;

const profileSchema = z
  .object({
    app_description: trimmed(500),
    target_user: trimmed(500),
    voice_tone: z.enum(TONES),
    competitor_url: z.string().trim().max(500).default(''), // optional: a founder can track problems/communities with no competitor
    niche: z.string().trim().max(100).default(''),
    competitor_source: competitorSourceSchema.optional(),                      // legacy single app
    competitor_sources: z.array(competitorSourceSchema).max(MAX_COMPETITORS, `At most ${MAX_COMPETITORS} competitors`).optional(),
    problem_keywords: keywordsSchema.optional(),                                 // problems to find in their users; replaces the set; [] clears
    competitor_mentions: z.boolean().optional(),                                // also collect Reddit complaints about them
    locations: locationsSchema.optional(),
    location_mode: z.enum(['strict', 'all']).optional(),
    // Global communities (plain names) and/or location-tied communities.
    subreddits: z
      .array(subredditName)
      .max(MAX_COMMUNITIES, `At most ${MAX_COMMUNITIES} communities`)
      .optional(),
    communities: z.array(communitySchema).max(MAX_COMMUNITIES, `At most ${MAX_COMMUNITIES} communities`).optional()
  })
  .superRefine((p, ctx) => {
    const all = [...(p.subreddits || []).map((name) => ({ name })), ...(p.communities || [])];
    const appIds = new Set([...(p.competitor_sources || []), ...(p.competitor_source ? [p.competitor_source] : [])].map((a) => a.external_id));
    if (appIds.size > MAX_COMPETITORS) ctx.addIssue({ code: 'custom', path: ['competitor_sources'], message: `At most ${MAX_COMPETITORS} competitors` });
    const names = new Set(all.map((c) => c.name.toLowerCase()));
    if (names.size > MAX_COMMUNITIES) ctx.addIssue({ code: 'custom', path: ['communities'], message: `At most ${MAX_COMMUNITIES} communities in total` });
    for (const [i, c] of (p.communities || []).entries()) {
      if (c.region && !c.country) ctx.addIssue({ code: 'custom', path: ['communities', i, 'country'], message: 'A region needs a country' });
      if (c.country && p.locations && !p.locations.some((l) => locationKey(l) === locationKey({ country: c.country, region: c.region }))) {
        ctx.addIssue({ code: 'custom', path: ['communities', i], message: 'Community location must match one of your locations' });
      }
    }
  })
  .transform((p) => {
    // De-duplicate communities case-insensitively; location-tied entry wins over a global duplicate.
    const seen = new Map();
    for (const c of p.communities || []) if (!seen.has(c.name.toLowerCase())) seen.set(c.name.toLowerCase(), c);
    for (const name of p.subreddits || []) if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), { name, region: '' });
    const touched = p.communities !== undefined || p.subreddits !== undefined;
    // one list of competitor apps, de-duplicated by App Store id (legacy single field folds in)
    const apps = new Map();
    for (const a of [...(p.competitor_sources || []), ...(p.competitor_source ? [p.competitor_source] : [])]) if (!apps.has(a.external_id)) apps.set(a.external_id, a);
    const competitor_sources = p.competitor_sources !== undefined || p.competitor_source ? [...apps.values()] : undefined;
    return { ...p, competitor_source: undefined, competitor_sources, subreddits: undefined, communities: touched ? [...seen.values()] : undefined };
  });

const suggestQuerySchema = z.object({ country: countryCode, region: regionField });
const locationModeSchema = z.object({ location_mode: z.enum(['strict', 'all']) });

const resolveQuerySchema = z.object({
  q: z.string().trim().min(2, 'Enter at least 2 characters').max(200),
  country: countryCode.optional()
});
const sourceFollowSchema = z.object({
  type: z.literal('reddit'),
  external_id: subredditName,
  country: countryCode.optional(), // tie this community to one of the founder's locations
  region: regionField
});

const quotesQuerySchema = z.object({
  source_id: z.coerce.number().int().positive().optional(),
  source_type: z.enum(['app_store', 'reddit']).optional(), // 'reddit' = community posts + competitor complaints
  location_id: z.coerce.number().int().positive().optional(),
  problems: z.enum(['1']).optional(), // only quotes that match one of the founder's problem keywords
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0)
});

const hooksSchema = z
  .array(trimmed(280))
  .length(5, 'Exactly 5 hooks are required');
const scriptSchema = trimmed(10000);

const contentSchema = z.object({
  hooks: hooksSchema,
  script: scriptSchema,
  inspiration_quote_ids: z.array(z.number().int().positive()).max(20).default([])
});

const contentUpdateSchema = z
  .object({ hooks: hooksSchema.optional(), script: scriptSchema.optional() })
  .refine((v) => v.hooks !== undefined || v.script !== undefined, 'Provide hooks and/or script');

const feedbackSchema = z.object({
  feedback: z.enum(FEEDBACK),
  reason: z.string().trim().max(1000).default('')
});

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Parse `data` with `schema`; throws HttpError(400) with per-field details.
function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  throw new HttpError(400, 'Invalid input', details);
}

module.exports = {
  TONES, FEEDBACK, HttpError, parse,
  signupSchema, loginSchema, profileSchema, contentSchema, competitorSourceSchema, resolveQuerySchema, sourceFollowSchema, quotesQuerySchema, MAX_COMMUNITIES, MAX_COMPETITORS, keywordsSchema, locationsSchema, suggestQuerySchema, locationModeSchema, contentUpdateSchema, feedbackSchema
};
