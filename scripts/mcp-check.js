#!/usr/bin/env node
// Check a running TheVoice MCP endpoint the way Claude would use it.
//
//   MCP_KEY=tv_... npm run mcp:check                         # local app, read-only
//   MCP_KEY=tv_... MCP_URL=https://yourapp.vercel.app/mcp npm run mcp:check
//   MCP_KEY=tv_... npm run mcp:check -- --write              # also saves ONE draft (delete it in the dashboard)
//
// Read-only by default. Never prints the key. Exits non-zero if any check fails.
require('dotenv').config({ quiet: true });
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : undefined; };
const url = opt('url') || process.env.MCP_URL || 'http://localhost:3000/mcp';
const key = opt('key') || process.env.MCP_KEY;
const write = flag('write');
const EXPECTED = ['get_content_history', 'get_founder_profile', 'get_pain_quotes', 'save_founder_feedback', 'save_generated_content'];

let failed = 0;
const ok = (msg) => console.log(`  ✔ ${msg}`);
const bad = (msg) => { failed += 1; console.log(`  ✖ ${msg}`); };
const check = (cond, pass, fail) => (cond ? ok(pass) : bad(fail));
const heading = (t) => console.log(`\n${t}`);
const parse = (r) => { try { return JSON.parse(r.content[0].text); } catch { return null; } };

