// Target-location config (NOT quote data). Codes are ISO-3166 alpha-2, which are also the
// App Store storefront codes. `english: false` = primary language isn't English, so most quotes
// from that market are dropped by the English-only filter (shown as a warning in the UI).
const COUNTRIES = [
  { code: 'us', name: 'United States', english: true },
  { code: 'gb', name: 'United Kingdom', english: true },
  { code: 'ca', name: 'Canada', english: true },
  { code: 'au', name: 'Australia', english: true },
  { code: 'nz', name: 'New Zealand', english: true },
  { code: 'ie', name: 'Ireland', english: true },
  { code: 'in', name: 'India', english: true },
  { code: 'sg', name: 'Singapore', english: true },
  { code: 'ph', name: 'Philippines', english: true },
  { code: 'za', name: 'South Africa', english: true },
  { code: 'ng', name: 'Nigeria', english: true },
  { code: 'ke', name: 'Kenya', english: true },
  { code: 'pk', name: 'Pakistan', english: true },
  { code: 'my', name: 'Malaysia', english: true },
  { code: 'hk', name: 'Hong Kong', english: true },
  { code: 'ae', name: 'United Arab Emirates', english: true },
  { code: 'de', name: 'Germany', english: false },
  { code: 'fr', name: 'France', english: false },
  { code: 'es', name: 'Spain', english: false },
  { code: 'it', name: 'Italy', english: false },
  { code: 'nl', name: 'Netherlands', english: false },
  { code: 'se', name: 'Sweden', english: false },
  { code: 'no', name: 'Norway', english: false },
  { code: 'dk', name: 'Denmark', english: false },
  { code: 'fi', name: 'Finland', english: false },
  { code: 'pl', name: 'Poland', english: false },
  { code: 'pt', name: 'Portugal', english: false },
  { code: 'br', name: 'Brazil', english: false },
  { code: 'mx', name: 'Mexico', english: false },
  { code: 'ar', name: 'Argentina', english: false },
  { code: 'co', name: 'Colombia', english: false },
  { code: 'cl', name: 'Chile', english: false },
  { code: 'tr', name: 'Turkey', english: false },
  { code: 'sa', name: 'Saudi Arabia', english: false },
  { code: 'eg', name: 'Egypt', english: false },
  { code: 'id', name: 'Indonesia', english: false },
  { code: 'th', name: 'Thailand', english: false },
  { code: 'vn', name: 'Vietnam', english: false },
  { code: 'jp', name: 'Japan', english: false },
  { code: 'kr', name: 'South Korea', english: false }
];

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));
const isCountry = (code) => BY_CODE.has(String(code).toLowerCase());
const countryName = (code) => BY_CODE.get(String(code).toLowerCase())?.name || String(code).toUpperCase();

const MAX_LOCATIONS = 3;
const MAX_REGION_CHARS = 60;

// Trim, collapse whitespace, strip control characters.
const normalizeRegion = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REGION_CHARS);

// Stable identity for a location (case-insensitive on the region).
const locationKey = (l) => `${String(l.country).toLowerCase()}|${normalizeRegion(l.region).toLowerCase()}`;

// "New York" -> "newyork" (subreddit-name-ish slug used for suggestion lookups).
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Common ways people name a place inside subreddit names (config, not quote data).
const ALIASES = {
  us: ['usa', 'unitedstates', 'american', 'america'], gb: ['uk', 'unitedkingdom', 'britain', 'british', 'england'],
  ae: ['uae', 'dubai', 'abudhabi', 'emirates'], in: ['india', 'indian', 'desi'], au: ['australia', 'aussie', 'straya'],
  ca: ['canada', 'canadian'], sg: ['singapore'], de: ['germany', 'german', 'deutsch'], fr: ['france', 'french']
};
// Does a subreddit name look related to one of the founder's locations? ("CreditCardsIndia" ~ India)
function subredditRelatedTo(name, locations) {
  const n = slug(name);
  return locations.some((l) => {
    const tokens = [slug(countryName(l.country)), ...(ALIASES[l.country] || []), slug(l.region)].filter(Boolean);
    return tokens.some((t) => (t.length >= 4 ? n.includes(t) : n.startsWith(t) || n.endsWith(t)));
  });
}

module.exports = {
  subredditRelatedTo, COUNTRIES, isCountry, countryName, normalizeRegion, locationKey, slug, MAX_LOCATIONS, MAX_REGION_CHARS };
