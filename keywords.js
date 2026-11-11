// Problem keywords: what the founder wants to find in their users ("revenge trading", "not following my system").
// A keyword matches a post when ALL of its significant words appear — in any order and any inflection —
// so "not following my system" also finds "I never follow my rules and my system fails".
// The same logic runs in JS (display, filtering) and SQL (ranking), so both always agree.

const MAX_KEYWORDS = 8;
const MIN_KEYWORD_CHARS = 3;
const MAX_KEYWORD_CHARS = 60;

const STOP = new Set([
  'a', 'an', 'the', 'my', 'i', 'me', 'im', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'it', 'is', 'at', 'by', 'with',
  'you', 'your', 'their', 'they', 'we', 'our', 'not', 'no', 'dont', 'do', 'does', 'did', 'be', 'am', 'are', 'was', 'so',
  'too', 'very', 'can', 'cant', 'cannot', 'get', 'got', 'that', 'this', 'when', 'how', 'why', 'what'
]);

// Crude suffix stripping so "trading" ~ "trade/traded/trader", "following" ~ "follow/follows".
function stemWord(w) {
  for (const suf of ['ingly', 'ing', 'edly', 'ed', 'es', 's', 'e']) {
    if (w.length - suf.length >= 4 && w.endsWith(suf)) return w.slice(0, -suf.length);
  }
  return w;
}

// "revenge trading" -> ['reveng', 'trad'];  "not following my system" -> ['follow', 'system']
function keywordStems(keyword) {
  const words = String(keyword || '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  let sig = words.filter((w) => !STOP.has(w) && w.length >= 3);
  if (!sig.length) sig = words.filter((w) => w.length >= 2);
  return [...new Set(sig.map(stemWord))];
}

// Tidy what the founder typed: trim, collapse spaces, drop quotes/control chars, cap the length.
const tidyKeyword = (s) => String(s ?? '').replace(/["“”\\\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
const normalizeKeyword = (s) => tidyKeyword(s).slice(0, MAX_KEYWORD_CHARS);
// Stable identity (case-insensitive, whitespace-insensitive) used as the shared source key.
const keywordKey = (s) => normalizeKeyword(s).toLowerCase();

const textMatches = (lowerText, stems) => stems.length > 0 && stems.every((st) => lowerText.includes(st));

// Which of the founder's keywords does this text match? -> ['revenge trading']
function matchKeywords(text, keywords) {
  const lower = String(text || '').toLowerCase();
  return keywords.filter((k) => textMatches(lower, keywordStems(k)));
}

// SQL predicate (column q.quote) true when ANY keyword matches. No keywords -> constant 0.
function sqlKeywordMatch(keywords, column = 'q.quote') {
  const parts = [];
  const args = [];
  for (const k of keywords) {
    const stems = keywordStems(k);
    if (!stems.length) continue;
    parts.push(`(${stems.map(() => `instr(lower(${column}), ?) > 0`).join(' AND ')})`);
    args.push(...stems);
  }
  return parts.length ? { sql: `(${parts.join(' OR ')})`, args } : { sql: '0', args: [] };
}

module.exports = { STOP_WORDS: STOP, MAX_KEYWORDS, MIN_KEYWORD_CHARS, MAX_KEYWORD_CHARS, keywordStems, tidyKeyword, normalizeKeyword, keywordKey, matchKeywords, sqlKeywordMatch };