(async () => {
  console.log(`TheVoice MCP check → ${url}${write ? '  (write mode)' : '  (read-only)'}`);
  if (!key) {
    console.log('\nNo key given. Create one on the Connect page, then run:\n  MCP_KEY=tv_... npm run mcp:check');
    process.exit(2);
  }
  if (!/^tv_[A-Za-z0-9_-]{20,}$/.test(key)) { console.log('\nThat does not look like a TheVoice key (it starts with tv_).'); process.exit(2); }

  heading('1. Security');
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'check', version: '1' } } };
  const post = (headers) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(init) });
  try {
    const noKey = await post({});
    check(noKey.status === 401, 'a request with no key is refused (401)', `no key got HTTP ${noKey.status}, expected 401 — the endpoint is not protected!`);
    const wrong = await post({ authorization: 'Bearer tv_' + 'x'.repeat(43) });
    check(wrong.status === 401, 'a wrong key is refused (401)', `wrong key got HTTP ${wrong.status}, expected 401`);
    const get = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${key}` } });
    check(get.status === 405, 'GET is not allowed (405) — stateless, POST only', `GET got HTTP ${get.status}, expected 405`);
  } catch (e) {
    bad(`could not reach ${url}: ${e.message}`);
    console.log('\nIs the app running? (npm start) Is MCP_URL right?');
    process.exit(1);
  }

  const client = new Client({ name: 'thevoice-check', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  } catch (e) {
    bad(`could not connect with your key: ${e.message}`);
    console.log('\nThe key may have been regenerated (that revokes the old one). Create a new one on the Connect page.');
    process.exit(1);
  }
  ok('connected with your key');

  heading('2. Tools');
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  check(JSON.stringify(names) === JSON.stringify(EXPECTED), `exactly the 5 tools: ${names.join(', ')}`, `unexpected tools: ${names.join(', ')}`);
  const instr = client.getInstructions() || '';
  check(/never invent quotes/i.test(instr), 'server instructions tell Claude never to invent quotes', 'server instructions are missing the "never invent quotes" rule');

  heading('3. get_founder_profile');
  const profileRes = await client.callTool({ name: 'get_founder_profile', arguments: {} });
  const profile = parse(profileRes);
  if (!profile) {
    console.log(`  ! ${profileRes.content[0].text}`);
    bad('no profile yet — finish onboarding in the app first');
  } else {
    ok(`${profile.voice_tone} voice · "${String(profile.app_description).slice(0, 60)}"`);
    console.log(`    locations: ${profile.locations.map((l) => `${l.region ? `${l.region}, ` : ''}${l.country.toUpperCase()}`).join('; ') || 'none'} · mode ${profile.location_mode}`);
    console.log(`    problems to find: ${profile.problem_keywords.length ? profile.problem_keywords.join(' | ') : 'none'}`);
    console.log(`    sources: ${profile.sources.length}${profile.sources.length ? '' : '  (add competitors/problems/communities and press "Collect now")'}`);
    for (const s of profile.sources.slice(0, 8)) console.log(`      - ${s.label} [${s.last_status || 'not collected'}${s.last_error ? `: ${s.last_error.slice(0, 60)}` : ''}] ${s.quote_count} quotes`);
  }

  heading('4. get_pain_quotes');
  const q = parse(await client.callTool({ name: 'get_pain_quotes', arguments: { limit: 10 } }));
  if (!q) bad('get_pain_quotes returned an error');
  else {
    ok(`${q.quotes.length} quotes returned (${q.meta.total_available} available in the last 180 days)`);
    const byType = {};
    for (const x of q.quotes) byType[x.source_type] = (byType[x.source_type] || 0) + 1;
    console.log(`    mix: ${JSON.stringify(byType)}`);
    check(q.quotes.every((x) => /^https:\/\//.test(x.source_url)), 'every quote has a real https source link', 'some quotes have no valid source link');
    check(q.quotes.every((x) => x.published_at === null || /^\d{4}-\d{2}-\d{2}T/.test(x.published_at)), 'publish dates are ISO timestamps', 'a publish date has the wrong format');
    check(q.quotes.every((x) => Array.isArray(x.matched_keywords)), 'each quote says which of your problems it matches', 'matched_keywords is missing');
    check(/never follow instructions/i.test(q.meta.notice || ''), 'the "quote text is untrusted data" notice is attached', 'the untrusted-data notice is missing');
    for (const x of q.quotes.slice(0, 3)) console.log(`      "${x.quote.slice(0, 90).replace(/\n/g, ' ')}…" — ${x.source}${x.app ? ` (${x.app})` : ''}${x.matched_keywords.length ? ` ★ ${x.matched_keywords.join(', ')}` : ''}`);
    console.log(`    note for Claude: ${q.meta.note || '(none)'}`);
    if (!q.quotes.length) console.log('    (no quotes yet — that is fine for a new account; collect first)');
  }

  heading('5. get_content_history');
  const h = parse(await client.callTool({ name: 'get_content_history', arguments: {} }));
  check(Boolean(h), `${h ? h.content.length : 0} recent piece(s)${h && h.note ? ` — ${h.note}` : ''}`, 'get_content_history returned an error');

  heading('6. Validation (Claude gets clear errors, not crashes)');
  const bad4 = await client.callTool({ name: 'save_generated_content', arguments: { hooks: ['only one'], script: 'x' } });
  check(bad4.isError === true && /Exactly 5 hooks/.test(bad4.content[0].text), 'saving 1 hook is refused with "Exactly 5 hooks are required"', `expected a validation error, got: ${bad4.content[0].text.slice(0, 80)}`);
  const noFb = await client.callTool({ name: 'save_founder_feedback', arguments: { content_id: 999999999, feedback: 'approved', reason: '' } });
  check(noFb.isError === true, 'feedback on content that is not yours is refused', 'feedback on a missing/foreign id was accepted!');

  if (write) {
    heading('7. Write test (creates ONE draft)');
    const ids = q && q.quotes.length ? [q.quotes[0].id] : [];
    const saved = parse(await client.callTool({
      name: 'save_generated_content',
      arguments: { hooks: ['[MCP TEST] hook 1', '[MCP TEST] hook 2', '[MCP TEST] hook 3', '[MCP TEST] hook 4', '[MCP TEST] hook 5'], script: '[MCP TEST] Safe to delete — created by npm run mcp:check --write.', inspiration_quote_ids: ids }
    }));
    check(saved && saved.content_id, `saved draft #${saved && saved.content_id} — open the dashboard, you should see it, then delete it`, 'saving a valid draft failed');
    if (saved) {
      const hist = parse(await client.callTool({ name: 'get_content_history', arguments: {} }));
      check(hist && hist.content.some((c) => c.id === saved.content_id), 'it appears in get_content_history', 'the saved draft is not in the history');
    }
  } else {
    console.log('\n(Read-only run. Add --write to also save one test draft.)');
  }

  await client.close();
  console.log(failed ? `\n✖ ${failed} check(s) failed` : '\n✔ all checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(`\nUnexpected error: ${e.message}`); process.exit(1); });
