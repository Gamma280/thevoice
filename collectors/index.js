// Collection runner: lease → fetch → pipeline → idempotent upsert → schedule/backoff.
// One orchestration path shared by cron, "Collect now" and the CLI. collectSource never throws.
const db = require('../database');
const pipeline = require('./pipeline');
const appstore = require('./appstore');
const reddit = require('./reddit');

const HOUR = 3600000;
const SOURCE_INTERVAL_MS = 6 * HOUR; // normal re-collection cadence
const LEASE_MS = 5 * 60000;
const MAX_BACKOFF_MS = 24 * HOUR;
const DISABLED_RECHECK_MS = 24 * HOUR;
const RATE_LIMIT_RETRY_MS = 3 * 60000; // upstream said "slow down": try again soon, don't punish the source
const BLOCKED_RETRY_MS = 6 * HOUR;      // upstream REFUSES this network (403): retrying sooner only makes it worse

// Registry (mutable so tests can swap adapters). Adapter: { collect(source,{since}) → {items, provider}, isEnabled?() }
const adapters = {
  app_store: appstore,
  reddit,
  // "complaints about <competitor>": Reddit-wide search; same on/off switch as the other Reddit sources
  reddit_search: { isEnabled: () => reddit.isEnabled(), collect: (source, opts) => reddit.collectMentions(source, opts) },
  // problems the founder wants to find in their users ("revenge trading"): Reddit-wide keyword search
  reddit_keyword: { isEnabled: () => reddit.isEnabled(), collect: (source, opts) => reddit.collectKeyword(source, opts) }
};

const backoffMs = (failures) => Math.min(MAX_BACKOFF_MS, 30 * 60000 * 2 ** Math.max(0, failures - 1));

// Short, secret-free message for storage/UI.
const safeMessage = (err) => String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 200);

async function collectSource(source, { trigger = 'manual', now = Date.now() } = {}) {
  const adapter = adapters[source.type];
  const base = { source_id: source.id, label: source.label };
  if (!adapter) return { ...base, status: 'error', error: 'Unknown source type' };

  if (adapter.isEnabled && !adapter.isEnabled()) {
    await db.markSourceDisabled(source.id, now + DISABLED_RECHECK_MS, 'Collection for this source type is disabled');
    return { ...base, status: 'disabled' };
  }
  if (!(await db.claimSource(source.id, now, LEASE_MS))) return { ...base, status: 'skipped', reason: 'locked' };

  const runId = await db.startRun(source.id, trigger, now);
  try {
    const { items, provider } = await adapter.collect(source, { since: source.last_collected_at });
    const { rows, fetched, kept } = pipeline.process(items, source, { now });
    const inserted = await db.insertQuotes(source.id, rows);
    // Reddit-wide search was unavailable and the fallback (the app's own community) answered: say so, it's a narrower result.
    const note = source.type === 'reddit_search' && provider === 'arctic'
      ? 'Reddit is blocking this network, so only communities named after the app are read — not all of Reddit.' : null;
    await db.finishSourceOk(source.id, now, now + SOURCE_INTERVAL_MS, note);
    await db.finishRun(runId, { status: 'ok', fetched, kept, inserted });
    console.log(JSON.stringify({ evt: 'collect', source_id: source.id, status: 'ok', provider, fetched, kept, inserted }));
    return { ...base, status: 'ok', provider, fetched, kept, inserted };
  } catch (err) {
    const limited = Boolean(err && err.status === 429);
    const blocked = Boolean(err && err.status === 403);
    const message = blocked
      ? 'Reddit is blocking automated requests from this network (HTTP 403). The official Reddit API fixes this. Retrying in a few hours.'
      : limited ? 'Reddit is limiting how fast we can search. It will retry automatically in a few minutes.' : safeMessage(err);
    const standing = limited || blocked; // upstream conditions, not a broken source: don't escalate the failure backoff
    const failures = source.consecutive_failures + (standing ? 0 : 1);
    const wait = blocked ? BLOCKED_RETRY_MS : limited ? RATE_LIMIT_RETRY_MS : backoffMs(failures);
    await db.finishSourceError(source.id, now + wait, message, { countFailure: !standing });
    await db.finishRun(runId, { status: 'error', error: message });
    console.log(JSON.stringify({ evt: 'collect', source_id: source.id, status: 'error', failures, rate_limited: limited, blocked }));
    return { ...base, status: 'error', error: message, rate_limited: limited, blocked };
  }
}

// Collect every due source (oldest first) until the time budget is spent.
//   userId        → only that user's followed sources (manual runs)
//   minIntervalMs → manual refresh interval (see db.listDueSources)
//   ids           → force these sources regardless of schedule (CLI)
async function runDue({ trigger = 'cron', budgetMs = 240000, userId, minIntervalMs, ids, now = Date.now() } = {}) {
  const started = Date.now();
  // App Store first (fast, generous limits); Reddit last so its throttling never delays the rest.
  const rank = { app_store: 0, reddit: 1, reddit_search: 2, reddit_keyword: 3 };
  const due = (await db.listDueSources({ now, userId, minIntervalMs, ids })).sort((a, b) => (rank[a.type] ?? 1) - (rank[b.type] ?? 1));
  const results = [];
  let skippedForBudget = 0;
  for (const source of due) {
    if (Date.now() - started >= budgetMs) { skippedForBudget += 1; continue; }
    results.push(await collectSource(source, { trigger, now: Date.now() }));
  }
  if (trigger !== 'manual') await db.runRetention(Date.now());
  return { due: due.length, collected: results.length, skipped_for_budget: skippedForBudget, results };
}

module.exports = { collectSource, runDue, adapters, backoffMs, SOURCE_INTERVAL_MS, LEASE_MS };
