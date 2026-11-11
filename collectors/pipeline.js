// Pure functions: raw source items -> storable pain quotes. No I/O, no AI.
// Raw item: { external_id, title?, body?, rating?, published_at?, url, kind: 'review'|'post', flags? }
const crypto = require('crypto');
const { decodeEntities } = require('./text');
const { keywordStems } = require('../keywords');

const MAX_QUOTE_CHARS = 600;
const MIN_QUOTE_CHARS = 30;

// ---- tunables (one place) ----
const WEIGHTS = { rating: 0.35, lexicon: 0.35, firstPerson: 0.15, length: 0.15 };
const RATING_SIGNAL = { 1: 1.0, 2: 0.8, 3: 0.5, 4: 0.2, 5: 0.1 };
const REDDIT_RATING_SIGNAL = 0.4;

// Each hit adds to the pain-lexicon score (capped at 3 hits => 1.0).
const PAIN_LEXICON = [
  /\bwish\b/i, /\bhate\b/i, /\bfrustrat\w*/i, /\bannoy\w*/i, /\bcan'?t\b/i, /\bcannot\b/i, /\bnever\b/i,
  /\balways\b/i, /\bkeep\s+\w+ing\b/i, /\bi keep\b/i, /\bstruggl\w*/i, /\btired of\b/i, /\bwaste\w*/i,
  /\bno way to\b/i, /\bwhy (does|do|is|can)/i, /\bevery time\b/i, /\bdoesn'?t (work|help|let)/i,
  /\bdon'?t know\b/i, /\bterrible\b/i, /\bworst\b/i, /\buseless\b/i, /\bscam\b/i, /\bbroken\b/i,
  /\bcrash\w*/i, /\bfreez\w*/i, /\bconfus\w*/i, /\boverwhelm\w*/i, /\banxi\w*/i, /\bpanic\w*/i,
  /\bregret\w*/i, /\blost (money|everything|\d)/i, /\bfail\w*/i, /\bstuck\b/i, /\bhard(est)?\b/i,
  /\bproblem\b/i, /\bissue\b/i, /\bbug\w*/i, /\bglitch\w*/i, /\bunable\b/i, /\bhelp\b/i, /\bwrong\b/i
];
// A question or plea about the problem ("How do I stop…?", "any advice") is on-topic for a keyword search even without "I".
const QUESTION = /\?|\b(how|why|anyone|advice|tips|help|stop|overcome|deal(ing)?\s+with|cope|coping|struggl\w*)\b/i;
const FIRST_PERSON = /\b(i|i'm|i've|i'd|i'll|my|me|we|our|mine)\b/i;

