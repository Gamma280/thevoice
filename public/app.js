/* TheVoice frontend — one file, no framework, no inline scripts (CSP: script-src 'self').
 * Safety rule: dynamic text ONLY goes through textContent (el() text nodes). There is no innerHTML anywhere,
 * because quotes come from the public internet and must be treated as hostile. */
(function () {
  'use strict';

  /* ===================================================================== helpers */
  class ApiError extends Error {
    constructor(status, message, details) { super(message); this.status = status; this.details = details; }
  }

  // JSON fetch wrapper. Always sends Content-Type: application/json (the server's CSRF guard requires it).
  async function api(method, url, body, { allow401 = false } = {}) {
    let res;
    try {
      res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty or non-JSON body */ }
    if (res.status === 401 && !allow401) { go('/login.html'); throw new ApiError(401, 'Please log in.'); }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`, data && data.details);
    return data;
  }

  // DOM builder: el('div', {class:'x', onclick:fn}, 'text', childNode, ...). Strings become TEXT nodes.
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected' || k === 'required') { if (v) node[k] = true; }
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c === undefined || c === null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  // All redirects go through go() so tests can observe them (jsdom cannot navigate).
  const go = (url) => { if (typeof window.__navigate === 'function') window.__navigate(url); else location.href = url; };
  const $ = (sel, root) => (root || document).querySelector(sel);
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function mount(node, ...children) { clear(node); for (const c of children.flat()) if (c) node.append(c); return node; }

  // Only ever link to https URLs (quote source links come from stored data).
  const safeHref = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);
  function sourceLink(url, text) {
    const href = safeHref(url);
    return href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : el('span', {}, text);
  }

  // SQLite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS"
  function parseDbDate(s) {
    if (!s) return null;
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(s) {
    const d = parseDbDate(s);
    return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  }
  function relTime(ms) {
    if (!ms) return 'never';
    const diff = Date.now() - ms;
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} h ago`;
    return `${Math.round(hrs / 24)} d ago`;
  }
  const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
  // "Published Nov 8, 2026" from epoch ms (quotes) — empty when the source gave no date
  function fmtPublished(ms) {
    if (!ms) return '';
    const d = new Date(Number(ms));
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  // One consistent line under every quote: where it came from, WHICH APP it's about, and WHEN it was published.
  //   App Store:   "App Store review (★1) of Robinhood: Trading & Investing · Published Nov 8, 2026"
  //   Reddit post: "Reddit r/Daytrading about Robinhood · Published Nov 8, 2026"
  function quoteMeta(q, ...extra) {
    const kind = q.source_type || (/^Reddit/.test(q.source) ? 'reddit' : 'app_store');
    const date = fmtPublished(q.published_at);
    const parts = [sourceLink(q.source_url, q.source)];
    if (q.app) parts.push(kind === 'app_store' ? ' of ' : ' about ', el('strong', { class: 'app' }, q.app));
    parts.push(date ? ` · Published ${date}` : ' · date unknown');
    for (const k of q.matched_keywords || []) parts.push(' ', el('span', { class: 'chip kw', title: 'Matches a problem you are tracking' }, `“${k}”`));
    // Reddit sometimes shows "blocked by network security" on VPNs/shared networks. The full excerpt is already shown
    // above, and these give a way around it: copy the link, or try the old Reddit front-end.
    const href = safeHref(q.source_url);
    if (kind !== 'app_store' && href && /^https:\/\/www\.reddit\.com\//i.test(href)) {
      parts.push(' · ',
        el('button', { type: 'button', class: 'btn link small copy-link', 'aria-label': 'Copy the Reddit link', onclick: async () => toast((await copyText(href)) ? 'Link copied — paste it in another browser or network.' : 'Couldn’t copy the link.') }, 'Copy link'),
        ' · ', el('a', { class: 'old-reddit', href: href.replace('://www.reddit.com', '://old.reddit.com'), target: '_blank', rel: 'noopener noreferrer', title: 'Reddit’s older site — sometimes opens when the new one is blocked' }, 'old.reddit.com'));
    }
    return el('div', { class: 'src' }, parts, ...extra);
  }
  const flag = (cc) => String(cc || '').toUpperCase();
  const locLabel = (l) => (l ? `${l.region ? `${l.region}, ` : ''}${flag(l.country)}` : '');

  /* ===================================================================== toast + modal */
  function toast(message, ms = 3500) {
    let region = $('#toast-region');
    if (!region) { region = el('div', { id: 'toast-region', class: 'toast-region', 'aria-live': 'polite', role: 'status' }); document.body.append(region); }
    const t = el('div', { class: 'toast' }, message);
    clear(region).append(t);
    setTimeout(() => { if (t.parentNode) t.remove(); }, ms);
  }

  // Accessible modal: role=dialog, focus moves in and returns, Tab is trapped, Escape cancels.
  // Resolves { value } on confirm, null on cancel. `textarea` adds a (skippable) reason box.
  function openModal({ title, body, textarea, confirmText = 'Save', cancelText = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const opener = document.activeElement;
      const ta = textarea ? el('textarea', { id: 'modal-input', placeholder: textarea.placeholder || '', 'aria-label': textarea.label }) : null;
      const confirmBtn = el('button', { type: 'button', class: `btn${danger ? ' danger' : ''}` }, confirmText);
      const cancelBtn = el('button', { type: 'button', class: 'btn secondary' }, cancelText);
      const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' },
        el('h2', { id: 'modal-title' }, title),
        body ? el('p', { class: 'muted' }, body) : null,
        ta ? el('div', { class: 'field' }, el('label', { for: 'modal-input' }, textarea.label), ta, el('p', { class: 'hint' }, 'Optional — you can leave this blank.')) : null,
        el('div', { class: 'actions' }, cancelBtn, confirmBtn));
      const overlay = el('div', { class: 'overlay' }, modal);
      const close = (result) => { document.removeEventListener('keydown', onKey, true); overlay.remove(); if (opener && opener.focus) opener.focus(); resolve(result); };
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
        if (e.key === 'Tab') {
          const f = [...modal.querySelectorAll('button, textarea, input, select, a[href]')].filter((n) => !n.disabled);
          if (!f.length) return;
          const first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      confirmBtn.addEventListener('click', () => close({ value: ta ? ta.value.trim() : '' }));
      cancelBtn.addEventListener('click', () => close(null));
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
      document.addEventListener('keydown', onKey, true);
      document.body.append(overlay);
      (ta || confirmBtn).focus();
    });
  }

  /* ===================================================================== chrome: header + guards */
  const NAV = [['dashboard', '/dashboard.html', 'Dashboard'], ['sources', '/sources.html', 'Sources'], ['connect', '/connect.html', 'Connect'], ['index', '/index.html', 'Profile']];

  function renderHeader(page, authed) {
    const host = $('#site-header');
    if (!host) return;
    const nav = el('nav', { class: 'nav', 'aria-label': 'Main' });
    if (authed) {
      for (const [id, href, label] of NAV) nav.append(el('a', { href, 'aria-current': id === page ? 'page' : null }, label));
      nav.append(el('button', { type: 'button', onclick: logout }, 'Log out'));
    }
    host.className = 'site-header';
    mount(host, el('div', { class: 'inner' }, el('a', { class: 'logo', href: authed ? '/dashboard.html' : '/login.html' }, 'The', el('span', {}, 'Voice')), nav));
  }

  async function logout() {
    try { await api('POST', '/api/auth/logout', {}, { allow401: true }); } catch (e) { /* ignore */ }
    go('/login.html');
  }

  async function getMe() { return api('GET', '/api/auth/me', undefined, { allow401: true }).catch((e) => { if (e.status === 401) return null; throw e; }); }

  // Protected page guard. needsProfile pages bounce to onboarding until a profile exists.
  async function requireLogin(page, { needsProfile = true } = {}) {
    const me = await getMe();
    if (!me) { go('/login.html'); return null; }
    if (needsProfile && !me.hasProfile) { go('/index.html'); return null; }
    renderHeader(page, true);
    return me;
  }

  const errorBox = (msg) => el('div', { class: 'alert error', role: 'alert' }, msg);
  function showError(host, err) {
    const msg = err instanceof ApiError || err instanceof Error ? err.message : String(err);
    const detail = err && err.details && err.details.length ? ` (${err.details.map((d) => d.message).join('; ')})` : '';
    mount(host, errorBox(msg + detail));
  }
  const pageError = (err) => { const m = $('#main'); if (m) mount(m, errorBox(err.message || 'Something went wrong.')); };

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    try {
      const ta = el('textarea', { 'aria-hidden': 'true' }); ta.value = text; document.body.append(ta); ta.select();
      const ok = document.execCommand && document.execCommand('copy'); ta.remove(); return Boolean(ok);
    } catch (e) { return false; }
  }

  /* ===================================================================== auth pages */
  async function initAuth(kind) {
    renderHeader(kind, false);
    const form = $('#auth-form'), box = $('#form-error'), btn = $('#submit');
    // Attach the handler first so a fast submit is never ignored; the logged-in check runs alongside.
    // After sign-in, return to a pending connector approval (/oauth/authorize?…) instead of the dashboard.
    const nextParam = new URLSearchParams(location.search).get('next') || '';
    const next = /^\/oauth\/authorize\?/.test(nextParam) ? nextParam : null;
    if (next) document.querySelectorAll('a[href="/signup.html"], a[href="/login.html"]').forEach((a) => { a.href += `?next=${encodeURIComponent(next)}`; });
    const after = (me) => next || (me.hasProfile ? '/dashboard.html' : '/index.html');
    getMe().then((me) => { if (me) go(after(me)); }).catch(() => {});
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(box);
      btn.disabled = true;
      try {
        const out = await api('POST', `/api/auth/${kind}`, { email: $('#email').value, password: $('#password').value }, { allow401: true });
        go(after(out));
      } catch (err) {
        showError(box, err);
        btn.disabled = false;
      }
    });
  }

  /* ===================================================================== onboarding (index.html) */
  async function initOnboarding() {
    const me = await requireLogin('index', { needsProfile: false });
    if (!me) return;
    const main = $('#main');
    const state = {
      countries: [], rows: [], communities: [], suggestions: [],
      competitors: [],             // chosen competitor apps: { external_id, name, brand }  (max 5)
      mentions: true,              // also collect Reddit complaints about them
      keywords: [],                // problems to find in their users (max 8)
      existingLocations: 0, reddit: { enabled: true }
    };
    let founder = null;
    try {
      state.countries = await api('GET', '/api/countries');
      const src = await api('GET', '/api/sources');
      state.reddit = src.reddit;
      founder = await api('GET', '/api/founder').catch((e) => { if (e.status === 404) return null; throw e; });
      if (founder) {
        state.rows = founder.locations.map((l) => ({ country: l.country, region: l.region }));
        state.existingLocations = founder.locations.length;
        state.competitors = (founder.competitors || []).map((c) => ({ external_id: c.external_id, name: c.name, brand: c.brand }));
        state.mentions = Boolean(founder.competitor_mentions);
        state.keywords = [...(founder.keywords || [])];
        state.communities = founder.sources.filter((s) => s.role === 'community')
          .map((s) => ({ name: s.label.replace(/^r\//, ''), country: s.location ? s.location.country : '', region: s.location ? s.location.region : '' }));
      }
    } catch (err) { return pageError(err); }
    if (!state.rows.length) state.rows.push({ country: 'us', region: '' });

    const $v = (id) => $(`#${id}`).value;
    const countryByCode = (c) => state.countries.find((x) => x.code === c);

    // ---- locations
    const locHost = $('#locations');
    function renderLocations() {
      const rows = state.rows.map((r, i) => {
        const sel = el('select', { id: `loc-country-${i}`, 'aria-label': `Country ${i + 1}`, onchange: (e) => { r.country = e.target.value; render(); } },
          state.countries.map((c) => el('option', { value: c.code, selected: c.code === r.country }, c.name)));
        const region = el('input', { type: 'text', id: `loc-region-${i}`, 'aria-label': `City or region ${i + 1} (optional)`, placeholder: 'City or region (optional)', maxlength: 60, value: r.region, oninput: (e) => { r.region = e.target.value; } });
        const canRemove = state.rows.length > 1;
        const info = countryByCode(r.country);
        return el('li', {},
          el('div', { class: 'row' },
            el('div', { class: 'grow' }, sel), el('div', { class: 'grow' }, region),
            el('button', { type: 'button', class: 'btn secondary small', disabled: !canRemove, 'aria-label': `Remove location ${i + 1}`, onclick: () => { state.rows.splice(i, 1); render(); } }, 'Remove')),
          info && !info.english ? el('p', { class: 'alert warn small', role: 'note' }, `${info.name} isn't primarily English. TheVoice only keeps English text, so most quotes from there will be filtered out.`) : null);
      });
      mount(locHost, el('ul', { class: 'list' }, rows),
        el('div', { class: 'row' },
          el('button', { type: 'button', id: 'add-location', class: 'btn secondary small', disabled: state.rows.length >= 3, onclick: () => { state.rows.push({ country: 'us', region: '' }); render(); } }, 'Add another location'),
          el('span', { class: 'hint' }, `${state.rows.length}/3 locations`)));
    }

    // ---- competitors (search, then add up to 5)
    const MAX_COMPETITORS = 5;
    const compHost = $('#competitor-result'), chosenHost = $('#chosen-competitors');
    let lastResults = null;
    const hasApp = (id) => state.competitors.some((c) => c.external_id === id);
    function renderCompetitors() {
      mount(chosenHost,
        state.competitors.length
          ? el('div', { class: 'chips', 'aria-label': 'Chosen competitors' }, state.competitors.map((c, i) =>
              el('span', { class: 'chip loc' }, c.name, el('button', { type: 'button', 'aria-label': `Remove ${c.name}`, onclick: () => { state.competitors.splice(i, 1); renderCompetitors(); } }, '×'))))
          : el('p', { class: 'hint' }, 'No competitors added yet.'),
        el('p', { class: 'hint' }, `${state.competitors.length}/${MAX_COMPETITORS} competitors`));
      const mentionsBox = $('#mentions-wrap');
      if (mentionsBox) mentionsBox.hidden = !state.reddit.enabled;
      if (lastResults) renderResults(lastResults);
    }
    function renderResults(results) {
      lastResults = results;
      const items = [];
      if (!results.length) items.push(el('p', { class: 'muted small' }, 'No apps found. Try the exact name or paste the App Store link.'));
      results.forEach((r, i) => {
        const added = hasApp(r.external_id);
        const full = !added && state.competitors.length >= MAX_COMPETITORS;
        // Toggle: click to select (row highlights), click again to deselect.
        items.push(el('div', { class: `pick row between${added ? ' selected' : ''}`, 'data-app': r.external_id },
          el('span', {}, el('strong', {}, r.name || r.label), r.developer ? el('span', { class: 'muted' }, ` — ${r.developer}`) : null),
          el('button', { type: 'button', id: `app-${i}`, class: `btn small${added ? '' : ' secondary'}`, 'aria-pressed': String(added),
            disabled: full, title: full ? `You can add up to ${MAX_COMPETITORS} competitors` : null,
            'aria-label': `${added ? 'Deselect' : 'Select'} ${r.name || r.label}`,
            onclick: () => {
              const at = state.competitors.findIndex((c) => c.external_id === r.external_id);
              if (at > -1) state.competitors.splice(at, 1);
              else if (state.competitors.length < MAX_COMPETITORS) state.competitors.push({ external_id: r.external_id, name: r.name || r.label, brand: r.brand || r.name || r.label });
              renderCompetitors();
            } }, added ? '✓ Selected' : 'Select')));
      });
      mount(compHost, items);
    }
    $('#find-app').addEventListener('click', async () => {
      const q = $v('competitor').trim();
      if (q.length < 2) { mount(compHost, errorBox('Type at least 2 characters to search.')); return; }
      const btn = $('#find-app'); btn.disabled = true;
      try { renderResults(await api('GET', `/api/sources/resolve?q=${encodeURIComponent(q)}&country=${encodeURIComponent(state.rows[0].country)}`)); }
      catch (err) { showError(compHost, err); }
      btn.disabled = false;
    });
    $('#mentions').checked = state.mentions && state.reddit.enabled;
    $('#mentions').addEventListener('change', (e) => { state.mentions = e.target.checked; });

    // ---- problems to find in their users
    const MAX_PROBLEMS = 8;
    const chosenProblems = $('#chosen-problems'), problemErr = $('#problem-error'), problemInput = $('#problem-input');
    function renderProblems() {
      mount(chosenProblems,
        state.keywords.length
          ? el('div', { class: 'chips', 'aria-label': 'Problems to find' }, state.keywords.map((k, i) =>
              el('span', { class: 'chip kw' }, `“${k}”`, el('button', { type: 'button', 'aria-label': `Remove ${k}`, onclick: () => { state.keywords.splice(i, 1); renderProblems(); } }, '×'))))
          : el('p', { class: 'hint' }, 'No problems added yet.'),
        el('p', { class: 'hint' }, `${state.keywords.length}/${MAX_PROBLEMS} problems`));
    }
    function addProblem() {
      clear(problemErr);
      const text = problemInput.value.replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (text.length < 3) { mount(problemErr, errorBox('Write at least 3 characters, e.g. “revenge trading”.')); return; }
      if (state.keywords.some((k) => k.toLowerCase() === text.toLowerCase())) { mount(problemErr, errorBox('You already added that one.')); return; }
      if (state.keywords.length >= MAX_PROBLEMS) { mount(problemErr, errorBox(`You can track up to ${MAX_PROBLEMS} problems.`)); return; }
      state.keywords.push(text.slice(0, 60));
      problemInput.value = '';
      renderProblems();
    }
    $('#add-problem').addEventListener('click', addProblem);
    problemInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addProblem(); } });

    // ---- communities
    const commHost = $('#communities');
    const hasComm = (name) => state.communities.some((c) => c.name.toLowerCase() === name.toLowerCase());
    function addCommunity(c) {
      if (hasComm(c.name)) return;
      if (state.communities.length >= 8) { toast('You can follow at most 8 communities.'); return; }
      state.communities.push(c);
    }
    function renderCommunities() {
      if (!state.reddit.enabled) { mount(commHost, el('p', { class: 'alert info' }, 'Reddit collection is switched off on this server, so communities are skipped.')); return; }
      const locSelect = el('select', { id: 'comm-loc', 'aria-label': 'Location this community belongs to' },
        ...state.rows.map((r, i) => el('option', { value: String(i) }, `Local to ${r.region ? `${r.region}, ` : ''}${flag(r.country)}`)),
        el('option', { value: '' }, 'Not location-specific'));
      const nameIn = el('input', { type: 'text', id: 'comm-name', placeholder: 'subreddit, e.g. mumbai', 'aria-label': 'Subreddit name', maxlength: 25 });
      const addBtn = el('button', { type: 'button', id: 'add-community', class: 'btn secondary', onclick: () => {
        const name = nameIn.value.trim().replace(/^\/?r\//i, '');
        if (!/^[A-Za-z0-9_]{2,21}$/.test(name)) { toast('Enter a valid subreddit name (letters, numbers, underscores).'); return; }
        const row = locSelect.value === '' ? null : state.rows[Number(locSelect.value)];
        addCommunity({ name, country: row ? row.country : '', region: row ? row.region : '' });
        render();
      } }, 'Add');
      const chips = state.communities.map((c, i) => el('span', { class: 'chip loc' }, `r/${c.name}`, c.country ? ` · ${c.region ? `${c.region}, ` : ''}${flag(c.country)}` : ' · anywhere',
        el('button', { type: 'button', 'aria-label': `Remove r/${c.name}`, onclick: () => { state.communities.splice(i, 1); render(); } }, '×')));
      const sugg = state.suggestions.map((s) => {
        const checked = hasComm(s.name);
        return el('label', { class: 'pick' },
          el('input', { type: 'checkbox', checked, onchange: (e) => {
            if (e.target.checked) addCommunity({ name: s.name, country: s.country, region: s.scope === 'region' ? s.region : (s.region || '') });
            else { const i = state.communities.findIndex((c) => c.name.toLowerCase() === s.name.toLowerCase()); if (i > -1) state.communities.splice(i, 1); }
            render();
          } }),
          el('strong', {}, `r/${s.name}`), ` ${fmtNum(s.subscribers)} members `, el('span', { class: 'chip loc' }, s.scope === 'region' ? (s.region || 'local') : `${flag(s.country)} country`));
      });
      mount(commHost,
        el('div', { class: 'row' }, el('button', { type: 'button', id: 'suggest', class: 'btn secondary', onclick: suggest }, 'Suggest local communities')),
        state.suggestNote ? el('p', { class: 'hint' }, state.suggestNote) : null,
        sugg.length ? el('div', {}, sugg) : null,
        el('div', { class: 'row field' }, el('div', { class: 'grow' }, nameIn), el('div', { class: 'grow' }, locSelect), addBtn),
        el('div', { class: 'chips', id: 'chosen' }, chips),
        el('p', { class: 'hint' }, `${state.communities.length}/8 communities. Reddit has no location filter, so "local" means a subreddit for that place.`));
    }
    async function suggest() {
      const btn = $('#suggest'); btn.disabled = true; state.suggestNote = ''; state.suggestions = [];
      try {
        const seen = new Set();
        for (const r of state.rows) {
          const out = await api('GET', `/api/locations/suggest?country=${encodeURIComponent(r.country)}&region=${encodeURIComponent(r.region || '')}`);
          if (out.note) state.suggestNote = out.note;
          for (const s of out.suggestions) if (!seen.has(s.name.toLowerCase())) { seen.add(s.name.toLowerCase()); state.suggestions.push(s); }
        }
        if (!state.suggestions.length && !state.suggestNote) state.suggestNote = 'No suggestions found. You can type a subreddit name below.';
      } catch (err) { state.suggestNote = err.message; }
      render();
    }

    function render() { renderLocations(); renderCommunities(); }
    render();
    renderCompetitors();
    renderProblems();

    if (founder) {
      $('#app_description').value = founder.app_description;
      $('#target_user').value = founder.target_user;
      $('#voice_tone').value = founder.voice_tone;
      $('#niche').value = founder.niche || '';
    }

    // ---- submit
    const form = $('#setup-form'), errBox = $('#form-error'), submit = $('#submit');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(errBox);
      const typed = $v('competitor').trim();
      // Competitors are optional: a founder can track problems and/or communities instead.
      const keyOf = (c, r) => `${c}|${String(r || '').trim().toLowerCase()}`;
      const rowKeys = new Set(state.rows.map((r) => keyOf(r.country, r.region)));
      const stale = state.reddit.enabled ? state.communities.find((c) => c.country && !rowKeys.has(keyOf(c.country, c.region))) : null;
      if (stale) { showError(errBox, new Error(`r/${stale.name} was tied to a location you changed. Remove it and add it again.`)); return; }
      const body = {
        app_description: $v('app_description'), target_user: $v('target_user'), voice_tone: $v('voice_tone'),
        competitor_url: state.competitors.length ? state.competitors.map((c) => c.name).join(', ').slice(0, 500) : '',
        problem_keywords: state.keywords,
        niche: $v('niche'),
        competitor_sources: state.competitors.map((c) => ({ type: 'app_store', external_id: c.external_id })),
        locations: state.rows.map((r) => ({ country: r.country, region: r.region.trim() })),
        communities: state.reddit.enabled ? state.communities.map((c) => (c.country ? { name: c.name, country: c.country, region: c.region } : { name: c.name })) : undefined
      };
      if (state.reddit.enabled) body.competitor_mentions = state.mentions;
      submit.disabled = true;
      try {
        const out = await api('POST', '/api/setup', body);
        if (!state.competitors.length && !state.keywords.length && !state.communities.length) {
          out.warnings = [...(out.warnings || []), { message: 'You haven’t added any competitors, problems or communities yet, so there is nothing to collect. Add some on your Profile page whenever you’re ready.' }];
        }
        await collectStep(out, !founder);
      } catch (err) { showError(errBox, err); submit.disabled = false; }
    });

    // ---- first collection with visible progress
    async function collectStep(setup, firstTime) {
      const next = firstTime ? '/connect.html' : '/dashboard.html';
      const status = el('div', { role: 'status', 'aria-live': 'polite' });
      const panel = el('div', { class: 'card stack' }, el('h2', {}, 'Collecting your audience’s pain…'), el('p', { class: 'muted' }, 'This usually takes under a minute. We’re reading real reviews and posts and keeping the ones that sound like pain.'), status);
      mount(main, panel);
      for (const w of setup.warnings || []) status.append(el('p', { class: 'alert warn' }, w.message));
      let result;
      try { result = await api('POST', '/api/collect', {}); }
      catch (err) {
        status.append(el('p', { class: 'alert warn' }, err.status === 429 ? 'Collection was started recently — it will continue on its own schedule.' : `Collection didn’t finish: ${err.message}`));
      }
      mount(panel, el('h2', {}, 'You’re set up'));
      for (const w of setup.warnings || []) panel.append(el('p', { class: 'alert warn' }, w.message));
      if (result) {
        const list = el('ul', { class: 'list' }, result.results.map((r) => el('li', {}, el('strong', {}, r.label), ' ',
          r.status === 'ok' ? el('span', { class: 'chip ok' }, `${r.inserted} new quotes`) : el('span', { class: `chip ${r.status === 'error' ? 'error' : 'disabled'}` }, r.status === 'error' ? 'failed' : r.status),
          r.status === 'error' ? el('div', { class: 'hint' }, `${r.error} — it will retry automatically.`) : null)));
        panel.append(result.results.length ? list : el('p', { class: 'muted' }, 'Nothing new to collect right now.'));
      }
      panel.append(el('div', { class: 'actions' }, el('a', { class: 'btn', id: 'continue', href: next }, firstTime ? 'Continue — connect Claude' : 'Go to dashboard')));
    }
  }

  /* ===================================================================== dashboard */
  const GENERATE_PROMPT = 'Use TheVoice: read my profile, pain quotes and history, then write 5 hooks and a script and save them.';

  async function initDashboard() {
    const me = await requireLogin('dashboard');
    if (!me) return;
    const list = $('#content-list'), empty = $('#empty'), status = $('#status');
    $('#generate').addEventListener('click', async () => {
      const ok = await copyText(GENERATE_PROMPT);
      toast(ok ? 'Prompt copied — paste it into Claude.' : 'Couldn’t copy automatically. Prompt: ' + GENERATE_PROMPT, ok ? 3500 : 9000);
    });
    $('#refresh').addEventListener('click', load);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); }); // coming back from Claude

    const open = new Set();   // expanded card ids survive reloads
    async function load() {
      try {
        const items = await api('GET', '/api/content');
        mount(status);
        render(items);
      } catch (err) { showError(status, err); }
    }

    async function render(items) {
      clear(list);
      if (!items.length) {
        let collecting = false;
        try { collecting = (await api('GET', '/api/pain-quotes?limit=1')).length === 0; } catch (e) { /* default to connect message */ }
        mount(empty, collecting
          ? el('div', { class: 'empty' }, el('h2', {}, 'We’re still collecting your audience’s pain'), el('p', { class: 'muted' }, 'No quotes yet. Check the Sources page to see progress or collect now.'), el('a', { class: 'btn', href: '/sources.html' }, 'Open Sources'))
          : el('div', { class: 'empty' }, el('h2', {}, 'Nothing generated yet'), el('p', { class: 'muted' }, 'Claude writes the hooks; TheVoice remembers them.'), el('a', { class: 'btn', href: '/connect.html' }, 'Connect TheVoice to Claude to generate your first content →')));
        empty.hidden = false; return;
      }
      empty.hidden = true;
      for (const c of items) list.append(card(c));
    }

    function card(c) {
      const isOpen = open.has(c.id);
      const body = el('div', { class: 'card-body', id: `body-${c.id}`, hidden: !isOpen });
      const head = el('button', { type: 'button', class: 'card-head', 'aria-expanded': String(isOpen), 'aria-controls': `body-${c.id}`, onclick: () => {
        const nowOpen = body.hidden; body.hidden = !nowOpen; head.setAttribute('aria-expanded', String(nowOpen)); nowOpen ? open.add(c.id) : open.delete(c.id);
      } },
        el('div', {}, el('p', { class: 'card-title' }, c.hooks[0]), el('p', { class: 'card-meta' }, fmtDate(c.created_at), c.modified_at ? ` · edited ${fmtDate(c.modified_at)}` : '')),
        el('span', { class: `badge ${c.status}` }, c.status));
      const wrap = el('article', { class: 'card hoverable', 'data-id': String(c.id) }, head, body);
      renderView(c, body);
      return wrap;
    }

    function renderView(c, body) {
      mount(body,
        el('h3', {}, 'Hooks'), el('ol', { class: 'hooks' }, c.hooks.map((h) => el('li', {}, h))),
        el('h3', {}, 'Script'), el('div', { class: 'script' }, c.script),
        c.inspiration_quotes.length ? el('div', {}, el('h3', { class: 'field' }, 'Inspired by'), c.inspiration_quotes.map((q) =>
          el('div', { class: 'quote' }, el('div', {}, `“${q.quote}”`), quoteMeta(q)))) : null,
        c.feedback_reason ? el('p', { class: 'hint field' }, `Your note: ${c.feedback_reason}`) : null,
        el('div', { class: 'actions' },
          el('button', { type: 'button', class: 'btn secondary small', onclick: () => renderEdit(c, body) }, 'Edit'),
          el('button', { type: 'button', class: 'btn small', disabled: c.status === 'approved', onclick: () => approve(c) }, c.status === 'approved' ? 'Approved' : 'Approve'),
          el('button', { type: 'button', class: 'btn danger small', onclick: () => remove(c) }, 'Delete')));
    }

    function renderEdit(c, body) {
      const hookInputs = c.hooks.map((h, i) => el('input', { type: 'text', class: 'edit-hook', value: h, maxlength: 280, 'aria-label': `Hook ${i + 1}` }));
      const script = el('textarea', { 'aria-label': 'Script' }); script.value = c.script;
      const err = el('div', {});
      mount(body, el('h3', {}, 'Edit hooks'), hookInputs, el('h3', { class: 'field' }, 'Script'), script, err,
        el('div', { class: 'actions' },
          el('button', { type: 'button', class: 'btn small', onclick: async () => {
            const hooks = hookInputs.map((i) => i.value.trim());
            if (hooks.some((h) => !h) || !script.value.trim()) { showError(err, new Error('Every hook and the script need some text.')); return; }
            const m = await openModal({ title: 'What made you change this?', textarea: { label: 'Reason', placeholder: 'e.g. too salesy, made it punchier' }, confirmText: 'Save changes' });
            if (!m) return;
            try {
              await api('PUT', `/api/content/${c.id}`, { hooks, script: script.value.trim() });
              await api('POST', `/api/feedback/${c.id}`, { feedback: 'edited', reason: m.value });
              toast('Saved.'); await load();
            } catch (e) { showError(err, e); }
          } }, 'Save'),
          el('button', { type: 'button', class: 'btn secondary small', onclick: () => renderView(c, body) }, 'Cancel')));
    }

    async function approve(c) {
      const m = await openModal({ title: 'What worked well?', textarea: { label: 'Reason', placeholder: 'e.g. the first hook sounds like my users' }, confirmText: 'Approve' });
      if (!m) return;
      try { await api('POST', `/api/feedback/${c.id}`, { feedback: 'approved', reason: m.value }); toast('Approved.'); await load(); }
      catch (e) { showError(status, e); }
    }
    async function remove(c) {
      const m = await openModal({ title: 'Delete this content?', body: 'It disappears from your dashboard. Your note helps Claude avoid this next time.', textarea: { label: 'What didn’t work about this?', placeholder: 'e.g. too generic' }, confirmText: 'Delete', danger: true });
      if (!m) return;
      try {
        await api('DELETE', `/api/content/${c.id}`);
        await api('POST', `/api/feedback/${c.id}`, { feedback: 'deleted', reason: m.value });
        open.delete(c.id); toast('Deleted.'); await load();
      } catch (e) { showError(status, e); }
    }

    await load();
  }

  /* ===================================================================== sources */
  async function initSources() {
    const me = await requireLogin('sources');
    if (!me) return;
    const host = $('#sources'), status = $('#status'), quotesHost = $('#quotes'), results = $('#results');
    let data, grouped, problems;

    async function load() {
      try {
        [data, grouped, problems] = await Promise.all([api('GET', '/api/sources'), api('GET', '/api/competitors'), api('GET', '/api/problems')]);
        mount(status);
        renderSources();
        const [appQuotes, redditQuotes, problemQuotes] = await Promise.all([
          api('GET', '/api/pain-quotes?limit=5&source_type=app_store'), api('GET', '/api/pain-quotes?limit=5&source_type=reddit'),
          problems.problems.length ? api('GET', '/api/pain-quotes?limit=5&problems=1') : Promise.resolve([])]);
        renderQuotes(appQuotes, redditQuotes, problemQuotes);
      } catch (err) { showError(status, err); }
    }

    function statusChip(x) {
      // accepts either a raw status string (grouped view) or a source object with last_status (flat list)
      const st = typeof x === 'string' || x === null || x === undefined ? x : x.last_status;
      if (st === 'ok') return el('span', { class: 'chip ok' }, 'ok');
      if (st === 'error') return el('span', { class: 'chip error' }, 'error');
      if (st === 'disabled') return el('span', { class: 'chip disabled' }, 'disabled');
      return el('span', { class: 'chip pending' }, 'waiting to collect');
    }

    function renderSources() {
      // Raw reasons from upstream are shown in plain language
      const friendly = (msg) => {
        if (/403|blocking automated|blocked/i.test(String(msg))) return 'Reddit is blocking automated requests from this network, so its search can’t run. The official Reddit API fixes this. Apps with their own community (like r/swiggy) are still read. Retrying in a few hours.';
        if (/429|rate.?limit|limiting how fast/i.test(String(msg))) return 'Reddit is limiting how fast we can search. It retries automatically — or press “Collect now” again in a minute.';
        return msg;
      };
      // An OK source can still carry a remark (e.g. "only communities named after the app were read")
      const noteOf = (x) => (x.status === 'ok' && x.last_error ? el('div', { class: 'alert info small reddit-note' }, x.last_error) : null);
      const stamp = (x) => `${x.quote_count} quotes · last collected ${relTime(x.last_collected_at)}`;
      const problem = (x) => (x.status === 'error' && x.last_error ? el('div', { class: 'field-error' }, friendly(x.last_error)) : null);
      const countryNames = (grouped.locations || []).map((l) => l.country_name);
      const uniqueCountries = [...new Set(countryNames)];

      // ---- one card per company: its App Store entry per picked country + its Reddit complaints
      const companyCards = grouped.competitors.map((c) => {
        const storeRows = c.stores.map((x) => el('li', { 'data-source': String(x.source_id) },
          el('div', { class: 'row' }, el('strong', {}, sourceLink(x.url, 'App Store reviews')), el('span', { class: 'chip loc' }, x.country_name), statusChip(x.status)),
          el('div', { class: 'hint' }, stamp(x)), problem(x)));
        let redditRow;
        if (c.reddit) {
          const r = c.reddit;
          redditRow = el('li', { 'data-source': String(r.source_id), class: 'reddit-row' },
            el('div', { class: 'row' }, el('strong', {}, sourceLink(r.url, 'Reddit complaints')), statusChip(r.status)),
            el('div', { class: 'hint' }, `Searching all of Reddit for “${r.search_term}” · ${stamp(r)}`),
            uniqueCountries.length ? el('div', { class: 'row small' }, el('span', { class: 'muted' }, 'Your countries:'), uniqueCountries.map((n) => el('span', { class: 'chip loc' }, n))) : null,
            r.subreddits.length
              ? el('div', { class: 'chips subs' }, r.subreddits.map((x) => el('span', { class: `chip${x.related ? ' place' : ''}`, title: x.related ? 'This community looks related to one of your countries' : null },
                  `r/${x.name} · ${x.count}`, x.related ? ' ✓' : '')))
              : (r.status === 'ok' ? el('div', { class: 'hint' }, 'No complaints found yet.') : null),
            r.subreddits.some((x) => x.related) ? el('div', { class: 'hint' }, '✓ = a community whose name relates to your country. Reddit can’t filter a search by country, so other communities are shown too.') : null,
            noteOf(r),
            problem(r));
        } else {
          redditRow = el('li', {}, el('div', { class: 'row' }, el('strong', {}, 'Reddit complaints'), el('span', { class: 'chip' }, data.reddit.enabled ? 'off' : 'unavailable')),
            el('div', { class: 'hint' }, data.reddit.enabled ? 'Turn on “Also collect complaints from Reddit” on your Profile page.' : 'Reddit collection is switched off on this server.'));
        }
        return el('div', { class: 'card company', 'data-company': c.external_id },
          el('div', { class: 'row between' }, el('h3', {}, c.name), el('div', { class: 'row small' }, c.countries.map((x) => el('span', { class: 'chip loc' }, x.name)))),
          el('ul', { class: 'list' }, storeRows, redditRow));
      });

      // ---- problems the founder wants to find: Reddit search status + how many collected quotes match each
      const problemRows = problems.problems.map((pr) => {
        const r = pr.search;
        return el('li', { 'data-problem': pr.keyword },
          el('div', { class: 'row' }, el('strong', {}, `“${pr.keyword}”`), el('span', { class: 'chip kw' }, `${pr.matching_quotes} matching quotes`),
            r ? statusChip(r.status) : el('span', { class: 'chip' }, 'Reddit search off')),
          r ? el('div', { class: 'hint' }, `Searching Reddit for posts about this · ${stamp(r)}`) : el('div', { class: 'hint' }, data.reddit.enabled ? 'Not searched on Reddit yet — save your profile again to start.' : 'Reddit collection is off, so this only highlights matching quotes from your other sources.'),
          r && r.subreddits.length ? el('div', { class: 'chips subs' }, r.subreddits.map((x) => el('span', { class: 'chip' }, `r/${x.name} · ${x.count}`))) : null,
          r ? noteOf(r) : null, r ? problem(r) : null);
      });
      const problemsCard = el('div', { class: 'card', id: 'problems' },
        el('h2', {}, 'Problems you’re tracking'),
        problemRows.length ? el('ul', { class: 'list' }, problemRows)
          : el('p', { class: 'muted' }, 'No problems yet. Add what you want to find in your users — like “revenge trading” — on your Profile page.'),
        problemRows.length ? el('p', { class: 'hint' }, 'Promotions (courses, signal groups, self-promoted apps) are filtered out of these results.') : null);

      // ---- communities (not tied to a company) keep their Remove buttons
      const communityRows = data.sources.filter((x) => x.role === 'community').map((s) => el('li', { 'data-source': String(s.id) },
        el('div', { class: 'row between' },
          el('div', { class: 'grow' }, el('strong', {}, sourceLink(s.url, s.label)),
            el('div', { class: 'row small' }, s.location ? el('span', { class: 'chip loc' }, locLabel(s.location)) : el('span', { class: 'chip' }, 'not location-specific'), statusChip(s))),
          el('button', { type: 'button', class: 'btn secondary small', 'aria-label': `Remove ${s.label}`, onclick: () => unfollow(s) }, 'Remove')),
        el('div', { class: 'hint' }, `${s.quote_count} quotes · last collected ${relTime(s.last_collected_at)}`),
        s.last_status === 'error' && s.last_error ? el('div', { class: 'field-error' }, friendly(s.last_error)) : null,
        s.last_status === 'disabled' ? el('div', { class: 'hint' }, 'This source type is switched off on the server.') : null));

      const locOpts = [...data.locations.map((l) => el('option', { value: String(l.id) }, `Local to ${locLabel(l)}`)), el('option', { value: '' }, 'Not location-specific')];
      const nameIn = el('input', { type: 'text', id: 'add-name', placeholder: 'subreddit, e.g. mumbai', 'aria-label': 'Subreddit name', maxlength: 25 });
      const locSel = el('select', { id: 'add-loc', 'aria-label': 'Location' }, locOpts);
      const addErr = el('div', {});
      const strictBox = el('input', { type: 'checkbox', id: 'strict', checked: data.location_mode === 'strict', onchange: async (e) => {
        try { await api('POST', '/api/location-mode', { location_mode: e.target.checked ? 'strict' : 'all' }); toast(e.target.checked ? 'Only quotes from your locations.' : 'Showing quotes from everything you follow.'); await load(); }
        catch (err) { e.target.checked = !e.target.checked; showError(status, err); }
      } });

      mount(host,
        el('h2', {}, 'Your competitors'),
        companyCards.length ? companyCards : el('p', { class: 'muted' }, 'No competitors yet. Add some on your Profile page — or track problems and communities instead.'),
        problemsCard,
        el('div', { class: 'card' },
          el('h2', {}, 'Communities'),
          communityRows.length ? el('ul', { class: 'list' }, communityRows) : el('p', { class: 'muted' }, 'No communities yet. Add one below, or on your Profile page.'),
          data.locations.length ? el('label', { class: 'check field', for: 'strict' }, strictBox, el('span', {}, 'Only quotes from my locations', el('span', { class: 'hint' }, ' App Store reviews are country-level; Reddit quotes come from local communities. Competitor Reddit complaints always show.'))) : null),
        data.reddit.enabled ? el('div', { class: 'card field' }, el('h2', {}, 'Add a Reddit community'),
          el('div', { class: 'row' }, el('div', { class: 'grow' }, nameIn), data.locations.length ? el('div', { class: 'grow' }, locSel) : null,
            el('button', { type: 'button', class: 'btn', id: 'add-btn', onclick: add }, 'Add')), addErr)
          : el('p', { class: 'alert info field' }, 'Reddit collection is switched off on this server.'));

      async function add() {
        clear(addErr);
        const name = nameIn.value.trim().replace(/^\/?r\//i, '');
        const loc = data.locations.find((l) => String(l.id) === locSel.value);
        try {
          await api('POST', '/api/sources', Object.assign({ type: 'reddit', external_id: name }, loc ? { country: loc.country, region: loc.region } : {}));
          toast('Added.'); await load();
        } catch (err) { showError(addErr, err); }
      }
    }

    async function unfollow(s) {
      const m = await openModal({ title: `Remove ${s.label}?`, body: 'You can add it again later. Quotes already used in your content are kept.', confirmText: 'Remove', danger: true });
      if (!m) return;
      try { await api('DELETE', `/api/sources/${s.id}`); toast('Removed.'); await load(); } catch (err) { showError(status, err); }
    }

    function quoteItem(q) {
      return el('div', { class: 'quote' },
        el('div', {}, `“${q.quote}”`),
        quoteMeta(q, q.location ? ' · ' : '', q.location ? el('span', { class: 'chip loc' }, locLabel(q.location)) : null, q.source_type === 'reddit_search' ? ' ' : '', q.source_type === 'reddit_search' ? el('span', { class: 'chip' }, 'all regions') : null, q.mentions_location ? ' ' : '', q.mentions_location ? el('span', { class: 'chip place' }, 'names your place') : null));
    }
    // Two labelled groups: App Store reviews score higher than Reddit posts, so one mixed "top N" would hide Reddit entirely.
    function renderQuotes(appQuotes, redditQuotes, problemQuotes = []) {
      const redditSources = data.sources.filter((x) => x.type !== 'app_store');
      const redditEmpty = !redditSources.length
        ? 'No Reddit sources yet — turn on “Also collect complaints from Reddit” or add a community on your Profile page.'
        : (redditSources.every((x) => x.last_status === 'error')
          ? 'Reddit hasn’t returned anything yet (see the status above). It retries automatically — or press “Collect now”.'
          : 'No Reddit posts yet — nothing collected so far passed the complaint filter.');
      mount(quotesHost, el('div', { class: 'card' }, el('h2', {}, 'What Claude will see'),
        el('p', { class: 'muted small' }, 'A mix of your best recent quotes from each kind of source. Text is shown exactly as collected.'),
        problems.problems.length ? [
          el('h3', { class: 'field' }, 'Matching your problems'),
          problemQuotes.length ? problemQuotes.map(quoteItem) : el('p', { class: 'muted', id: 'problems-empty' }, 'No collected quote matches your problems yet. Reddit search for them runs on the schedule above; press “Collect now” to try now.')] : null,
        el('h3', { class: 'field' }, 'App Store reviews'),
        appQuotes.length ? appQuotes.map(quoteItem) : el('p', { class: 'muted' }, 'No App Store reviews yet — try “Collect now”.'),
        el('h3', { class: 'field' }, 'Reddit posts'),
        redditQuotes.length ? redditQuotes.map(quoteItem) : el('p', { class: 'muted', id: 'reddit-empty' }, redditEmpty)));
    }

    $('#collect').addEventListener('click', async () => {
      const btn = $('#collect'); btn.disabled = true; mount(results, el('p', { class: 'muted', role: 'status' }, 'Collecting… this can take up to 30 seconds.'));
      try {
        const r = await api('POST', '/api/collect', {});
        mount(results, r.results.length
          ? el('div', { class: 'card' }, el('h3', {}, 'Collection results'), el('ul', { class: 'list' }, r.results.map((x) => el('li', {}, el('strong', {}, x.label), ' ',
              x.status === 'ok' ? el('span', { class: 'chip ok' }, `${x.fetched} fetched · ${x.kept} kept · ${x.inserted} new`) : el('span', { class: `chip ${x.status === 'error' ? 'error' : 'disabled'}` }, x.status),
              x.error ? el('div', { class: 'field-error' }, x.error) : null))))
          : el('p', { class: 'alert info' }, 'Everything was collected recently — nothing is due yet. Sources refresh at most once an hour on demand and every 6 hours automatically.'));
        await load();
      } catch (err) {
        mount(results, err.status === 429 ? el('p', { class: 'alert warn' }, 'You’ve collected a lot in the last hour. Try again in a little while.') : errorBox(err.message));
      }
      btn.disabled = false;
    });

    await load();
  }

  /* ===================================================================== connect */
  async function initConnect() {
    const me = await requireLogin('connect');
    if (!me) return;
    const origin = location.origin;
    const mcpUrl = `${origin}/mcp`;
    $('#mcp-url').textContent = mcpUrl;
    $('#mcp-url-easy').textContent = mcpUrl;
    $('#copy-url-easy').addEventListener('click', async () => toast((await copyText(mcpUrl)) ? 'URL copied.' : 'Copy failed — select it manually.'));
    const meta = $('#key-meta'), keyHost = $('#key-box'), cfgHost = $('#config'), status = $('#status');
    $('#copy-url').addEventListener('click', async () => toast((await copyText(mcpUrl)) ? 'URL copied.' : 'Copy failed — select it manually.'));
    $('#copy-prompt').addEventListener('click', async () => toast((await copyText($('#test-prompt').textContent)) ? 'Prompt copied.' : 'Copy failed.'));

    function config(key) {
      return JSON.stringify({ mcpServers: { thevoice: {
        command: 'npx',
        args: ['-y', 'mcp-remote', mcpUrl, '--header', 'Authorization:${AUTH_HEADER}'],
        env: { AUTH_HEADER: `Bearer ${key || 'YOUR_KEY'}` }
      } } }, null, 2);
    }
    function renderConfig(key) {
      const pre = el('pre', { class: 'code', id: 'config-json' }, config(key));
      mount(cfgHost, pre, el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn secondary small', id: 'copy-config', onclick: async () => toast((await copyText(pre.textContent)) ? 'Config copied.' : 'Copy failed.') }, 'Copy config')),
        key ? null : el('p', { class: 'hint' }, 'Replace YOUR_KEY with your key (create one above — it is shown only once).'));
    }

    async function loadMeta() {
      try {
        const k = await api('GET', '/api/mcp-key');
        mount(meta, k.exists
          ? el('p', { class: 'muted' }, 'Active key ', el('code', { class: 'mono' }, `${k.prefix}…`), ' · last used ', k.last_used_at ? (parseDbDate(k.last_used_at) ? parseDbDate(k.last_used_at).toLocaleString() : 'recently') : 'never')
          : el('p', { class: 'muted' }, 'You don’t have a key yet.'));
        $('#make-key').textContent = k.exists ? 'Regenerate key' : 'Create my MCP key';
        return k.exists;
      } catch (err) { showError(status, err); return false; }
    }
    let hasKey = await loadMeta();
    renderConfig(null);

    $('#make-key').addEventListener('click', async () => {
      if (hasKey) {
        const m = await openModal({ title: 'Regenerate your key?', body: 'The current key stops working immediately. You’ll need to update Claude with the new one.', confirmText: 'Regenerate', danger: true });
        if (!m) return;
      }
      try {
        const out = await api('POST', '/api/mcp-key', {});
        mount(keyHost, el('div', { class: 'keybox stack' }, el('p', { class: 'alert warn' }, 'Copy this key now. It is shown only once and can’t be recovered.'),
          el('code', { id: 'key-value' }, out.key),
          el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn small', id: 'copy-key', onclick: async () => toast((await copyText(out.key)) ? 'Key copied.' : 'Copy failed — select it manually.') }, 'Copy key'))));
        renderConfig(out.key);
        hasKey = await loadMeta();
      } catch (err) { showError(keyHost, err); }
    });
  }

  /* ===================================================================== boot */
  const PAGES = {
    login: () => initAuth('login'), signup: () => initAuth('signup'),
    index: initOnboarding, dashboard: initDashboard, sources: initSources, connect: initConnect
  };
  function boot() {
    const page = document.body.dataset.page;
    if (PAGES[page]) PAGES[page]().catch((err) => { console.error(err); pageError(err); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // exposed for tests only
  window.__thevoice = { el, api, relTime, parseDbDate, safeHref, fmtNum };
})();
