# TheVoice

Memory and canvas for Claude. A founder describes their app, names competitors, target locations and the problems they want to find; TheVoice **collects real audience pain** (App Store reviews, Reddit posts), and **Claude** (on the founder's own plan) reads it over MCP to write hooks and scripts in the founder's voice. The founder reviews drafts in a dashboard; edits, deletes and approvals (with reasons) flow back to Claude.

TheVoice makes **no AI calls and holds no AI keys**. Collection is deterministic code.

Docs: [agent.md](agent.md) (spec) · [ARCHITECTURE.md](ARCHITECTURE.md) · [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) · [DEPLOY.md](DEPLOY.md)

## Run locally
```bash
npm install
cp .env.example .env        # defaults use a local SQLite file (local.db)
npm test                    # 173 tests, no network
npm run dev                 # http://localhost:3000
npm run collect -- --all    # collect now from the CLI (App Store needs no credentials)
```
Node 20+.

## Environment variables
| Variable | Purpose |
|---|---|
| `TURSO_DATABASE_URL` | `file:local.db` locally; `libsql://…` in production (required on Vercel) |
| `TURSO_AUTH_TOKEN` | Turso token (production) |
| `NODE_ENV` | `production` on Vercel (Secure cookies, HTTPS upgrades) |
| `CRON_SECRET` | Bearer secret for `/api/cron/collect`; the route returns 503 if unset |
| `COLLECT_BUDGET_MS` | Max time a cron run may spend starting new sources (default 240000) |
| `BASE_URL` | Optional; used in the outbound User-Agent |
| `REDDIT_PROVIDER` | `auto` (default) · `official` · `arctic` · `rss` · `off` |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` / `REDDIT_USER_AGENT` | Official Reddit API (optional, see below) |

Real values go only in git-ignored `.env` and in Vercel's environment variables. Never commit them.

## How collection works
- **Sources:** App Store customer reviews of the founder's competitors (one storefront per target country) and Reddit posts (communities, competitor complaints, problem keywords).
- **Pipeline:** clean (URLs, emails, handles stripped) → filter (English, pain signal, spam and promotion removed) → dedupe by hash → score (deterministic) → store. Usernames are never stored.
- **Schedule:** Vercel Cron runs once a day at 06:00 UTC (Hobby plan limit); a source is collected at most every 6 h. **Collect now** on the Sources page triggers a manual run. Runs are idempotent and resumable, and one failing source never stops the others.
- **Retention:** quotes are pruned after 180 days; saved content keeps its own copy of the quotes it cited.

## Reddit status and compliance
Reddit is the weak point today:
- Collection uses **unofficial public providers**: the Arctic Shift archive, then Reddit's public RSS. From cloud IPs such as Vercel, Reddit RSS usually answers **HTTP 403**, and TheVoice reports that plainly and retries every few hours. It does **not** try to evade the block.
- **App Store reviews work fully** and are unaffected.
- **Planned fix:** the official Reddit API. When Reddit approves the app, add `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` and `REDDIT_USER_AGENT` to Vercel; it is then used first with no code change.
- Reddit's terms restrict commercial use of its data without an agreement. **Decision recorded:** running on the unofficial providers is a known, accepted risk until the official API is approved. `REDDIT_PROVIDER=off` disables Reddit entirely.
- Excerpts are short and attributed with a link back. **Takedown requests:** contact `[add your contact email here]`.

## Connect Claude (the easy way)
1. Log in, open **Connect**, and copy the server address (`https://<your-app>.vercel.app/mcp`).
2. In Claude: **Settings → Connectors → Add custom connector**, paste the address, click **Add**.
3. Log in to TheVoice if asked and click **Allow**.
4. In a chat, switch TheVoice on and ask: *"Generate 5 hooks for my app using TheVoice."*

TheVoice implements OAuth 2.1 (dynamic client registration, PKCE) for this, so no key or config file is needed. Remove the connector in Claude to disconnect.

**Advanced (key-based):** the Connect page also offers a personal `tv_…` key and an `mcp-remote` config for Claude Desktop (see [DEPLOY.md](DEPLOY.md)). Regenerating the key revokes the old one.

## Deploy
See [DEPLOY.md](DEPLOY.md): Turso database, Vercel project, env vars, then `vercel --prod`.

## Security notes
Passwords hashed with bcrypt; sessions stored hashed (HttpOnly, Secure, SameSite=Lax); every user-owned query is filtered by user id; scraped text is rendered with `textContent` only and treated as untrusted data by Claude; all outbound requests go through one host-allowlisted client; OAuth codes and tokens are stored hashed, codes are single-use, refresh tokens rotate.

## Out of scope for now
Email verification and password reset · Google login · multilingual collection · billing · teams.