const PROMO_PATTERNS = [
  /\bdm me\b/i, /\b(promo|referral|invite|coupon) code\b/i, /\buse (my )?code\b/i, /\bsign ?up (with|using) my\b/i,
  /\bearn \$?\d+/i, /\bguaranteed (profit|returns?|income)/i, /\b(whatsapp|telegram)\b.*\+?\d{6,}/i,
  /\bcrypto (signals?|giveaway)\b/i, /\bclick (the )?link\b/i, /\bfollow (me|my)\b/i
];
// ---- promotion / self-promotion (Reddit posts). Problem-keyword searches attract course sellers, signal groups and
// founders pushing their own app, so they are dropped. Conservative on purpose: a post that merely says "I made a
// trading journal but never review it" is a genuine problem, not promotion.
const PROMO_STRONG = [
  /\b(join|joining)\s+(my|our|the)\s+(\w+\s+){0,2}(discord|telegram|whatsapp|group|community|channel|server|waitlist|newsletter|chat)\b/i,
  /\blinks?\s+(in|on)\s+(my\s+)?(bio|profile|comments|description|first comment)\b/i,
  /\b(promo|discount|coupon|referral|affiliate|invite)\s+(code|link)\b/i,
  /\buse\s+(my\s+)?(code|link)\b/i,
  /\b\d{1,3}\s?%\s+off\b/i,
  /\b(limited\s+(time|offer|spots)|early\s+access|free\s+trial|lifetime\s+deal|black\s+friday|giveaway|sponsored|paid\s+partnership)\b/i,
  /\b(dm|pm|message)\s+me\b/i,
  /\bfollow\s+(me|my)\b/i,
  /\b(trading\s+signals?|signal\s+group|copy\s+trad\w+)\b/i,
  /\bbeta\s+testers?\b|\bwaitlist\b|\b(we|i)['’]?(re|m)\s+(hiring|launching)\b/i
];
// "my course / our mentorship…" is promotion only with a selling cue — "my course taught me nothing" is a buyer's complaint.
const PROMO_PRODUCT = /\b(my|our)\s+(\w+\s+){0,2}(course|courses|mentorship|coaching|masterclass|webinar|bootcamp|signals?|academy|ebook|e-book|playbook|program)\b/i;
const PROMO_SELL = /\b(enrol+|enroll|join|sign\s*up|link|offer|discount|price|priced|\$\d+|limited|available|launch\w*|learn\s+how|check\s+(it\s+)?out|dm|free|spots?|seats?)\b/i;
// A builder announcing their own product: "I built <app/tool…>" AND a call to action.
const PROMO_BUILDER = /\b(i|we)\s+(just\s+)?(built|made|created|launched|developed|released)\b.{0,80}\b(app|tool|platform|extension|bot|software|website|saas|product|dashboard|plugin)\b/i;
const PROMO_CUE = /\b(feedback|try\s+(it|out)|check\s+(it\s+)?out|download|free|link|waitlist|launch(ed|ing)?|available\s+(on|in)|app\s*store|play\s*store|sign\s*up|beta|early\s+access|would\s+love\s+(your|any)\s+(thoughts|feedback))\b/i;
const PROMO_TITLE = /^\s*[\[(](promo|promotion|ad|advert|sale|free|offer|self[- ]?promo)[\])]/i;
// Extra for keyword searches, where link-droppers and channel pushers congregate.
const PROMO_KEYWORD_EXTRA = [/\b(subscribe|newsletter|my\s+(youtube|channel|tiktok|instagram|blog|substack|website)|affiliate)\b/i];

function isPromotion(title, body, { strict = false } = {}) {
  const text = `${title ?? ''}\n${body ?? ''}`;
  if (PROMO_TITLE.test(String(title ?? ''))) return true;
  if (PROMO_STRONG.some((re) => re.test(text))) return true;
  if (PROMO_PRODUCT.test(text) && PROMO_SELL.test(text)) return true;
  if (PROMO_BUILDER.test(text) && PROMO_CUE.test(text)) return true;
  return strict && PROMO_KEYWORD_EXTRA.some((re) => re.test(text));
}

// Mod/sticky-style Reddit threads (RSS gives no sticky flag, so also match by title).
const LOW_VALUE_THREAD = /\b(daily|weekly|monthly)\b.*\b(thread|discussion|megathread)\b|\bmegathread\b|^\s*(rules|faq|welcome)\b|\bmod (post|announcement)\b/i;

const STOPWORDS = new Set(['the', 'and', 'to', 'is', 'it', 'this', 'my', 'of', 'that', 'for', 'you', 'but', 'not', 'was', 'with', 'have', 'i', 'in', 'app', 'on', 'are', 'be', 'so', 'if', 'can', 'me', 'just', 'when', 'what']);

// ---- helpers ----
function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end > max * 0.5) return cut.slice(0, end + 1);
  const space = cut.lastIndexOf(' ');
  return `${cut.slice(0, space > max * 0.5 ? space : max).trimEnd()}…`;
}

