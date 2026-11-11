# Deploy TheVoice (Vercel + Turso) and connect Claude

Everything here is done on **your** accounts. Nothing is deployed until you run these commands.

## 0. Before you start
- Node 20+ and this folder. Run `npm test` (should be all green).
- Your local accounts/data (`local.db`) do **not** move to production. You will sign up again on the live site.

## 1. Database (Turso — free tier is enough)
```bash
brew install tursodatabase/tap/turso      # macOS (other OS: https://docs.turso.tech/cli/installation)
turso auth signup                          # or: turso auth login
turso db create thevoice
turso db show thevoice --url               # → libsql://thevoice-<you>.turso.io   (TURSO_DATABASE_URL)
turso db tokens create thevoice            # → long token                        (TURSO_AUTH_TOKEN)
```
Tables are created automatically on the first request (migrations run once).

## 2. A secret for the daily collector
```bash
openssl rand -hex 32                       # → CRON_SECRET
```

## 3. Vercel
```bash
npx vercel login
npx vercel                                 # answer: link/create project "thevoice", framework "Other", keep defaults
npx vercel env add TURSO_DATABASE_URL production     # paste the libsql:// URL
npx vercel env add TURSO_AUTH_TOKEN production       # paste the token
npx vercel env add NODE_ENV production               # value: production
npx vercel env add CRON_SECRET production            # paste the secret
npx vercel --prod                          # prints your live URL, e.g. https://thevoice-xyz.vercel.app
```
Vercel's **Deployment Protection** must be off (Settings → Deployment Protection) or Claude cannot reach `/mcp`.
Optional env vars: `BASE_URL` (your live URL, used in the User-Agent), `REDDIT_PROVIDER` (`off` to disable Reddit),
`REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` / `REDDIT_USER_AGENT` (only once Reddit approves the official API).
**Never** commit `.env`; the Turso token and `CRON_SECRET` belong only in Vercel's env vars.

If the site shows an error mentioning `TURSO_DATABASE_URL must be a libsql:// URL`, the env vars are missing or wrong — that guard is deliberate.

## 4. Check it is alive
```bash
curl https://YOUR-APP.vercel.app/health                 # {"ok":true}
```
Open the site → sign up → onboarding → Connect page → **Create my MCP key**.
```bash
MCP_KEY=tv_yourkey MCP_URL=https://YOUR-APP.vercel.app/mcp npm run mcp:check
```
Expected: `✔ all checks passed`. (Add `-- --write` to also save one test draft.)

## 5. Connect Claude
**Easy way (recommended): custom connector, no key.**
1. Open the site → sign up → onboarding → **Connect** page and copy the server address (`https://YOUR-APP.vercel.app/mcp`).
2. In Claude: **Settings → Connectors → Add custom connector**. Name it TheVoice, paste the address, click **Add**.
3. Claude opens a TheVoice page: log in if asked and click **Allow**.
4. In a chat, switch TheVoice on (**+ → Connectors**) and ask: **"Generate 5 hooks for my app using TheVoice"**.
   Claude should call get_founder_profile → get_pain_quotes → get_content_history → save_generated_content, and the draft appears on your dashboard.

To disconnect, remove the connector in Claude. Use a **stable URL** (the `*.vercel.app` production alias that `vercel --prod` prints under "Aliased"), not a per-deployment URL.

**Advanced: key + bridge (Claude Desktop config file).** Connect page → **Create my MCP key**, then Settings → Developer → **Edit Config** (or edit `claude_desktop_config.json` while Claude is **fully quit**: the running app overwrites the file), paste, and restart Claude Desktop. This appears under Settings → Desktop app → Extensions → Local MCP servers, not under Connectors.
```json
{
  "mcpServers": {
    "thevoice": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://YOUR-APP.vercel.app/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer tv_yourkey" }
    }
  }
}
```
Needs Node.js on that computer. Do not click **Regenerate** on the Connect page afterwards: it revokes the old key. Chat tab only; Code sessions do not load this config.

## 6. Collection schedule
`vercel.json` runs the collector **once a day at 06:00 UTC** (Vercel's free Hobby plan allows daily cron only).
Press **Collect now** on the Sources page any time. The cron call is protected by `CRON_SECRET`.

## 7. Known limits
- **Reddit may still be blocked** from Vercel's servers (cloud IPs are often refused). App Store reviews always work.
  The real fix is the official Reddit API (add the three `REDDIT_*` env vars once approved).
- Rotating your MCP key revokes the old one immediately — update Claude's config when you do. (Connector sign-ins use separate OAuth tokens that rotating the key does not revoke; remove the connector in Claude to disconnect.)
