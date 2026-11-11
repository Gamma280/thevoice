# TheVoice — Architecture (v3)

Companion to [agent.md](agent.md) (the spec) and [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (the build checklist).
**v3:** hardcoded quotes replaced by a live collection subsystem (sections 2, 3, 4, 5.5, 6, 7, 8, 9 changed). **Phase 3 is built.** **Phase 4 (MCP server) is built.** **v3.1:** target locations (country + city/region) added (§4, §5.1, §5.6, §6, §8). **Reddit today = Arctic Shift (primary) → Reddit RSS (fallback); the official API is a dormant placeholder** that activates when credentials are set.

## 1. Summary
TheVoice is memory + canvas for Claude. A founder signs up, describes their app, names a competitor app and (optionally) subreddits, and gets a personal MCP key. A **collector** continuously pulls real audience pain — App Store reviews of the competitor and Reddit posts from the named communities — cleans, scores and stores it. Claude (the AI, paid for by the founder's own Claude plan) connects to `/mcp`, reads the founder's profile, the freshest high-pain quotes and past feedback, writes hooks and a script, and saves them back. The founder reviews them in a dashboard; edits/deletes/approvals (with reasons) flow back to Claude — the flywheel. TheVoice contains **no AI calls and no AI keys**; the collector is deterministic code.

## 2. System diagram

```
                           ┌────────────────────────────── Vercel project ────────────────────────────────┐
                           │                                                                              │
 Founder's browser         │   Static (CDN)               Serverless function (api/index.js)              │
 ───────────────  HTTPS ──▶│   public/*.html, css, js ──▶ Express app (server.js)                         │
  login / onboarding /     │                               ├─ helmet, JSON body, trust proxy              │
  dashboard / sources /    │                               ├─ /api/auth/*        (auth.js)                │
  connect                  │                               ├─ /api/*             (requireAuth: cookie)    │
        │ cookie           │                               ├─ /api/collect       (cookie, rate limited) ──┼─┐
        └─ tv_session ─────│──────────────────────────────▶├─ /api/cron/collect  (Bearer CRON_SECRET) ────┼─┤
                           │                               ├─ /mcp               (requireApiKey: Bearer)  │ │
 Claude (Desktop/Web)      │                               │    └─ mcp-server.js: McpServer per request   │ │
 ───────────────  HTTPS ──▶│                               └─ database.js (user data always user-scoped)  │ │
  MCP Streamable HTTP      │                                              │                               │ │
  Authorization: Bearer tv_│   Vercel Cron (daily on Hobby) ──GET────────┘          collectors/ ◀────────┘ │
                           │                                              │  runDue() · lease · budget    │
                           │                                              │  pipeline: clean→filter→      │
                           │                                              │  dedupe→score→upsert→prune    │
                           └──────────────────────────────────┬───────────┼───────────────────────────────┘
                                                              ▼           ▼ fetchJson() — host allowlist,
                                        Turso (libSQL / SQLite)           │ timeout, retry/jitter, UA
                                        users · sessions · api_keys       ├─▶ itunes.apple.com  (search/lookup +
                                        rate_limits · founders · content  │       customer-review feed; no key)
                                        sources · founder_sources         ├─▶ arctic-shift.photon-reddit.com (archive API)
                                        pain_quotes · collection_runs     ├─▶ www.reddit.com  (public .rss feeds)
                                                                          └─▶ oauth.reddit.com (official; optional)
```
Local dev: same Express app via `node server.js` on `:3000`, `TURSO_DATABASE_URL=file:local.db`; `npm run collect` runs the collector from the CLI (App Store needs no credentials).

## 3. Components

| Component | Responsibility | Notes |
|---|---|---|
| `public/*` | UI (plain HTML/CSS/JS). Calls `/api/*` (same origin, cookie). | `textContent` only. Pages guard via `/api/auth/me`. 🔄 `sources.html` shows collection health. |
| `server.js` | Builds Express app; middleware order; mounts routes; exports app. | `trust proxy`; helmet CSP; JSON limit; CSRF guard on mutations. |
| `api/index.js` | Vercel entry. | Only function; `maxDuration` raised for collection. |
| `auth.js` | Signup/login/logout/me, sessions, `requireAuth`, `requireApiKey`, 🔄 `requireCron`, MCP key mgmt, DB-backed rate limiter. | One place that knows hashing/cookies/secrets. |
| `database.js` | libSQL client, 🔄 **versioned migrations** (`schema_migrations`), query helpers. | User-owned tables always take `userId`. 🔄 No seeding. |
| `validation.js` | zod schemas + `HttpError`, shared by REST and MCP. | |
| `mcp-server.js` | `createMcpServer(userId)` (5 tools), `handleMcp`, stdio entry. | 🔄 `get_pain_quotes` returns quotes + freshness/`note` metadata. |
| 🔄 `collectors/index.js` | Source registry, `collectSource`, `runDue({budgetMs, trigger})`: due selection, **lease**, time budget, backoff, retention. | Single orchestration path used by cron, manual and CLI. |
| 🔄 `collectors/http.js` | `fetchJson()`: host allowlist, timeout, size cap, retries, `Retry-After`, per-host concurrency, UA. | The only place network egress happens (SSRF boundary). |
| 🔄 `collectors/appstore.js` | `resolve(q)` (search/lookup), `collect(source)` (paged review feed → raw items). | zod-checks Apple's response shape. |
| 🔄 `collectors/reddit.js` | **Provider chain: Arctic Shift (primary) → Reddit RSS (fallback)**; official OAuth provider is built but dormant until `REDDIT_*` credentials exist (then it goes first). | `REDDIT_PROVIDER=off` disables. No credentials needed today. |
| 🔄 `collectors/pipeline.js` | Pure functions: normalize, clean/PII-strip, filter, hash, score. | Unit-tested with fixtures; no I/O. |
| 🔄 `scripts/collect.js` | CLI wrapper around `runDue`. | Local demos + manual ops. |
| `vercel.json` | `cleanUrls`, rewrites, 🔄 `crons`, `functions.maxDuration`. | |

## 4. Data model

```
users 1───1 founders             (founders.user_id UNIQUE)
users 1───* founder_locations     (≤ 3 per user; country + optional region)  🔄
founder_locations 1───* founder_sources   (founder_sources.location_id, NULL = not location-specific)  🔄
users 1───* sessions
users 1───* api_keys             (one active = revoked_at IS NULL)
users 1───* content              (content.inspiration_snapshot = copy of cited quotes)
users *───* sources              via founder_sources(user_id, source_id, role)   ← access check for quotes
sources 1───* pain_quotes        (UNIQUE source_id+external_id, UNIQUE source_id+content_hash)
sources 1───* collection_runs
rate_limits (key, window_start)  standalone
```
- **Public vs private:** `sources`, `pain_quotes` are public data shared across users (two founders following the same competitor share one collection — less load, fewer requests to Apple/Reddit). Everything about *who follows what* (`founder_sources`) and everything the founder wrote (`content`, `founders`) is user-scoped. A user reads quotes only via `JOIN founder_sources ON user_id = ?`.
- **Why not per-user quotes:** duplicates data and multiplies upstream requests for no isolation benefit (the data is public).
- `hooks`, `inspiration_quote_ids`, `inspiration_snapshot` are JSON in TEXT columns.
- **Snapshot:** quotes are pruned after 180 days; content keeps its own copy of the cited quotes so history never breaks.
- Times: `CURRENT_TIMESTAMP` for row audit columns; scheduling/lease/rate-limit fields are unix-ms integers.
- Migrations: `schema_migrations(version)`; migration 1 = v2 schema; migration 2 = sources/founder_sources/new pain_quotes/collection_runs + `content.inspiration_snapshot` + drop seeded quotes.

## 5. Key flows

### 5.1 Signup → onboarding → first collection → connect
1. `POST /api/auth/signup` → user + session cookie.
2. `/index.html` → `GET /api/auth/me` → form. Founder types a competitor → `GET /api/sources/resolve?q=` → iTunes search → picks one app (and optionally lists subreddits).
3. `POST /api/setup` → upsert profile; **server re-validates the chosen app via Apple lookup by id**, upserts `sources` row(s) (`next_collect_at=0`) and replaces this user's `founder_sources`.
4. Browser calls `POST /api/collect` (25 s budget) → collects this user's never-collected sources → progress shown; the UI polls `GET /api/sources` for status.
5. `/connect.html` → `POST /api/mcp-key` → plaintext key once. Founder pastes URL + key into Claude.

### 5.1b Choosing locations 🔄
1. Onboarding row: country (from `/api/countries`) + optional city/region, up to 3. Non-English-primary countries show a warning (English-only filter).
2. `GET /api/locations/suggest` → `reddit.searchSubreddits(region)` and `(country name)` — official `subreddits/search` first, Arctic Shift prefix search as fallback → public, non-NSFW, ≥ 1,000-subscriber subs, exact-name matches first. Failure → empty list + note; manual entry always possible.
3. `POST /api/setup` (lookups first, then writes): the competitor app is looked up in **every target country's storefront**; missing storefronts become `warnings`. Locations are reconciled (removed ones cascade away their links); one `competitor` source per country is linked to that country's location; chosen communities are linked to their location or left global.
4. **Read path:** `quoteFilter` joins `founders`/`founder_locations`: with ≥ 1 location and `location_mode='strict'` only location-linked sources are visible; `mentions_location` = quote text contains one of the founder's regions (`instr(lower(…))`, literal). Sampling ranks place-mentioning quotes first, then by pain score.

**Precision limits (by design, surfaced in the UI):** App Store reviews are country-level only; Reddit has no location filter, so location is expressed through local communities plus the text signal above.

### 5.2 Generate content (Claude ↔ TheVoice)
```
Claude ──POST /mcp (Bearer tv_…)──▶ requireApiKey ─▶ user_id ─▶ fresh McpServer(user_id) ─▶ tool
  1 get_founder_profile   → profile + followed sources + their freshness
  2 get_pain_quotes       → random sample of the founder's top-scored recent quotes (+ meta.note if empty/stale)
  3 get_content_history   → last 5 incl. feedback/reasons (incl. deleted)
  4 Claude writes 5 hooks + script in the founder's tone, grounded in real quotes, avoiding rejected patterns
  5 save_generated_content(hooks[5], script, quote_ids) → draft row + inspiration_snapshot
```

### 5.3 Feedback flywheel
Dashboard action (edit / delete / approve) → reason modal → `PUT`/`DELETE` → `POST /api/feedback/:id` → stored → returned by `get_content_history` next time → Claude adapts. Claude can also call `save_founder_feedback`.

### 5.4 Request authentication
```
/api/*            : cookie tv_session → sha256 → sessions row (not expired) → req.userId
/mcp              : Authorization: Bearer tv_… → sha256 → api_keys (revoked_at IS NULL) → userId
/api/cron/collect : Authorization: Bearer CRON_SECRET (timing-safe compare; 503 if unset) — no user context
```
Three separate credential types on purpose: a leaked MCP key reaches only the 5 tools; the cron secret can only trigger collection.

### 5.5b Competitors and Reddit complaints 🔄 (v3.2)
1. Onboarding: the founder adds up to 5 competitor apps; `POST /api/setup` sends `competitor_sources[]` + `competitor_mentions`.
2. The server does **one batched Apple lookup per target country** for all apps (missing storefronts → `warnings`), then writes: per-app-per-country `app_store` sources linked to the location, and — if requested and Reddit is on — one global `reddit_search` source per app brand linked as `role='competitor'`, `location_id NULL`.
3. The runner treats `reddit_search` like any source (lease, budget, backoff). Its adapter is `reddit.collectMentions`: official `/search` first when credentials exist, else Reddit RSS `search.rss` (Arctic Shift is excluded — its text search needs a subreddit). The pipeline keeps only posts that name the app (whole word) and read as complaints.
4. Read path: `role='competitor'` sources bypass strict location mode (they cannot be tied to a place). Each quote is returned with `app`, `source_type`, `subreddit`, `published_at`; content snapshots copy them.

### 5.5c Problem keywords 🔄 (v3.3)
`POST /api/setup {problem_keywords}` → rows in `founder_keywords` (user-scoped) + one global `reddit_keyword` source per keyword (`role='keyword'`). Collection searches Reddit for the keyword's significant words (official → RSS), then the pipeline applies the promotion filter, requires all stems to be present, and accepts first-person/pain/question posts. Read path: `matched_keywords` is computed from the user's keyword list (JS), and ranking uses the same stems in SQL (`sqlKeywordMatch`), so highlighting also applies to posts from competitors and communities — independent of whether Reddit-wide search works.

### 5.5 Collection run 🔄
```
trigger (Vercel Cron | POST /api/collect | CLI)
  └▶ runDue({trigger, budgetMs, userId?})
       loop while time remains:
         pick next source: enabled ∧ next_collect_at ≤ now ∧ locked_until < now   (manual: only the user's sources)
         claim lease: UPDATE sources SET locked_until = now+5min WHERE id=? AND locked_until < now  → 0 rows ⇒ someone else has it, skip
         insert collection_runs(status=running)
         adapter.collect(source)           ← fetchJson(): allowlist, timeout, retries, Retry-After
              └ App Store: pages 1..10 (stop once a page is older than the last run)   Reddit: [official if configured →] arctic → rss
         pipeline: normalize → clean (strip URLs/emails/handles) → filter → hash → score
         INSERT … ON CONFLICT DO NOTHING   (idempotent)
         success: last_collected_at=now, next_collect_at=now+6h, failures=0, status=ok
         error  : failures+=1, last_error, next_collect_at=now+min(24h, 30min·2^failures)   ← other sources unaffected
         release lease; finish collection_runs(fetched/kept/inserted)
  └▶ end of run: retention (180 days, ≤2000/source, prune runs, drop orphan sources)
```
Properties: **idempotent** (unique keys), **resumable** (budget stop ⇒ remaining sources stay due), **safe under concurrency** (lease), **observable** (`collection_runs`, `sources.last_status/last_error`, Sources page), **polite** (≤10 pages/app/run, ≥6h per source, backoff, identifying UA).

## 6. Security model

| Threat | Mitigation |
|---|---|
| Cross-user data access (IDOR) | `user_id` in every WHERE on user-owned tables; quotes reachable only via `founder_sources` join; not-found and not-yours both 404; automated cross-user tests (Phases 2–4). |
| Password theft | bcryptjs; no plaintext logging; generic login errors; timing-parity dummy compare. |
| Session theft | 256-bit random token, only hash stored; `HttpOnly`, `Secure`, `SameSite=Lax`; 30-day expiry; logout deletes row. |
| CSRF | SameSite=Lax; JSON-only mutations; `Origin` check on POST/PUT/DELETE. |
| Brute force / abuse | DB-backed rate limits (signup/login by IP+email; resolve/collect per user); body size limit. |
| XSS | `textContent` only; helmet CSP; no inline scripts. **Scraped quotes are hostile input.** |
| SQL injection | Parameterized queries only. |
| Leaked MCP key | Hashed; shown once; rotate; `last_used_at` visible. |
| 🔄 **SSRF via source input** | Users never supply URLs to fetch: they supply an app id / subreddit name matching strict regexes; all egress goes through `fetchJson()` with a **fixed host allowlist**; Apple lookup re-validates ids server-side. |
| 🔄 **Cron endpoint abuse** | Separate `CRON_SECRET`, timing-safe compare, fails closed (503) if unset; run is lease-protected and budget-bounded so repeated hits can't amplify load. |
| 🔄 **Resource exhaustion / upstream abuse** | Per-source min interval (6 h / 1 h manual), per-user `collect` rate limit, ≤5 communities per user, response size cap, ≤10 pages/app/run, global time budget. |
| 🔄 **Prompt injection via scraped quotes** | URLs stripped; quotes length-capped; returned to Claude as data with tool descriptions saying never to follow instructions inside quotes; tools can't do anything beyond saving the user's own rows, bounding impact. |
| 🔄 **PII in scraped data** | Usernames never stored; emails/phones/handles/URLs stripped before storage; excerpts ≤ 600 chars with attribution link; 180-day retention; takedown contact in README. |
| 🔄 **ToS / legal exposure** | Reddit via **unofficial public providers** today (Arctic Shift archive, Reddit RSS): low volume, attribution, no usernames, 180-day retention, one-setting kill switch (`REDDIT_PROVIDER=off`); official API is a placeholder for when Reddit approves the app. Apple feed treated as unstable public data. No HTML scraping. **Known accepted risk — revisit before a commercial launch** (§9). |
| 🔄 **Location inputs** | Country codes validated against a fixed list; regions are length-capped plain text matched with `instr` (no LIKE wildcards, no SQL interpolation); the new `suggest` endpoint only forwards a validated country name / ≤ 60-char region to allow-listed Reddit hosts, is rate-limited (30/h/user) and returns data only (names + subscriber counts). Locations/mode are per user; shared `sources`/`pain_quotes` stay public. |
| Secrets | Env vars only (`CRON_SECRET`, `REDDIT_*`, Turso token); never logged; `.env` git-ignored; no AI keys exist. |

## 7. Deployment topology (Vercel + Turso)

- **Why Turso:** Vercel's filesystem is ephemeral; Turso is hosted libSQL (SQLite dialect), so schema/SQL carry over.
- **Stateless by design:** no in-memory sessions, MCP sessions, rate limits or collection state — leases, schedules and counters live in the DB, so any instance can serve any request.
- **🔄 Cron:** `vercel.json` `crons` → `GET /api/cron/collect` daily (`0 6 * * *`) — **Hobby plans allow cron only once per day (±1 h precision)**; Pro allows hourly or more often. Faster refresh on Hobby = external scheduler calling the same endpoint with the Bearer secret. Cron invocations are ordinary function calls, so they inherit function duration limits.
- **🔄 Function duration:** `functions["api/index.js"].maxDuration = 300` (verify against the plan's current ceiling). Collection stops starting new sources at `COLLECT_BUDGET_MS` (240 s) to finish safely inside the limit. Manual collection uses a 25 s budget so user requests don't hang.
- **Env vars:** `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `NODE_ENV=production`, 🔄 `CRON_SECRET`, 🔄 optional `REDDIT_CLIENT_ID/SECRET/USER_AGENT`, optional `COLLECT_BUDGET_MS`, `BASE_URL`.
- **Cold starts:** `init()` memoized per instance; just runs pending migrations (a single `SELECT` when up to date). Reddit token cached per instance with expiry.
- **Turso load:** collection writes are batched per source (`client.batch`); reads for MCP are indexed (`idx_quotes_rank`).

## 8. Decisions and tradeoffs

| Decision | Why | Revisit when |
|---|---|---|
| Email+password, no verification/reset | Fastest safe login for MVP | Email provider chosen → verification + reset / Google OAuth |
| MCP API key in Bearer header | Works with remote MCP clients today | Claude connector supports OAuth discovery → implement OAuth |
| Stateless MCP | Fits serverless | Need server→client notifications |
| Soft delete | Preserves the flywheel's best signal | Compliance delete requirement → hard purge |
| 🔄 **Live collection replaces seed data** | Quotes must be real, attributable and fresh; fake seeds with generic URLs aren't production-honest | — |
| 🔄 **Competitor-driven sources (not niche labels)** | Relevance comes from the founder's actual competitor/communities; `niche` becomes a free-text hint | Add keyword/topic search per founder |
| 🔄 **Shared public `sources`/`pain_quotes`** | One collection per source regardless of followers; fewer upstream calls | A source needs per-user filtering/keywords → add a per-user filter layer, not per-user storage |
| 🔄 **Heuristic scoring, no AI** | Keeps "no AI keys"; deterministic; testable; Claude does the judging at generation time | Quality complaints → improve lexicon, add embeddings via a user-supplied key (opt-in) |
| 🔄 **Official/public JSON endpoints only (no HTML scraping, no headless browser)** | Stable, cheap, fits serverless, lower legal risk | Apple feed disappears → swap adapter (e.g. App Store Connect for own apps / licensed provider) |
| 🔄 **Reddit: Arctic Shift + RSS now, official API as a placeholder** | Official access needs Reddit's approval (not guaranteed); the public providers work today without credentials | Approval granted → set `REDDIT_*` (official goes first, no code change; `REDDIT_PROVIDER=official` if its terms bar fallbacks); providers blocked/dead → `REDDIT_PROVIDER=off` (App-Store-only) |
| 🔄 **Locations: country hard filter, city soft/local** | App Store is country-level; Reddit has no geo filter | Need true city-level → add geo-tagged sources or a location-aware classifier (needs AI or a places gazetteer) |
| 🔄 **Strict mode default** | The founder asked for quotes *only* from their location; `all` is an explicit opt-out | Founders complain of too-few quotes → suggest adding local communities / switch to `all` |
| 🔄 **Cron + on-demand, not a queue** | No extra infra; lease + budget give safe at-least-once, resumable runs | >hundreds of sources or hourly SLAs → dedicated worker/queue (e.g. Vercel Queues, Inngest) |
| 🔄 **English only, top ~500 recent reviews per app per country** | Feed limits + MVP scope | Multi-country/multilingual needs |
| Plain HTML/JS | Spec requirement | UI complexity grows |

## 9. Risks / open items to verify at build time
1. **Reddit (terms + reliability):** today's providers are unofficial. Reddit's terms restrict commercial use of its data without an agreement; Arctic Shift is a volunteer-run archive (no SLA, may lag, `subreddits/search` can time out on broad prefixes); Reddit RSS returns 429 after a few quick requests and may block datacenter IPs (Vercel). Local probes: `.json` → 403, RSS → 429 under bursts, Arctic Shift → 200. **Re-verify from a Vercel deployment in Phase 6**, then decide before a commercial launch: apply for official access (Responsible Builder Policy — approval required), accept the risk, or run App-Store-only. **HTTP 403 (network blocked) is handled without evasion:** plain "blocked" status, 6 h retry, and an app-community fallback via Arctic Shift (`reddit_search` chain `official → rss → arctic`); official API access is the real fix.
2. **Apple review feed** is unofficial and capped (~500 most recent per country, 50/page, 10 pages); confirm it still responds in the expected shape (zod-checked; failure is surfaced, not silent). Keep volume low.
3. **Vercel limits:** Hobby cron = once/day; confirm current `maxDuration` ceiling and cron count for the plan; `CRON_SECRET` header behavior.
4. **Claude's remote-MCP client config** changes often: confirm custom `Authorization` header support; keep the `mcp-remote` fallback.
5. **`@modelcontextprotocol/sdk` API surface** (Streamable HTTP transport, `McpServer.registerTool` vs `tool`): check installed typings before coding.
6. **Express on Vercel:** confirm `api/index.js` + rewrites (incl. `/api/cron/collect`) work with `express.json` and the MCP transport reading `req.body`.
7. **Turso from serverless:** HTTP client (`@libsql/client/web` if bundling issues arise); verify batch/transaction behavior for migrations.
8. **Quality of heuristics:** the filter/score are tunable constants with fixture tests — expect one tuning pass after real data arrives (review top/bottom 50 quotes per source).