// Strip URLs, emails, phones, handles; normalize markdown/whitespace; cap length.
function clean(input, max = MAX_QUOTE_CHARS) {
  let t = decodeEntities(String(input ?? ''));
  t = t.replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.)[^)]*\)/gi, '$1'); // markdown links keep their text
  t = t.replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ');
  t = t.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, ' ');
  t = t.replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => (m.replace(/\D/g, '').length >= 9 ? ' ' : m));
  t = t.replace(/(^|\s)@\w{2,}/g, '$1').replace(/(^|[\s(])\/?u\/[A-Za-z0-9_-]{3,}/g, '$1');
  t = t.replace(/(\*\*|__|~~|`+)/g, '').replace(/^[>#\s]+/gm, '');
  t = t.replace(/\s+/g, ' ').trim();
  return truncate(t, max);
}

function isEnglish(text) {
  const letters = text.match(/\p{L}/gu) || [];
  if (!letters.length) return false;
  const ascii = letters.filter((c) => /[A-Za-z]/.test(c)).length;
  if (ascii / letters.length < 0.85) return false;
  const tokens = new Set(text.toLowerCase().match(/[a-z']+/g) || []);
  let hits = 0;
  for (const w of STOPWORDS) if (tokens.has(w)) hits += 1;
  return hits >= (text.length < 40 ? 1 : 2);
}

// Checked on the RAW text, before URLs are stripped.
function isSpam(raw) {
  const text = String(raw ?? '');
  const urls = (text.match(/https?:\/\/|www\./gi) || []).length;
  return urls >= 2 || PROMO_PATTERNS.some((re) => re.test(text));
}

const lexiconHits = (text) => PAIN_LEXICON.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);

function contentHash(text) {
  const norm = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(norm).digest('hex');
}

function lengthFit(len) {
  if (len < 60) return len / 60;
  if (len <= 300) return 1;
  return Math.max(0.4, 1 - (len - 300) / 500);
}

function painScore({ text, rating, kind, boost = 0 }) {
  const rs = kind === 'review' ? RATING_SIGNAL[rating] ?? 0.3 : REDDIT_RATING_SIGNAL;
  const lex = Math.min(1, lexiconHits(text) / 3);
  const fp = FIRST_PERSON.test(text) ? 1 : 0;
  const score = WEIGHTS.rating * rs + WEIGHTS.lexicon * lex + WEIGHTS.firstPerson * fp + WEIGHTS.length * lengthFit(text.length);
  return Math.round(Math.min(1, score + boost) * 10000) / 10000;
}

function buildText(item) {
  const title = clean(item.title ?? '', 200);
  const body = clean(item.body ?? '', MAX_QUOTE_CHARS);
  if (!title) return body;
  if (!body || body.toLowerCase().startsWith(title.toLowerCase().slice(0, 40))) return body || title;
  return truncate(`${title}${/[.!?…]$/.test(title) ? ' ' : '. '}${body}`, MAX_QUOTE_CHARS);
}

function shouldKeep(item, text, { relaxed = false } = {}) {
  if (text.length < MIN_QUOTE_CHARS) return false;
  if (/^\[?(removed|deleted)\]?$/i.test(text)) return false;
  if (!isEnglish(text)) return false;
  const hits = lexiconHits(text);
  if (item.kind === 'review') {
    if (item.rating != null && item.rating >= 4) return hits >= 2; // praise is dropped unless it also complains
    return true;
  }
  // Reddit: needs a first-person pain signal. Problem-keyword results already match the topic, so either is enough.
  return relaxed ? FIRST_PERSON.test(text) || hits >= 1 || QUESTION.test(text) : FIRST_PERSON.test(text) && hits >= 1;
}

const subredditFromUrl = (url) => (/\/r\/([A-Za-z0-9_]+)\//.exec(String(url || '')) || [])[1] || null;

function sourceLabel(item, source) {
  if (item.kind === 'review') return `App Store review (★${item.rating ?? '?'})`;
  const sub = subredditFromUrl(item.url);
  return sub ? `Reddit r/${sub}` : `Reddit ${source.label}`;
}

const slugOf = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function isBrandCommunity(url, term) {
  const sub = slugOf(subredditFromUrl(url));
  const key = slugOf(term);
  return key.length >= 3 && sub.startsWith(key);
}

// Whole-word, case-insensitive: "Robinhood" matches "robinhood's" but not "Robinhoods"-style substrings of other words.
function mentionsTerm(text, term) {
  const t = String(term || '').trim();
  if (!t) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, 'i').test(text);
}

// rawItems -> { rows, fetched, kept }. `now` injectable for tests.
function process(rawItems, source, { now = Date.now() } = {}) {
  const rows = [];
  const seen = new Set();
  let kept = 0;
  for (const item of rawItems) {
    const f = item.flags || {};
    if (f.over_18 || f.stickied || f.removed) continue;
    const isKeyword = source.type === 'reddit_keyword';
    if (item.kind === 'post' && isPromotion(item.title, item.body, { strict: isKeyword })) continue;
    if (item.kind === 'post' && LOW_VALUE_THREAD.test(item.title || '')) continue;
    if (isSpam(`${item.title ?? ''} ${item.body ?? ''}`)) continue;
    const text = buildText(item);
    // Reddit mention-search: keep only posts that really name the app (search also returns fuzzy matches)
    // (posts inside a community named after the app, e.g. r/swiggy for "Swiggy", are about it by definition)
    if (source.type === 'reddit_search' && !mentionsTerm(text, source.subject || source.external_id)
        && !isBrandCommunity(item.url, source.subject || source.external_id)) continue;
    // Problem-keyword results must actually discuss the problem (all the keyword's significant words, any inflection)
    if (isKeyword) {
      const stems = keywordStems(source.subject || source.external_id);
      const lower = text.toLowerCase();
      if (!stems.length || !stems.every((st) => lower.includes(st))) continue;
    }
    if (!shouldKeep(item, text, { relaxed: isKeyword })) continue;
    kept += 1;
    const hash = contentHash(text);
    if (seen.has(item.external_id) || seen.has(hash)) continue; // duplicates within this batch
    seen.add(item.external_id);
    seen.add(hash);
    rows.push({
      external_id: String(item.external_id),
      quote: text,
      source: sourceLabel(item, source),
      source_url: item.url,
      rating: item.kind === 'review' ? item.rating ?? null : null,
      pain_score: painScore({ text, rating: item.rating, kind: item.kind, boost: isKeyword ? 0.1 : 0 }),
      content_hash: hash,
      published_at: item.published_at ?? null,
      fetched_at: now
    });
  }
  return { rows, fetched: rawItems.length, kept };
}

module.exports = {
  clean, isEnglish, isSpam, contentHash, painScore, lexiconHits, shouldKeep, buildText, process, mentionsTerm, subredditFromUrl, isBrandCommunity, isPromotion,
  MAX_QUOTE_CHARS, MIN_QUOTE_CHARS
};
