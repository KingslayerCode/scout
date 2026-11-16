/* Scout in the browser. This is the old Apps Script server (Code.gs) rewritten to call Google's own APIs directly,
   using the signed-in person's Google account. Every function the page used to ask Apps Script for is in API at the bottom. */
(function () {
'use strict';
const CLIENT_ID = '205279511864-mflcs2kjrptbe6gcuc2qmrhf17d1bj84.apps.googleusercontent.com';
const SHEET_ID = '1YcY3HbP-yWpypR83tpE8s5fIwUdtmrsYO49zFUtZ4qI'; // the Scout sheet; point this at another sheet to switch data
const SCOPES = 'openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks.readonly https://www.googleapis.com/auth/drive';
const APP_NAME = 'Scout';
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Edmonton'; } catch (e) { return 'America/Edmonton'; } })();
const HEAD = {
  Sources: ['key', 'owner', 'kind', 'sourceId', 'name', 'color', 'selected'],
  Profiles: ['email', 'name', 'color', 'photo'],
  Recipes: ['id', 'title', 'image', 'source', 'servings', 'time', 'tags', 'ingredients', 'steps', 'notes', 'fav', 'addedBy', 'created'],
  Lists: ['id', 'name', 'kind', 'owner', 'created'],
  ListItems: ['id', 'list', 'text', 'done', 'assignee', 'addedBy', 'created'],
  Meals: ['id', 'container', 'name', 'created', 'frozen', 'moved', 'loc', 'addedBy', 'movedAt'],
  Config: ['key', 'value'],
  Events: ['sourceKey', 'owner', 'id', 'title', 'start', 'end', 'allDay', 'location'],
  SharedEvents: ['id', 'title', 'start', 'end', 'allDay', 'location', 'notes', 'createdBy', 'updatedBy', 'updated'],
  Receipts: ['id', 'merchant', 'date', 'amount', 'tax', 'currency', 'category', 'uploader', 'kind', 'fileId', 'fileName', 'mime', 'notes', 'data', 'created']
};
// Text the person typed is cut by whole characters, never in the middle of an emoji.
const cut_ = (v, n) => { const a = Array.from(String(v == null ? '' : v)); return a.length > n ? a.slice(0, n).join('') : a.join(''); };
const clip_ = (v, n) => cut_(String(v == null ? '' : v).trim(), n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = encodeURIComponent;
const uuid_ = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const ls_ = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

// ---------- signing in ----------
// Google's browser sign-in gives a key that lasts about an hour and cannot be renewed on its own. KEYS_URL is the small "Scout keys"
// helper (a web app in Apps Script that holds the Client Secret). With it, signing in once leaves a renewal key on this phone, and the
// hourly key is renewed quietly in the background. Without it (KEYS_URL empty) the person taps Reconnect about once an hour instead.
const KEYS_URL = window.SCOUT_KEYS_URL || '';
const AUTH = (() => {
  const AK = 'scout-auth', A = { token: '', exp: 0, refresh: '', noRT: false, email: '', name: '', picture: '' };
  try { const s = JSON.parse(ls_.get(AK) || 'null'); if (s && s.email) { A.email = s.email; A.name = s.name || ''; A.picture = s.picture || ''; A.refresh = s.refresh || ''; A.noRT = !!s.noRT; if (s.exp > Date.now() + 60000) { A.token = s.token; A.exp = s.exp; } } } catch (e) {}
  const save = () => ls_.set(AK, JSON.stringify(A));
  const fresh = () => !!A.token && A.exp > Date.now() + 60000;
  let tc = null, gsiP = null, pending = null, gate = null;
  const loadGsi = () => (window.google && google.accounts && google.accounts.oauth2) ? Promise.resolve() : gsiP || (gsiP = new Promise((ok, no) => {
    const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = ok; s.onerror = () => { gsiP = null; no(new Error('Could not load Google sign-in. Check your connection.')); };
    document.head.appendChild(s);
  }));
  async function keeper(body) { // the helper swaps a sign-in code or renewal key for a fresh hourly key, because only it knows the Client Secret
    let r; try { r = await fetch(KEYS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }); }
    catch (e) { throw new Error('Could not reach the Scout sign-in helper. Check your connection and try again.'); }
    try { return await r.json(); } catch (e) { throw new Error('The Scout sign-in helper gave an unexpected answer.'); }
  }
  async function renew() { // quietly turn the renewal key into a new hourly key; false when Google no longer honours it
    const j = await keeper({ refresh_token: A.refresh });
    if (j.access_token) { A.token = j.access_token; A.exp = Date.now() + (+j.expires_in || 3600) * 1000; save(); return true; }
    if (j.error === 'invalid_grant') { A.refresh = ''; A.exp = 0; save(); return false; } // taken back by the person, or Google's one-week limit while the app is in Testing
    throw new Error('Google would not renew the sign-in (' + (j.error_description || j.error || 'unknown') + ').');
  }
  function build() {
    if (gate) return gate;
    const st = document.createElement('style');
    st.textContent = '#gate{border:0;outline:0;padding:0;margin:0;border-radius:0;box-shadow:none;background:#2a1458;max-width:none;max-height:none;width:100%;height:100%;color:#fff}#gate::backdrop{background:#2a1458}'
      + '#gate .gc{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;font:16px/1.4 -apple-system,system-ui,sans-serif}'
      + '#gate img{width:84px;height:84px;border-radius:19px}#gate h1{margin:0;font-size:28px}#gate p{margin:0;max-width:320px;color:#cdbfee}'
      + '#gate button{min-height:50px;min-width:240px;border:0;border-radius:14px;background:#fff;color:#2a1458;font:700 17px system-ui;padding:0 22px}#gate button:disabled{opacity:.5}#gate .ge{color:#ffb4b4}';
    document.head.appendChild(st);
    gate = document.createElement('dialog'); gate.id = 'gate'; gate.setAttribute('aria-label', 'Sign in');
    gate.innerHTML = '<div class="gc"><img src="apple-touch-icon.png" alt=""><h1>' + APP_NAME + '</h1><p id="gm"></p><button id="gb" type="button" disabled>One moment…</button><p class="ge" id="ge"></p></div>';
    gate.addEventListener('cancel', e => e.preventDefault());
    document.body.appendChild(gate);
    gate.querySelector('#gb').onclick = click;
    return gate;
  }
  function show(first, err, label) {
    build(); const b = gate.querySelector('#gb');
    gate.querySelector('#gm').textContent = first ? 'Sign in with your Google account to open the household.'
      : !KEYS_URL ? 'Scout needs to reconnect to Google. This happens about once an hour.'
      : A.noRT ? 'Scout needs to sign in to Google again. To stop this, open myaccount.google.com/permissions, remove Scout, then sign in here once more.'
      : 'Scout needs you to sign in to Google again.';
    gate.querySelector('#ge').textContent = err || '';
    b.textContent = label || (first ? 'Sign in with Google' : 'Reconnect'); b.disabled = !tc;
    if (!gate.open) gate.showModal();
    if (!tc) loadGsi().then(init, e => { gate.querySelector('#ge').textContent = e.message; });
  }
  function init() {
    if (!tc) {
      const common = { client_id: CLIENT_ID, scope: SCOPES, error_callback: e => show(!A.email, e && e.type === 'popup_closed' ? 'The Google window was closed. Tap the button to try again.' : 'Google could not open its sign-in window. Tap the button to try again.') };
      tc = KEYS_URL ? google.accounts.oauth2.initCodeClient(Object.assign({ ux_mode: 'popup', login_hint: A.email || undefined, callback: gotCode }, common))
                    : google.accounts.oauth2.initTokenClient(Object.assign({ callback: got }, common));
    }
    if (gate) gate.querySelector('#gb').disabled = false;
  }
  function click() { // must call Google straight from the tap, or iPhone blocks the pop-up
    if (!tc) return;
    gate.querySelector('#gb').disabled = true;
    try { KEYS_URL ? tc.requestCode() : tc.requestAccessToken({ prompt: '', login_hint: A.email || undefined }); } catch (e) { show(!A.email, e.message); }
  }
  const denied = e => e === 'access_denied' ? 'Google said no. Scout needs access to your calendar, sheet and Drive to work.' : 'Sign-in did not finish (' + e + '). Tap the button to try again.';
  const got = r => r.error ? show(!A.email, denied(r.error)) : finish({ access_token: r.access_token, expires_in: r.expires_in });
  async function gotCode(r) {
    if (r.error || !r.code) { show(!A.email, denied(r.error || 'no code')); return; }
    try {
      const j = await keeper({ code: r.code });
      if (!j.access_token) throw new Error(j.error_description || j.error || 'Google would not finish signing in');
      await finish(j);
    } catch (e) { show(!A.email, 'Could not finish signing in: ' + (e.message || e)); }
  }
  async function finish(j) {
    try {
      const u = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + j.access_token } })).json();
      if (!u.email) throw new Error('Google did not tell Scout which account this is.');
      if (A.email && u.email.toLowerCase() !== A.email.toLowerCase()) { // a different account signed in: never show the last person's data
        ls_.del('fw-cache-1'); ls_.del(AK); location.reload(); return;
      }
      Object.assign(A, { token: j.access_token, exp: Date.now() + (+j.expires_in || 3600) * 1000, refresh: j.refresh_token || A.refresh, email: u.email, name: u.name || '', picture: u.picture || '' });
      A.noRT = !!KEYS_URL && !A.refresh; // shortcut: Google only gives a renewal key the first time an account approves Scout; someone who approved before must remove Scout at myaccount.google.com/permissions once
      save();
      if (A.noRT && typeof toast === 'function') toast('Signed in for an hour. Staying signed in is not on for this account yet.');
      if (gate && gate.open) gate.close();
      const p = pending; pending = null; if (p) p.ok(A.token);
    } catch (e) { show(!A.email, 'Could not finish signing in: ' + (e.message || e)); }
  }
  const self = {
    get email() { return A.email; }, get name() { return A.name; }, get picture() { return A.picture; },
    token() {
      if (fresh()) return Promise.resolve(A.token);
      if (!pending) {
        let ok, no; const p = new Promise((a, b) => { ok = a; no = b; }); p.ok = ok; p.no = no; pending = p;
        (async () => {
          try {
            if (KEYS_URL && A.refresh && await renew()) { pending = null; ok(A.token); } // no screen at all
            else show(!A.email);
          } catch (e) { pending = null; no(e); }
        })();
      }
      return pending;
    },
    expire() { A.exp = 0; save(); },
    // the page waits for this before it starts: with no known person yet it shows the sign-in screen, otherwise it opens at once from its saved view
    start() { loadGsi().then(init, () => {}); if (A.email && !fresh() && KEYS_URL && A.refresh) self.token().catch(() => {}); return A.email ? Promise.resolve() : self.token().then(() => {}); }
  };
  // coming back to the app after a while: renew the hourly key now, so it is ready before anything is tapped
  document.addEventListener('visibilitychange', () => { if (!document.hidden && KEYS_URL && A.refresh && !fresh() && !pending) self.token().catch(() => {}); });
  return self;
})();

// ---------- talking to Google ----------
function gerr(status, j, txt, url) {
  const e = j && j.error, msg = (e && e.message) || String(txt || '').slice(0, 200) || 'HTTP ' + status;
  const off = e && Array.isArray(e.details) && e.details.find(d => d.reason === 'SERVICE_DISABLED');
  if (off || /has not been used in project|is disabled/i.test(msg) && status === 403) {
    const md = (off && off.metadata) || {}, link = md.activationUrl || (msg.match(/https:\/\/console\.[^\s"]+/) || [''])[0];
    return new Error('APIOFF: ' + (md.serviceTitle || 'A Google service') + ' is switched off for the Scout project. Open ' + (link || 'the Google Cloud console') + ' and press Enable, wait a minute, then try again.');
  }
  if (url.indexOf('/spreadsheets/' + SHEET_ID) >= 0 && (status === 403 || status === 404))
    return new Error('NOACCESS: This Google account (' + AUTH.email + ') cannot open the Scout sheet yet. Ask whoever set up the app to share the sheet with you as an Editor, and to add you as a test user in Google Cloud. Then reload this page. (Google said: ' + msg.slice(0, 140) + ')');
  return new Error(msg);
}
async function g(url, o = {}) {
  const method = o.method || 'GET';
  for (let i = 0; ; i++) {
    const t = await AUTH.token(), h = Object.assign({ Authorization: 'Bearer ' + t }, o.json !== undefined ? { 'Content-Type': 'application/json' } : {}, o.headers || {});
    let r;
    try { r = await fetch(url, { method, headers: h, body: o.json !== undefined ? JSON.stringify(o.json) : o.body }); }
    catch (e) { throw new Error('Could not reach Google. Check your connection and try again.'); }
    if (r.status === 401 && i < 1) { AUTH.expire(); continue; }
    if ((r.status === 429 || (r.status >= 500 && method === 'GET')) && i < 3) { await sleep(900 * Math.pow(2, i)); continue; }
    if (!r.ok) { const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) {} throw gerr(r.status, j, txt, url); }
    if (o.as === 'blob') return r.blob();
    const txt = await r.text();
    return o.as === 'text' ? txt : txt ? JSON.parse(txt) : null;
  }
}
const me_ = () => {
  if (!AUTH.email) throw new Error('Could not read your Google account email. Sign in to Google and approve all permissions.');
  return AUTH.email;
};
// One change at a time from this screen. (Two phones saving at the very same moment can still overwrite each other; the last save wins.)
let Q = Promise.resolve();
const locked_ = fn => { const p = Q.then(fn, fn); Q = p.catch(() => {}); return p; };

// ---------- the sheet ----------
const S = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID;
const colL = n => String.fromCharCode(64 + n);
let META = null; // tab name -> sheetId, and every tab that is missing is made once
const metaFields = '?fields=sheets.properties(sheetId,title,gridProperties.rowCount)';
async function tabs_() {
  if (META) return META;
  return (META = (async () => {
    try {
      const have = {}, m = await g(S + metaFields);
      (m.sheets || []).forEach(s => { have[s.properties.title] = s.properties.sheetId; });
      const miss = Object.keys(HEAD).filter(n => !(n in have));
      if (miss.length) await makeTabs_(miss, have);
      return have;
    } catch (e) { META = null; throw e; }
  })());
}
async function makeTabs_(miss, have) {
  try {
    const r = await g(S + ':batchUpdate', { method: 'POST', json: { requests: miss.map(title => ({ addSheet: { properties: { title } } })) } });
    r.replies.forEach((x, i) => { have[miss[i]] = x.addSheet.properties.sheetId; });
  } catch (e) { // another phone made them a moment ago
    const m = await g(S + metaFields); (m.sheets || []).forEach(s => { have[s.properties.title] = s.properties.sheetId; });
    if (miss.some(n => !(n in have))) throw e;
    return;
  }
  const reqs = [];
  miss.forEach(n => {
    const id = have[n], w = HEAD[n].length;
    reqs.push({ repeatCell: { range: { sheetId: id, startColumnIndex: 0, endColumnIndex: w }, cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } }, fields: 'userEnteredFormat.numberFormat' } }, // keep dates as text
      { repeatCell: { range: { sheetId: id, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: w }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
      { updateSheetProperties: { properties: { sheetId: id, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
  });
  await g(S + ':batchUpdate', { method: 'POST', json: { requests: reqs } });
  await g(S + '/values:batchUpdate', { method: 'POST', json: { valueInputOption: 'RAW', data: miss.map(n => ({ range: n + '!A1:' + colL(HEAD[n].length) + '1', values: [HEAD[n]] })) } });
}
function parse_(name, vals) {
  const h = HEAD[name];
  if (vals.length && !vals[0][h.length - 1]) // a tab made by an older version is missing the newest column name
    g(S + '/values/' + enc(name + '!A1:' + colL(h.length) + '1') + '?valueInputOption=RAW', { method: 'PUT', json: { values: [h] } }).catch(() => {});
  return vals.slice(1).map((v, i) => ({ r: i + 2, o: Object.fromEntries(h.map((k, j) => [k, v[j] == null ? '' : String(v[j])])) })).filter(x => x.o[h[0]]);
}
async function manyR_(names) { // several tabs in one round trip
  await tabs_();
  const r = await g(S + '/values:batchGet?valueRenderOption=FORMATTED_VALUE&' + names.map(n => 'ranges=' + enc(n + '!A:' + colL(HEAD[n].length))).join('&'));
  return names.map((n, i) => parse_(n, r.valueRanges[i].values || []));
}
const rowsR_ = async name => (await manyR_([name]))[0]; // every row as {r: sheet row number, o: object}
const rows_ = async name => (await rowsR_(name)).map(x => x.o);
const cells_ = (h, o) => h.map(k => o[k] == null ? '' : String(o[k]));
async function gridRows_(name) { const m = await g(S + metaFields); const s = (m.sheets || []).find(x => x.properties.title === name); return s ? s.properties.gridProperties.rowCount : 1000; }
async function write_(name, objs) { // replace the whole tab in one write; the old rows are overwritten, not cleared first, so nobody sees it empty
  const id = (await tabs_())[name], h = HEAD[name], w = h.length;
  const old = (await g(S + '/values/' + enc(name + '!A:A') + '?valueRenderOption=FORMATTED_VALUE')).values || [];
  const total = Math.max(objs.length, old.length - 1);
  if (!total) return;
  const need = total + 1 - await gridRows_(name);
  if (need > 0) await g(S + ':batchUpdate', { method: 'POST', json: { requests: [{ appendDimension: { sheetId: id, dimension: 'ROWS', length: need + 200 } }] } });
  const blank = new Array(w).fill(''), vals = objs.map(o => cells_(h, o));
  while (vals.length < total) vals.push(blank);
  await g(S + '/values/' + enc(name + '!A2:' + colL(w) + (total + 1)) + '?valueInputOption=RAW', { method: 'PUT', json: { values: vals } });
}
// Row-level changes touch one row instead of rewriting the whole tab.
async function findRow_(name, ncols, test) { // sheet row of the first match, reading only the first ncols columns
  await tabs_();
  const v = (await g(S + '/values/' + enc(name + '!A2:' + colL(ncols)) + '?valueRenderOption=FORMATTED_VALUE')).values || [];
  const i = v.findIndex(row => { const a = []; for (let j = 0; j < ncols; j++) a.push(row[j] == null ? '' : String(row[j])); return test(a); });
  return i < 0 ? 0 : i + 2;
}
const byKey_ = async (name, id) => { const x = (await rowsR_(name)).find(r => r.o[HEAD[name][0]] === id); return x || null; }; // {r, o}
const putRow_ = (name, r, o) => g(S + '/values/' + enc(name + '!A' + r + ':' + colL(HEAD[name].length) + r) + '?valueInputOption=RAW', { method: 'PUT', json: { values: [cells_(HEAD[name], o)] } });
async function addRows_(name, objs) {
  if (!objs.length) return;
  await tabs_();
  await g(S + '/values/' + enc(name + '!A:A') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { method: 'POST', json: { values: objs.map(o => cells_(HEAD[name], o)) } });
}
async function delRow_(name, r) { const id = (await tabs_())[name]; await g(S + ':batchUpdate', { method: 'POST', json: { requests: [{ deleteDimension: { range: { sheetId: id, dimension: 'ROWS', startIndex: r - 1, endIndex: r } } }] } }); }
async function cfgPutMany_(obj) { // change several settings at once: existing keys in place, new keys added at the end
  const cur = await rowsR_('Config'), at = Object.fromEntries(cur.map(x => [x.o.key, x.r])), upd = [], add = [];
  Object.keys(obj).forEach(k => at[k] ? upd.push({ range: 'Config!A' + at[k] + ':B' + at[k], values: [[k, String(obj[k])]] }) : add.push({ key: k, value: String(obj[k]) }));
  if (upd.length) await g(S + '/values:batchUpdate', { method: 'POST', json: { valueInputOption: 'RAW', data: upd } });
  await addRows_('Config', add);
}
const cfgPut_ = (k, v) => cfgPutMany_({ [k]: v });
const cfgSet_ = (k, v) => locked_(() => cfgPut_(k, v));
const cfgGet_ = async k => { const r = (await rows_('Config')).find(x => x.key === k); return r ? r.value : ''; };

// ---------- what the page calls ----------
const CAL = 'https://www.googleapis.com/calendar/v3', TASKS = 'https://tasks.googleapis.com/tasks/v1', DRV = 'https://www.googleapis.com/drive/v3';
const PAL = ['#2f80ed', '#eb5757', '#27ae60', '#9b51e0', '#e07b1f', '#00a6b2', '#d6336c', '#6c757d'];
const THEMES = ['dark', 'light', 'system'];
const mk = k => 'scout:' + me_() + ':' + k; // things kept on this device for this person
const queue_ = () => { let q = Promise.resolve(); return fn => { const p = q.then(fn, fn); q = p.catch(() => {}); return p; }; };
const lockedU_ = queue_();

async function getSources(force) {
  const me = me_(), saved = (await rows_('Sources')).filter(r => r.owner === me), warnings = [];
  const byId = Object.fromEntries(saved.map(r => [r.kind + '|' + r.sourceId, r]));
  const found = (await discovered_(force, warnings)).map(d => {
    const s = byId[d.kind + '|' + d.sourceId];
    return { key: me + '|' + d.kind + '|' + d.sourceId, kind: d.kind, sourceId: d.sourceId, name: d.name,
             color: d.color, selected: s ? s.selected === 'Y' : d.def, canEdit: d.kind === 'google' && /^(owner|writer)$/.test(d.role || '') };
  });
  const ics = saved.filter(r => r.kind === 'ics').map(r => ({ key: r.key, kind: 'ics', sourceId: r.sourceId, name: r.name, color: r.color, selected: r.selected === 'Y' }));
  ls_.set(mk('writable'), JSON.stringify(found.filter(s => s.canEdit).map(s => s.key))); // lets the calendar know which events are editable without asking Google again
  return { me, sources: found.concat(ics), warnings, hasSaved: saved.length > 0 };
}
// The list of the person's calendars rarely changes, so keep it for 10 minutes (the settings screen asks for a fresh one).
async function discovered_(force, warn) {
  if (!force) {
    try { const c = JSON.parse(ls_.get(mk('disc')) || 'null'); if (c && Date.now() - c.t < 6e5) { (c.warn || []).forEach(w => warn.push(w)); return c.items; } } catch (e) {}
  }
  const w = [], items = await discover_(w);
  w.forEach(x => warn.push(x));
  ls_.set(mk('disc'), JSON.stringify({ t: Date.now(), items, warn: w }));
  return items;
}
async function discover_(warn) {
  const mine = ls_.get(mk('sharedCal')), out = [];
  const cals = async () => { let tok = '', all = []; do { const r = await g(CAL + '/users/me/calendarList?maxResults=250' + (tok ? '&pageToken=' + enc(tok) : '')); all = all.concat(r.items || []); tok = r.nextPageToken; } while (tok); return all; };
  const lists = async () => { let tok = '', all = []; do { const r = await g(TASKS + '/users/@me/lists?maxResults=100' + (tok ? '&pageToken=' + enc(tok) : '')); all = all.concat(r.items || []); tok = r.nextPageToken; } while (tok); return all; };
  const [c, t] = await Promise.all([cals(), lists().catch(e => { warn.push('Google Tasks unavailable: ' + e.message); return []; })]);
  c.forEach(x => { // the "Shared Events" copy is shown from the app itself, importing it too would show every event twice
    if (x.id === mine || String(x.description || '').indexOf(SHARED_MARK) >= 0) return;
    out.push({ kind: 'google', sourceId: x.id, name: x.summaryOverride || x.summary, color: x.backgroundColor, def: !!x.primary, role: x.accessRole });
  });
  t.forEach(x => out.push({ kind: 'task', sourceId: x.id, name: x.title, color: '#4285f4', def: false }));
  return out;
}
async function saveSources(list) {
  const me = me_();
  const mine = list.map(s => {
    const id = s.kind === 'ics' ? String(s.sourceId).replace(/^webcal:/i, 'https:') : s.sourceId;
    if (s.kind === 'ics' && !/^https:\/\//.test(id)) throw new Error('Calendar links must start with https:// or webcal://');
    return { key: me + '|' + s.kind + '|' + id, owner: me, kind: s.kind, sourceId: id, name: s.name, color: s.color || '', selected: s.selected ? 'Y' : 'N' };
  });
  await locked_(async () => write_('Sources', (await rows_('Sources')).filter(r => r.owner !== me).concat(mine)));
  return syncMe(); // there is no hourly background sync any more: your calendars refresh whenever you open the app
}

// ---------- sync ----------
const ev_ = (s, id, title, start, end, allDay, loc) => ({ sourceKey: s.key, owner: s.owner, id, title, start, end, allDay: allDay ? 'Y' : 'N', location: loc || '' });
async function gEvents_(s, from, to) {
  const out = []; let tok = '';
  do {
    const r = await g(CAL + '/calendars/' + enc(s.sourceId) + '/events?singleEvents=true&orderBy=startTime&maxResults=2500&timeMin=' + enc(from.toISOString()) + '&timeMax=' + enc(to.toISOString())
      + '&fields=' + enc('items(id,status,summary,start,end,location),nextPageToken') + (tok ? '&pageToken=' + enc(tok) : ''));
    (r.items || []).filter(e => e.status !== 'cancelled' && e.start && e.end).forEach(e => out.push(ev_(s, e.id, e.summary || '(No title)', e.start.dateTime || e.start.date, e.end.dateTime || e.end.date, !e.start.dateTime, e.location)));
    tok = r.nextPageToken;
  } while (tok);
  return out;
}
async function tasks_(s) { // Google Tasks only has due dates, so they show as all-day items
  const out = []; let tok = '';
  do {
    const r = await g(TASKS + '/lists/' + enc(s.sourceId) + '/tasks?showCompleted=false&maxResults=100' + (tok ? '&pageToken=' + enc(tok) : ''));
    (r.items || []).filter(t => t.due).forEach(t => { const d = t.due.slice(0, 10); out.push(ev_(s, t.id, '☐ ' + t.title, d, d, true, '')); });
    tok = r.nextPageToken;
  } while (tok);
  return out;
}
async function syncMe() {
  const me = me_(), now = Date.now(), from = new Date(now - 30 * 864e5), to = new Date(now + 180 * 864e5), errors = [], failed = new Set();
  const mine = (await rows_('Sources')).filter(s => s.owner === me && s.selected === 'Y');
  const got = await Promise.all(mine.map(async s => {
    try {
      if (s.kind === 'google') return await gEvents_(s, from, to);
      if (s.kind === 'task') return await tasks_(s);
      throw new Error('Apple and link calendars are not available in this version yet.');
    } catch (e) { errors.push(s.name + ': ' + e.message); failed.add(s.key); return []; }
  }));
  const ev = [].concat(...got);
  // a calendar that failed keeps its old events instead of vanishing
  await locked_(async () => write_('Events', (await rows_('Events')).filter(r => r.owner !== me || failed.has(r.sourceKey)).concat(ev)));
  try { await mirrorShared_(); } catch (e) { errors.push('Shared Events calendar: ' + e.message); } // also put the household's shared events in this person's Google Calendar
  await cfgSet_('sync:' + me, new Date().toISOString()); // so everyone can see how fresh each person's calendar is
  return { count: ev.length, errors };
}

// ---------- the family view ----------
const WX_KEY = 'weatherPlace';
const placeOf_ = v => { try { const p = JSON.parse(v); return p && isFinite(p.lat) && isFinite(p.lon) && p.name ? p : null; } catch (e) { return null; } };
const sharedOut_ = r => Object.assign({}, r, { sourceKey: 'shared', owner: SHARED_OWNER, shared: 'Y', cal: 'Shared Events' });
const SHARED_OWNER = '*shared', SHARED_DEF = '#f2a900', SHARED_MARK = 'household-app-shared-events';
const sharedColor_ = conf => { const v = conf.find(r => r.key === 'sharedColor'); return v && /^#[0-9a-f]{6}$/i.test(v.value) ? v.value : SHARED_DEF; };
const themePick_ = saved => { const t = THEMES.indexOf(saved) >= 0 ? saved : ls_.get('fw-theme'); return THEMES.indexOf(t) >= 0 ? t : 'dark'; }; // saved with the person in the sheet, so it follows them to every device
async function getFamily() {
  const me = me_();
  let [prof, src, conf, shr, evs] = (await manyR_(['Profiles', 'Sources', 'Config', 'SharedEvents', 'Events'])).map(a => a.map(x => x.o));
  if (!prof.some(r => r.email === me)) { await ensureProfile_(me); prof = await rows_('Profiles'); }
  const sel = new Set(src.filter(r => r.selected === 'Y').map(r => r.key)), names = Object.fromEntries(src.map(r => [r.key, r.name]));
  // Everyone sees everyone's selected calendars. These two maps tell the screen who is sharing what, and how fresh it is.
  const cv = k => (conf.find(r => r.key === k) || { value: '' }).value, sharing = {}, sync = {};
  src.forEach(r => { if (r.selected === 'Y') sharing[r.owner] = (sharing[r.owner] || 0) + 1; });
  conf.forEach(r => { if (r.key.indexOf('sync:') === 0) sync[r.key.slice(5)] = r.value; });
  const rev = cv('sharedRev'), mirrored = ls_.get(mk('mirrored')) || '';
  const have = new Set(prof.map(r => r.email.toLowerCase()));
  const invited = conf.filter(r => r.key.indexOf('invite:') === 0 && !have.has(r.key.slice(7))).map(r => ({ email: r.key.slice(7), at: r.value }));
  let writable = null; try { writable = JSON.parse(ls_.get(mk('writable')) || 'null'); } catch (e) {}
  return { me, profiles: prof, invited, weather: placeOf_(cv(WX_KEY)), prefs: { theme: themePick_(cv('theme:' + me)) }, hasSaved: src.some(r => r.owner === me), writable,
    sharing, sync, sharedColor: sharedColor_(conf), sharedStale: !!rev && rev !== mirrored,
    events: evs.filter(e => sel.has(e.sourceKey)).map(e => Object.assign(e, { cal: names[e.sourceKey] || '' })).concat(shr.map(sharedOut_)) };
}
// Lists + meals in one round trip, loaded quietly after the calendar appears so those tabs open instantly.
async function getHousehold() { const [l, i, m, c] = (await manyR_(['Lists', 'ListItems', 'Meals', 'Config'])).map(a => a.map(x => x.o)); return { lists: l, items: i, meals: m, config: cfg_(c) }; }
async function savePrefs(p) {
  if (THEMES.indexOf(p && p.theme) < 0) throw new Error('Unknown theme.');
  ls_.set('fw-theme', p.theme); await cfgSet_('theme:' + me_(), p.theme); return true;
}

// ---------- profiles (name, colour, photo; defaults come from the person's Google account) ----------
async function ensureProfile_(me) {
  await locked_(async () => {
    if (await findRow_('Profiles', 1, v => v[0] === me)) return;
    const used = (await rows_('Profiles')).map(r => r.color);
    await addRows_('Profiles', [{ email: me, name: AUTH.name || me.split('@')[0], color: PAL.find(c => used.indexOf(c) < 0) || PAL[used.length % PAL.length], photo: AUTH.picture || '' }]);
  });
}
async function saveProfile(p) {
  const me = me_(); await ensureProfile_(me);
  const name = clip_(p.name, 40), photo = String(p.photo || '');
  const color = /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : PAL[0];
  if ((photo && !/^(https:\/\/|data:image\/)/.test(photo)) || photo.length > 45000) throw new Error('That photo is too large or not a valid image.');
  await locked_(async () => {
    const r = await findRow_('Profiles', 1, v => v[0] === me), o = { email: me, name: name || me.split('@')[0], color, photo };
    r ? await putRow_('Profiles', r, o) : await addRows_('Profiles', [o]);
  });
  return true;
}
const googleProfile = async () => ({ name: AUTH.name || '', picture: AUTH.picture || '' });

// ---------- recipe box (shared by the whole household) ----------
async function getRecipes() { return (await rows_('Recipes')).sort((a, b) => b.created.localeCompare(a.created)); }
async function saveRecipe(r) {
  const me = me_(), t = k => String(r[k] == null ? '' : r[k]);
  const title = clip_(t('title'), 120), img = t('image');
  if (!title) throw new Error('Give the recipe a title.');
  if ((img && !/^(https:\/\/|data:image\/)/.test(img)) || img.length > 45000) throw new Error('That photo is too large or not a valid image.');
  return locked_(async () => {
    const x = r.id ? await byKey_('Recipes', String(r.id)) : null, old = x ? x.o : null;
    const rec = { id: old ? old.id : uuid_(), title, image: img, source: cut_(t('source'), 500),
      servings: cut_(t('servings'), 40), time: cut_(t('time'), 40), tags: cut_(t('tags'), 200),
      ingredients: cut_(t('ingredients'), 20000), steps: cut_(t('steps'), 20000), notes: cut_(t('notes'), 5000),
      fav: r.fav ? 'Y' : 'N', addedBy: old ? old.addedBy : me, created: old ? old.created : new Date().toISOString() };
    x ? await putRow_('Recipes', x.r, rec) : await addRows_('Recipes', [rec]);
    return rec; // the screen updates itself from this, no second fetch
  });
}
const deleteRecipe = id => locked_(async () => { const x = await byKey_('Recipes', String(id)); if (x) await delRow_('Recipes', x.r); return true; });

// ---------- edit events and write them back to Google Calendar ----------
function eventKey_(p) {
  const me = me_(), k = String(p.sourceKey || '').split('|');
  if (k[0] !== me || k[1] !== 'google') throw new Error('You can only change events on your own Google calendars.');
  return { me, calId: k.slice(2).join('|') };
}
async function saveEvent(p) {
  const { me, calId } = eventKey_(p), re = /^\d{4}-\d{2}-\d{2}/;
  if (!re.test(p.start) || !re.test(p.end)) throw new Error('Check the start and end of the event.');
  const upd = !!p.id, mkT = v => p.allDay ? (upd ? { date: v, dateTime: null } : { date: v }) : (upd ? { dateTime: v, date: null } : { dateTime: v });
  const body = { summary: clip_(p.title, 300) || '(No title)', location: clip_(p.location, 300), start: mkT(p.start), end: mkT(p.end) };
  let ev;
  try { ev = upd ? await g(CAL + '/calendars/' + enc(calId) + '/events/' + enc(p.id), { method: 'PATCH', json: body }) : await g(CAL + '/calendars/' + enc(calId) + '/events', { method: 'POST', json: body }); }
  catch (e) { throw new Error('Google Calendar did not accept the change: ' + e.message); }
  const row = { sourceKey: p.sourceKey, owner: me, id: ev.id, title: ev.summary || '(No title)', start: ev.start.dateTime || ev.start.date,
                end: ev.end.dateTime || ev.end.date, allDay: ev.start.dateTime ? 'N' : 'Y', location: ev.location || '' };
  await locked_(async () => {
    const r = await findRow_('Events', 3, v => v[0] === row.sourceKey && v[2] === row.id);
    r ? await putRow_('Events', r, row) : await addRows_('Events', [row]);
  });
  return row;
}
async function deleteEvent(p) {
  const { calId } = eventKey_(p);
  try { await g(CAL + '/calendars/' + enc(calId) + '/events/' + enc(p.id), { method: 'DELETE' }); } catch (e) { throw new Error('Google Calendar did not accept the change: ' + e.message); }
  await locked_(async () => { const r = await findRow_('Events', 3, v => v[0] === p.sourceKey && v[2] === p.id); if (r) await delRow_('Events', r); });
  return true;
}

// ======================================================================
// SHARED EVENTS — one list for the whole household. The "SharedEvents" tab is the source of truth; each person's own Google
// calendar called "Shared Events" is filled in from it whenever they open the app. Every copy is tagged with the shared event's id.
// ======================================================================
async function setSharedColor(c) {
  me_();
  if (!/^#[0-9a-f]{6}$/i.test(String(c))) throw new Error('Pick a colour.');
  await cfgSet_('sharedColor', String(c).toLowerCase()); return true;
}
function sharedFields_(p) {
  const all = !!p.allDay, day = /^\d{4}-\d{2}-\d{2}$/, title = clip_(p.title, 300);
  if (!title) throw new Error('Add a title.');
  let start = String(p.start || ''), end = String(p.end || '');
  if (all) {
    if (!day.test(start) || !day.test(end)) throw new Error('Check the dates of the event.');
    if (end <= start) throw new Error('The end can’t be before the start.');
  } else {
    const a = new Date(start), b = new Date(end);
    if (isNaN(a) || isNaN(b)) throw new Error('Check the start and end of the event.');
    if (!(b > a)) throw new Error('The end must be after the start.');
    start = a.toISOString(); end = b.toISOString();
  }
  return { title, start, end, allDay: all ? 'Y' : 'N', location: clip_(p.location, 300), notes: cut_(String(p.notes || '').trim(), 2000) };
}
async function saveSharedEvent(p) {
  const me = me_(), f = sharedFields_(p), now = new Date().toISOString();
  return locked_(async () => {
    const x = p.id ? await byKey_('SharedEvents', String(p.id)) : null;
    if (p.id && !x) throw new Error('That shared event was already deleted.');
    const rec = x ? Object.assign({}, x.o, f, { updatedBy: me, updated: now })
                  : Object.assign({ id: uuid_().replace(/-/g, '').slice(0, 12), createdBy: me, updatedBy: me, updated: now }, f);
    x ? await putRow_('SharedEvents', x.r, rec) : await addRows_('SharedEvents', [rec]);
    await cfgPut_('sharedRev', now + ':' + rec.id); // everyone's Google copy is compared against this mark
    return sharedOut_(rec);
  });
}
async function deleteSharedEvent(id) {
  me_();
  await locked_(async () => {
    const x = await byKey_('SharedEvents', String(id));
    if (x) { await delRow_('SharedEvents', x.r); await cfgPut_('sharedRev', new Date().toISOString() + ':removed'); }
  });
  return true;
}
const syncShared = async () => { me_(); return mirrorShared_(); }; // the app calls this right after a change, and when it sees its copy is behind
const inkOn_ = c => { const n = parseInt(c.slice(1), 16); return (.299 * (n >> 16) + .587 * (n >> 8 & 255) + .114 * (n & 255)) / 255 > .62 ? '#000000' : '#ffffff'; };
// This person's own "Shared Events" calendar: found by the id we kept, else by its tag, else made (only once there is something to put in it).
async function sharedCal_(color) {
  let id = ls_.get(mk('sharedCal')) || '';
  if (id) { try { await g(CAL + '/calendars/' + enc(id)); } catch (e) { id = ''; } }
  if (!id) {
    let tok = '';
    do {
      const r = await g(CAL + '/users/me/calendarList?maxResults=250' + (tok ? '&pageToken=' + enc(tok) : ''));
      const f = (r.items || []).find(c => c.accessRole === 'owner' && String(c.description || '').indexOf(SHARED_MARK) >= 0);
      if (f) { id = f.id; break; }
      tok = r.nextPageToken;
    } while (tok);
  }
  if (!id) {
    id = (await g(CAL + '/calendars', { method: 'POST', json: { summary: 'Shared Events', timeZone: TZ,
      description: 'Events shared with everyone in the household. Add and change them in the Household app and they update here. ' + SHARED_MARK } })).id;
    ls_.del(mk('disc'));
  }
  ls_.set(mk('sharedCal'), id);
  if (ls_.get(mk('sharedCalColor')) !== color) { // the calendar carries the shared colour in Google Calendar too
    try { await g(CAL + '/users/me/calendarList/' + enc(id) + '?colorRgbFormat=true', { method: 'PATCH', json: { backgroundColor: color, foregroundColor: inkOn_(color) } }); ls_.set(mk('sharedCalColor'), color); } catch (e) {}
  }
  return id;
}
function mirrorBody_(r) {
  const all = r.allDay === 'Y', v = x => all ? { date: x.slice(0, 10) } : { dateTime: x };
  return { summary: r.title, location: r.location || '', start: v(r.start), end: v(r.end),
    description: (r.notes ? r.notes + '\n\n' : '') + 'Shared with the whole household. Change it in the Household app so everyone gets the update.',
    extendedProperties: { private: { hhId: r.id, hhRev: r.updated } } };
}
async function mirrorShared_() {
  const [sr, cr] = await manyR_(['SharedEvents', 'Config']), rows = sr.map(x => x.o), conf = cr.map(x => x.o);
  const rev = (conf.find(r => r.key === 'sharedRev') || { value: '' }).value, n = { added: 0, updated: 0, removed: 0 };
  if (!rows.length && !ls_.get(mk('sharedCal'))) { if (rev) ls_.set(mk('mirrored'), rev); return n; } // nothing shared yet: don't create a calendar for nothing
  return lockedU_(async () => { // one copy run at a time, so two screens can't both add the same event
    const calId = await sharedCal_(sharedColor_(conf)), base = CAL + '/calendars/' + enc(calId) + '/events', have = {}, extra = []; let tok = '';
    do {
      const r = await g(base + '?maxResults=2500&showDeleted=false' + (tok ? '&pageToken=' + enc(tok) : ''));
      (r.items || []).forEach(e => {
        const k = e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.hhId;
        if (!k) return; // added by hand in Google Calendar: not ours, leave it alone
        if (have[k]) extra.push(e.id); else have[k] = e;
      });
      tok = r.nextPageToken;
    } while (tok);
    for (const row of rows) {
      const cur = have[row.id]; delete have[row.id];
      if (!cur) { await g(base, { method: 'POST', json: mirrorBody_(row) }); n.added++; }
      else if (cur.extendedProperties.private.hhRev !== row.updated) { await g(base + '/' + enc(cur.id), { method: 'PUT', json: mirrorBody_(row) }); n.updated++; }
    }
    for (const k of Object.keys(have)) { await g(base + '/' + enc(have[k].id), { method: 'DELETE' }); n.removed++; } // deleted in the app
    for (const id of extra) { await g(base + '/' + enc(id), { method: 'DELETE' }); n.removed++; }
    if (rev) ls_.set(mk('mirrored'), rev);
    return n;
  });
}

// ---------- weather: Open-Meteo, free and keyless; the household picks one town ----------
async function searchPlaces(q) {
  me_(); q = clip_(q, 60);
  if (q.length < 2) throw new Error('Type a town or city.');
  let r; try { r = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=' + enc(q)); } catch (e) { r = null; }
  if (!r || !r.ok) throw new Error('The place search is not answering. Try again in a minute.');
  return ((await r.json()).results || []).map(x => ({ name: [x.name, x.admin1, x.country].filter(Boolean).join(', '), lat: x.latitude, lon: x.longitude }));
}
async function setWeatherPlace(p) {
  me_();
  if (!p) { await cfgSet_(WX_KEY, ''); return null; }
  const lat = Math.round(+p.lat * 100) / 100, lon = Math.round(+p.lon * 100) / 100, name = clip_(p.name, 80);
  if (!name || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) throw new Error('Pick a place from the list.');
  const v = { name, lat, lon }; await cfgSet_(WX_KEY, JSON.stringify(v)); return v;
}
async function getForecast() { // seven days, kept on this device for half an hour
  me_(); const p = placeOf_(await cfgGet_(WX_KEY));
  if (!p) return { place: null, days: [] };
  const key = 'scout-wx:' + p.lat + ':' + p.lon;
  try { const c = JSON.parse(ls_.get(key) || 'null'); if (c && Date.now() - c.t < 18e5) return { place: p, days: c.days }; } catch (e) {}
  let r; try { r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + p.lat + '&longitude=' + p.lon + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7'); } catch (e) { r = null; }
  if (!r || !r.ok) throw new Error('The forecast service is not answering right now.');
  const d = (await r.json()).daily || {}, pop = d.precipitation_probability_max || [];
  const days = (d.time || []).map((t, i) => ({ date: t, code: d.weather_code[i], hi: Math.round(d.temperature_2m_max[i]), lo: Math.round(d.temperature_2m_min[i]), pop: pop[i] == null ? null : pop[i] }));
  ls_.set(key, JSON.stringify({ t: Date.now(), days }));
  return { place: p, days };
}

// ---------- adding people to the household ----------
const appUrl_ = () => location.origin + location.pathname.replace(/[^/]*$/, '');
const getInvite = async () => { me_(); return { url: appUrl_() }; };
async function inviteMember(email) {
  me_();
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter their Google email address.');
  const share = id => g(DRV + '/files/' + id + '/permissions?supportsAllDrives=true&sendNotificationEmail=' + (id === SHEET_ID), { method: 'POST', json: { role: 'writer', type: 'user', emailAddress: email } });
  try { await share(SHEET_ID); }
  catch (e) { throw new Error('Could not share the Scout sheet with ' + email + '. Only people who can share the sheet can add others. Otherwise open the sheet in Google Sheets and use Share. (' + String(e.message || e).slice(0, 120) + ')'); }
  try { const f = await cfgGet_('vaultFolder'); if (f) await share(f); } catch (e) {} // so they can open receipt photos too
  await cfgSet_('invite:' + email, new Date().toISOString()); // shown in the Household list until they open the app
  return { url: appUrl_() };
}

// ---------- lists (shopping and to-do, shared by the household) ----------
async function getLists() { const [l, i] = (await manyR_(['Lists', 'ListItems'])).map(a => a.map(x => x.o)); return { lists: l, items: i }; }
function listOp(op, a) {
  const me = me_(), now = new Date().toISOString(), nid = () => uuid_().slice(0, 8), t = (v, n) => clip_(v, n);
  return locked_(async () => {
    if (op === 'addList') {
      const l = { id: nid(), name: t(a.name, 60) || 'List', kind: a.kind === 'todo' ? 'todo' : 'shopping', owner: me, created: now };
      await addRows_('Lists', [l]); return l;
    }
    if (op === 'editList') {
      const x = await byKey_('Lists', a.id);
      if (x) { const o = x.o; o.name = t(a.name, 60) || o.name; await putRow_('Lists', x.r, o); }
      return true;
    }
    if (op === 'delList') {
      const x = await byKey_('Lists', a.id); if (x) await delRow_('Lists', x.r);
      const I = await rows_('ListItems'); if (I.some(i => i.list === a.id)) await write_('ListItems', I.filter(i => i.list !== a.id));
      return true;
    }
    if (op === 'addItems') {
      if (!(await byKey_('Lists', a.list))) throw new Error('That list no longer exists.');
      const out = [];
      (a.texts || []).slice(0, 200).forEach(x => { x = t(x, 200); if (x) out.push({ id: nid(), list: a.list, text: x, done: 'N', assignee: t(a.assignee, 120), addedBy: me, created: now }); });
      await addRows_('ListItems', out); return out;
    }
    if (op === 'setItem') {
      const x = await byKey_('ListItems', a.id); if (!x) return true;
      const i = x.o;
      Object.assign(i, a.done != null ? { done: a.done ? 'Y' : 'N' } : {}, a.assignee != null ? { assignee: t(a.assignee, 120) } : {}, a.text != null ? { text: t(a.text, 200) || i.text } : {});
      await putRow_('ListItems', x.r, i); return true;
    }
    if (op === 'delItem') { const x = await byKey_('ListItems', a.id); if (x) await delRow_('ListItems', x.r); return true; }
    if (op === 'clearDone') {
      const I = await rows_('ListItems'); if (I.some(i => i.list === a.list && i.done === 'Y')) await write_('ListItems', I.filter(i => !(i.list === a.list && i.done === 'Y')));
      return true;
    }
    throw new Error('Unknown list action.');
  });
}

// ---------- meals: containers in the fridge and freezer ----------
const CFG_DEF = { containers: 30, fridgeDays: 4, freezerDays: 90, fridgeTemp: 4, freezerTemp: -18 };
const CFG_LIM = { containers: [1, 99], fridgeDays: [1, 30], freezerDays: [1, 730], fridgeTemp: [0, 10], freezerTemp: [-30, -5] };
function cfg_(conf) {
  const c = Object.assign({}, CFG_DEF);
  conf.forEach(r => { const v = +r.value; if (r.key in c && r.value !== '' && v >= CFG_LIM[r.key][0] && v <= CFG_LIM[r.key][1]) c[r.key] = v; });
  return c;
}
async function getMeals() { const [m, c] = (await manyR_(['Meals', 'Config'])).map(a => a.map(x => x.o)); return { meals: m, config: cfg_(c) }; }
async function saveConfig(c) {
  const next = cfg_(await rows_('Config')), names = { containers: 'containers', fridgeDays: 'fridge days', freezerDays: 'freezer days', fridgeTemp: 'the fridge temperature', freezerTemp: 'the freezer temperature' };
  Object.keys(CFG_LIM).forEach(k => {
    if (c[k] === undefined) return; // an older copy of the page does not send the temperatures
    const lim = CFG_LIM[k], v = /Temp$/.test(k) ? Math.round(+c[k] * 2) / 2 : Math.round(+c[k]); // temperatures in half degrees
    if (c[k] === '' || c[k] === null || !(v >= lim[0] && v <= lim[1])) throw new Error('Choose a number from ' + lim[0] + ' to ' + lim[1] + ' for ' + names[k] + '.');
    next[k] = v;
  });
  await locked_(() => cfgPutMany_(next));
  return next;
}
const D_ = /^\d{4}-\d{2}-\d{2}$/;
function mealFields_(m) {
  const d = v => { v = String(v || ''); if (v && !D_.test(v)) throw new Error('Dates need a day, month and year.'); return v; };
  const name = clip_(m.name, 80);
  if (!name) throw new Error('Give the meal a name.');
  const at = m.movedAt === undefined ? null : String(m.movedAt || ''); // only when the page sent it, so an older page never wipes it
  if (at && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(at)) throw new Error('That time is not valid.');
  return Object.assign({ name, created: d(m.created), frozen: d(m.frozen), moved: d(m.moved), loc: m.loc === 'freezer' ? 'freezer' : 'fridge' }, at === null ? {} : { movedAt: at });
}
function saveMeal(m) {
  const f = mealFields_(m);
  return locked_(async () => {
    const x = await byKey_('Meals', String(m.id));
    if (!x) throw new Error('That meal was already removed.');
    if (x.o.loc !== f.loc) f.movedAt = new Date().toISOString(); // every move is time-stamped here, whatever the page sent, so the thaw clock never depends on the page
    await putRow_('Meals', x.r, Object.assign(x.o, f));
    return true;
  });
}
const removeMeal = id => locked_(async () => { const x = await byKey_('Meals', String(id)); if (x) await delRow_('Meals', x.r); return true; });
function importMeals(p) { // p.items = [{container, loc}] so every container can go to the fridge or the freezer on its own
  const me = me_(), base = mealFields_({ name: p.name, created: p.created, loc: 'fridge' }), stored = String(p.stored || p.created || '');
  if (!D_.test(stored) || !base.created) throw new Error('Pick the dates for this meal.');
  const items = (p.items || (p.containers || []).map(c => ({ container: c, loc: p.loc })))
    .map(x => ({ container: String(x.container), loc: x.loc === 'freezer' ? 'freezer' : 'fridge' }));
  if (!items.length) throw new Error('Pick at least one container.');
  return locked_(async () => {
    const [mr, cr] = (await manyR_(['Meals', 'Config'])).map(a => a.map(x => x.o));
    const max = cfg_(cr).containers, used = new Set(mr.map(r => r.container));
    items.forEach((x, i) => {
      const c = x.container;
      if (!/^CONT-\d{2}$/.test(c) || +c.slice(5) < 1 || +c.slice(5) > max) throw new Error(c + ' is not one of your containers.');
      if (items.findIndex(y => y.container === c) !== i) throw new Error(c + ' was picked twice.');
      if (used.has(c)) throw new Error(c + ' already has a meal in it. Reopen Import to see the free containers.');
    });
    const made = items.map(x => ({ id: uuid_().slice(0, 8), container: x.container, name: base.name, created: base.created,
      frozen: x.loc === 'freezer' ? stored : '', moved: stored, loc: x.loc, addedBy: me, movedAt: new Date().toISOString() }));
    await addRows_('Meals', made);
    return made;
  });
}

// ======================================================================
// VAULT — receipts. Photos live in a "Household Vault" folder in Google Drive, filed by year and month;
// the details live in the "Receipts" tab. Reading a photo uses Drive's built-in text recognition.
// ======================================================================
const CATS = ['Groceries', 'Dining', 'Fuel', 'Auto', 'Home', 'Health', 'Shopping', 'Entertainment', 'Travel', 'Utilities', 'Work', 'Gifts', 'Other'];
const MONTHS_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SCAN_MARK = 'household-vault-scan', FILED_MARK = 'household-vault-receipt', FOLDER = 'application/vnd.google-apps.folder';
const q_ = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const fileGet_ = (id, fields) => g(DRV + '/files/' + enc(id) + '?supportsAllDrives=true&fields=' + enc(fields));
const mkFolder_ = async (name, parent) => (await g(DRV + '/files?supportsAllDrives=true&fields=id', { method: 'POST', json: { name, mimeType: FOLDER, parents: parent ? [parent] : undefined } })).id;
const trash_ = id => g(DRV + '/files/' + enc(id) + '?supportsAllDrives=true', { method: 'PATCH', json: { trashed: true } });
let VR = '', VF = {}; // the vault folder and its sub-folders, remembered for this visit

async function getVault() {
  me_();
  const [r, c] = (await manyR_(['Receipts', 'Config'])).map(a => a.map(x => x.o));
  return { receipts: r.sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created)), ocr: true, folder: (c.find(x => x.key === 'vaultFolder') || { value: '' }).value, cats: CATS };
}
// The household folder is made by whoever scans first, next to the Scout sheet when possible, and shared with everyone who can edit that sheet.
async function vaultRoot_() {
  if (VR) return VR;
  const id = await cfgGet_('vaultFolder');
  if (id) { try { const f = await fileGet_(id, 'id,trashed'); if (!f.trashed) return (VR = id); } catch (e) {} }
  let parent = ''; try { parent = ((await fileGet_(SHEET_ID, 'parents')).parents || [])[0] || ''; } catch (e) {}
  let root; try { root = await mkFolder_('Household Vault', parent); } catch (e) { root = await mkFolder_('Household Vault', ''); }
  try {
    const ps = (await g(DRV + '/files/' + SHEET_ID + '/permissions?supportsAllDrives=true&fields=' + enc('permissions(emailAddress,role,type)'))).permissions || [];
    for (const p of ps) if (p.type === 'user' && p.role === 'writer' && p.emailAddress && p.emailAddress.toLowerCase() !== AUTH.email.toLowerCase())
      await g(DRV + '/files/' + root + '/permissions?supportsAllDrives=true&sendNotificationEmail=false', { method: 'POST', json: { role: 'writer', type: 'user', emailAddress: p.emailAddress } }).catch(() => {});
  } catch (e) {}
  await cfgSet_('vaultFolder', root);
  return (VR = root);
}
async function subfolder_(parent, name) {
  const k = parent + ':' + name; if (VF[k]) return VF[k];
  const r = await g(DRV + '/files?supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1&fields=' + enc('files(id)') + '&q=' + enc("'" + parent + "' in parents and name='" + q_(name) + "' and mimeType='" + FOLDER + "' and trashed=false"));
  return (VF[k] = (r.files && r.files[0] && r.files[0].id) || await mkFolder_(name, parent));
}
async function monthFolder_(date) { // Household Vault / Receipts / 2026 / 10 October
  const y = date.slice(0, 4), m = +date.slice(5, 7);
  return subfolder_(await subfolder_(await subfolder_(await vaultRoot_(), 'Receipts'), y), (m < 10 ? '0' : '') + m + ' ' + MONTHS_[m - 1]);
}
async function upload_(meta, bytes, mime) { // one multipart upload: details first, then the file
  const b = 'scout' + Math.random().toString(36).slice(2);
  const body = new Blob(['--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + b + '\r\nContent-Type: ' + mime + '\r\n\r\n', bytes, '\r\n--' + b + '--']);
  return g('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType', { method: 'POST', body, headers: { 'Content-Type': 'multipart/related; boundary=' + b } });
}
async function ocrText_(bytes, mime) { // Drive turns the photo into a Google Doc and reads the text; the Doc is deleted straight after
  const doc = await upload_({ name: 'ocr-' + Date.now(), mimeType: 'application/vnd.google-apps.document' }, bytes, mime);
  try { return await g(DRV + '/files/' + doc.id + '/export?mimeType=' + enc('text/plain'), { as: 'text' }); }
  finally { g(DRV + '/files/' + doc.id + '?supportsAllDrives=true', { method: 'DELETE' }).catch(() => {}); }
}

// ---- step 1: store the photo and read it ----
async function scanReceipt(p) {
  me_();
  const mime = String(p.mime || '').toLowerCase(), b64 = String(p.data || '');
  if (!/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(mime)) throw new Error('Use a photo (JPG, PNG, HEIC) or a PDF.');
  if (!b64 || b64.length > 9000000) throw new Error('That file is too large. Try a smaller photo.');
  const d = new Date(), z = n => String(n).padStart(2, '0'), ext = mime === 'application/pdf' ? 'pdf' : mime.split('/')[1].replace('jpeg', 'jpg'),
        name = 'scan-' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()) + '-' + uuid_().slice(0, 4) + '.' + ext,
        bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const reading = ocrText_(bytes, mime).then(t => ({ t }), e => ({ e })); // reading and filing happen at the same time
  const inbox = await subfolder_(await vaultRoot_(), '_Inbox');
  const file = await upload_({ name, parents: [inbox], description: SCAN_MARK }, bytes, mime);
  const res = { fileId: file.id, fileName: cut_(String(p.name || name), 120), mime, ocr: false, why: '', parsed: null }, o = await reading;
  if (o.t != null) { try { res.parsed = parseReceipt_(o.t); res.ocr = true; } catch (e) { res.why = 'The text could not be read from this photo.'; res.detail = String(e.message || e).slice(0, 200); } }
  else { res.why = 'The text could not be read from this photo.'; res.detail = String(o.e && o.e.message || o.e).slice(0, 200); }
  return res;
}
async function discardScan(fileId) { // the person closed the form without saving
  try { const f = await fileGet_(String(fileId), 'description'); if (f.description === SCAN_MARK) await trash_(String(fileId)); } catch (e) {}
  return true;
}

// ---- step 2: save what the person confirmed ----
function receiptFields_(p) {
  const t = (v, n) => clip_(v, n);
  const merchant = t(p.merchant, 80);
  if (!merchant) throw new Error('Enter the business the receipt is from.');
  const date = t(p.date, 10), dt = D_.test(date) ? new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) : null;
  if (!dt || dt.getMonth() !== +date.slice(5, 7) - 1 || +date.slice(0, 4) < 1990) throw new Error('Pick the date of the purchase.');
  const num = (v, req) => { if (v === '' || v == null) { if (!req) return ''; throw new Error('Enter the amount on the receipt.'); } const n = Number(v); if (!(n >= 0 && n < 1e8)) throw new Error(req ? 'Enter the amount on the receipt.' : 'Check the tax amount.'); return n.toFixed(2); };
  const d = p.data && typeof p.data === 'object' ? p.data : {}, items = (Array.isArray(d.items) ? d.items : []).slice(0, 60)
    .map(i => ({ d: t(i.d, 60), q: i.q > 0 ? +i.q : '', p: i.p === '' || i.p == null || isNaN(i.p) ? '' : +(+i.p).toFixed(2) })).filter(i => i.d);
  const data = { items, subtotal: d.subtotal === '' || d.subtotal == null || isNaN(d.subtotal) ? '' : +(+d.subtotal).toFixed(2),
    time: /^\d{2}:\d{2}$/.test(d.time) ? d.time : '', address: t(d.address, 140), phone: t(d.phone, 30), payment: t(d.payment, 40) };
  return { merchant, date, amount: num(p.amount, true), tax: num(p.tax, false), currency: /^[A-Z]{3}$/.test(p.currency) ? p.currency : 'CAD',
    category: CATS.indexOf(p.category) >= 0 ? p.category : 'Other', kind: p.kind === 'digital' ? 'digital' : 'physical', notes: t(p.notes, 500), data: JSON.stringify(data) };
}

async function saveReceipt(p) {
  const me = me_(), f = receiptFields_(p);
  let rec;
  await locked_(async () => {
    const x = p.id ? await byKey_('Receipts', String(p.id)) : null;
    if (p.id && !x) throw new Error('That receipt was already removed.');
    if (x) { rec = Object.assign(x.o, f); await putRow_('Receipts', x.r, rec); return; }
    const fileId = String(p.fileId || ''); let file;
    try { file = await fileGet_(fileId, 'id,name,mimeType,description'); } catch (e) { throw new Error('The scanned file is missing. Scan the receipt again.'); }
    if (file.description !== SCAN_MARK) throw new Error('That file is not a new scan.');
    rec = Object.assign({ id: uuid_().slice(0, 8), uploader: me, fileId, fileName: cut_(String(p.fileName || file.name), 120), mime: file.mimeType, created: new Date().toISOString() }, f);
    await addRows_('Receipts', [rec]);
  });
  await fileReceipt_(rec); // put the photo in Receipts / year / month and give it a readable name
  return rec;
}
async function fileReceipt_(rec) {
  try {
    const f = await fileGet_(rec.fileId, 'id,name,parents'), ext = (/\.([A-Za-z0-9]+)$/.exec(f.name) || [0, 'jpg'])[1].toLowerCase(),
          safe = rec.merchant.replace(/[\\\/:*?"<>|]+/g, ' ').trim().slice(0, 40), dest = await monthFolder_(rec.date), rm = (f.parents || []).filter(x => x !== dest).join(',');
    await g(DRV + '/files/' + enc(rec.fileId) + '?supportsAllDrives=true&fields=id&addParents=' + enc(dest) + (rm ? '&removeParents=' + enc(rm) : ''),
      { method: 'PATCH', json: { name: rec.date + ' ' + safe + ' ' + rec.amount + '.' + ext, description: FILED_MARK } });
  } catch (e) { /* the receipt is saved either way; filing in Drive is best effort */ }
}
async function deleteReceipt(id) {
  let fid = '';
  await locked_(async () => { const x = await byKey_('Receipts', String(id)); if (x) { fid = x.o.fileId; await delRow_('Receipts', x.r); } });
  if (fid) { try { await trash_(fid); } catch (e) {} }
  return true;
}
async function getReceiptFile(id) { // the original photo or PDF of one receipt, as base64
  me_();
  const x = await byKey_('Receipts', String(id));
  if (!x) throw new Error('That receipt no longer exists.');
  let blob; try { blob = await g(DRV + '/files/' + enc(x.o.fileId) + '?alt=media&supportsAllDrives=true', { as: 'blob' }); }
  catch (e) { throw new Error('The original file could not be opened. Ask the person who scanned it to share the Household Vault folder with you in Google Drive.'); }
  const data = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1] || ''); fr.onerror = () => no(fr.error); fr.readAsDataURL(blob); });
  return { name: x.o.fileName, mime: x.o.mime || blob.type, data };
}

// ---- reading the text of a receipt ----
const BRANDS_ = [
  [/safeway/i, 'Safeway', 'Groceries'], [/save[- ]?on[- ]?foods/i, 'Save-On-Foods', 'Groceries'], [/sobeys/i, 'Sobeys', 'Groceries'], [/superstore/i, 'Real Canadian Superstore', 'Groceries'],
  [/no frills/i, 'No Frills', 'Groceries'], [/loblaw/i, 'Loblaws', 'Groceries'], [/fresh\s?co/i, 'FreshCo', 'Groceries'], [/costco/i, 'Costco', 'Groceries'], [/whole foods/i, 'Whole Foods', 'Groceries'],
  [/co-?op (food|grocery|wine)/i, 'Co-op Food Store', 'Groceries'], [/t&t supermarket/i, 'T&T Supermarket', 'Groceries'], [/trader joe/i, "Trader Joe's", 'Groceries'], [/kroger/i, 'Kroger', 'Groceries'],
  [/wal-?mart/i, 'Walmart', 'Shopping'], [/dollarama/i, 'Dollarama', 'Shopping'], [/dollar tree/i, 'Dollar Tree', 'Shopping'], [/best ?buy/i, 'Best Buy', 'Shopping'], [/amazon/i, 'Amazon', 'Shopping'],
  [/\btarget\b/i, 'Target', 'Shopping'], [/winners|homesense|marshalls/i, 'Winners', 'Shopping'], [/staples/i, 'Staples', 'Work'], [/canadian tire/i, 'Canadian Tire', 'Auto'], [/princess auto/i, 'Princess Auto', 'Auto'],
  [/home depot/i, 'The Home Depot', 'Home'], [/\brona\b/i, 'Rona', 'Home'], [/lowe'?s/i, "Lowe's", 'Home'], [/ikea/i, 'IKEA', 'Home'], [/home hardware/i, 'Home Hardware', 'Home'],
  [/shoppers drug/i, 'Shoppers Drug Mart', 'Health'], [/london drugs/i, 'London Drugs', 'Health'], [/rexall/i, 'Rexall', 'Health'], [/walgreens/i, 'Walgreens', 'Health'], [/\bcvs\b/i, 'CVS', 'Health'], [/pharmasave/i, 'Pharmasave', 'Health'],
  [/tim hortons|tim horton/i, 'Tim Hortons', 'Dining'], [/starbucks/i, 'Starbucks', 'Dining'], [/mcdonald/i, "McDonald's", 'Dining'], [/\ba ?& ?w\b/i, 'A&W', 'Dining'], [/subway/i, 'Subway', 'Dining'],
  [/wendy'?s/i, "Wendy's", 'Dining'], [/burger king/i, 'Burger King', 'Dining'], [/dairy queen/i, 'Dairy Queen', 'Dining'], [/pizza hut/i, 'Pizza Hut', 'Dining'], [/domino'?s/i, "Domino's", 'Dining'],
  [/boston pizza/i, 'Boston Pizza', 'Dining'], [/chipotle/i, 'Chipotle', 'Dining'], [/\bkfc\b/i, 'KFC', 'Dining'], [/popeyes/i, 'Popeyes', 'Dining'],
  [/\bshell\b/i, 'Shell', 'Fuel'], [/\besso\b/i, 'Esso', 'Fuel'], [/petro-?canada/i, 'Petro-Canada', 'Fuel'], [/husky/i, 'Husky', 'Fuel'], [/chevron/i, 'Chevron', 'Fuel'], [/mobil\b/i, 'Mobil', 'Fuel'],
  [/\bco-?op\b.*\b(gas|fuel|cardlock)\b/i, 'Co-op Gas', 'Fuel'], [/fas gas/i, 'Fas Gas', 'Fuel'], [/circle k/i, 'Circle K', 'Fuel'], [/7-?eleven/i, '7-Eleven', 'Fuel'],
  [/\buber\b/i, 'Uber', 'Travel'], [/air canada/i, 'Air Canada', 'Travel'], [/westjet/i, 'WestJet', 'Travel'], [/\bhotel\b|\binn\b|\bresort\b/i, '', 'Travel'],
  [/\btelus\b/i, 'Telus', 'Utilities'], [/\brogers\b/i, 'Rogers', 'Utilities'], [/\bbell\b.*(mobility|canada)/i, 'Bell', 'Utilities'], [/\bshaw\b/i, 'Shaw', 'Utilities'], [/\batco\b/i, 'ATCO', 'Utilities'], [/epcor/i, 'EPCOR', 'Utilities'],
  [/cineplex|landmark cinemas/i, 'Cineplex', 'Entertainment']
];
const CAT_WORDS_ = [[/unleaded|diesel|\bregular\b.*\bl\b|litres?|liters?|\bpump\b|fuel/i, 'Fuel'], [/\btip\b|gratuity|\bserver\b|\btable\b|\bguests?\b|restaurant|\bcafe\b|coffee|latte|burger|pizza|sandwich|\bdine\b/i, 'Dining'],
  [/pharmacy|prescription|\brx\b|medicine|vitamin/i, 'Health'], [/produce|dairy|bread|\bmilk\b|\beggs?\b|bananas?|chicken|\bbeef\b|\bcheese\b|grocery/i, 'Groceries'], [/lumber|hardware|paint|\bscrews?\b/i, 'Home'],
  [/oil change|tires?\b|wiper|battery|brake/i, 'Auto'], [/movie|ticket|admission/i, 'Entertainment']];
const SKIP_NAME_ = /^(welcome|thank|receipt|invoice|customer|copy|store\b|tel\b|phone|www|http|order|server|table|date|time|gst|tax|cashier|terminal|card|visa|master|debit|credit|merchant|sale\b|duplicate|reprint|survey|please|tax invoice|eat in|take out|dine in)/i;
const MONEY_G_ = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?!\d|\s*%)/g;
const moneyIn_ = s => { const r = []; let m; MONEY_G_.lastIndex = 0; while ((m = MONEY_G_.exec(s))) r.push(parseFloat(m[1].replace(/,/g, '') + '.' + m[2])); return r; };
const AMT_ONLY_ = /^[\s$€£-]*\d[\d,]*\.\d{2}\s*-?\s*[A-Za-z]?$/;

function titleCase_(s) {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (!letters || letters !== letters.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s\-'(])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/(\d)(l|g|kg|ml|oz|lb|pk|ct)\b/g, (m, a, b) => a + b.toUpperCase());
}
function datesIn_(lines, dayFirst) {
  const now = Date.now(), lo = now - 3660 * 864e5, hi = now + 2 * 864e5, out = [];
  const MN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const ok = (y, m, d) => { if (y < 100) y += 2000; const t = new Date(y, m - 1, d); return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d && +t >= lo && +t <= hi; };
  const add = (y, m, d, idx, hasTime, amb) => { if (y < 100) y += 2000; out.push({ date: y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d, idx, hasTime, amb }); };
  lines.forEach((line, idx) => {
    const hasTime = /\b\d{1,2}:\d{2}\b/.test(line); let m;
    const iso = /(?:^|\D)(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})(?!\d)/g;
    while ((m = iso.exec(line))) if (ok(+m[1], +m[2], +m[3])) add(+m[1], +m[2], +m[3], idx, hasTime, false);
    const dmy = /(?:^|\D)(\d{1,2})[-\/.](\d{1,2})[-\/.](20\d{2}|\d{2})(?!\d)/g;
    while ((m = dmy.exec(line))) {
      const a = +m[1], b = +m[2], y = +m[3]; let d, mo, amb = false;
      if (a > 12 && b <= 12) { d = a; mo = b; } else if (b > 12 && a <= 12) { mo = a; d = b; }
      else if (a <= 12 && b <= 12) { amb = a !== b; if (dayFirst) { d = a; mo = b; } else { mo = a; d = b; } } else continue;
      if (ok(y, mo, d)) add(y, mo, d, idx, hasTime, amb);
    }
    const mon1 = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2}|\d{2})\b/gi;
    while ((m = mon1.exec(line))) if (ok(+m[3], MN[m[1].toLowerCase()], +m[2])) add(+m[3], MN[m[1].toLowerCase()], +m[2], idx, hasTime, false);
    const mon2 = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2}|\d{2})\b/gi;
    while ((m = mon2.exec(line))) if (ok(+m[3], MN[m[2].toLowerCase()], +m[1])) add(+m[3], MN[m[2].toLowerCase()], +m[1], idx, hasTime, false);
  });
  return out;
}
function totalsIn_(lines) {
  const NOT = /sub\s*-?\s*total|before\s*tax|total\s*(savings|discount|points|items?|qty|quantity|number|tax|gst|hst|pst|tendered|saved|rewards?|bonus)|items?\s*total|points|saved|savings|tendered/i;
  let total = null, sub = null, tax = 0, taxSeen = false, totalTax = null;
  lines.forEach((l, i) => {
    let v = moneyIn_(l);
    if (!v.length && lines[i + 1] && AMT_ONLY_.test(lines[i + 1])) v = moneyIn_(lines[i + 1]);
    if (/sub\s*-?\s*total/i.test(l) && v.length && sub == null) sub = v[v.length - 1];
    if (/\b(gst|hst|pst|qst|tps|tvq|vat|iva|tax)\b/i.test(l) && !/tax\s*(invoice|id|no\b|number|#|reg)|(gst|hst)\s*(reg|no\b|number|#)|business\s*(no|number)|included|exempt|taxable|before\s*tax|total\s*due/i.test(l) && v.length) {
      if (/total\s*tax|tax\s*total/i.test(l)) totalTax = v[v.length - 1]; else { tax += v[v.length - 1]; taxSeen = true; }
    }
    if (NOT.test(l)) return;
    const m = /\b(grand\s*total|total\s*due|amount\s*due|order\s*total|totale|total\s*amount|amount\s*charged|total\s*charged|balance\s*due|amount\s*paid|to\s*pay|total)\b/i.exec(l);
    if (!m || !v.length) return;
    const amt = v[v.length - 1]; if (!(amt > 0)) return;
    const rank = /grand|due|order|totale|amount\s*(due|charged)|charged/i.test(m[1]) ? 3 : /^total/i.test(m[1]) ? 2 : 1;
    if (!total || rank > total.rank || (rank === total.rank && amt >= total.amt)) total = { amt, rank };
  });
  return { total: total ? total.amt : null, sub, tax: totalTax != null ? totalTax : (taxSeen ? +tax.toFixed(2) : null) };
}
function pairColumns_(lines) { // some scans list all the labels first and all the amounts after
  const isLab = l => !/\d/.test(l) && l.length < 40 && /(sub\s*-?\s*total|total|gst|hst|pst|qst|tax|visa|mastercard|master card|debit|credit|interac|cash|change|tender|balance|amex|amount)/i.test(l);
  const out = []; let i = 0;
  while (i < lines.length) {
    if (!isLab(lines[i])) { i++; continue; }
    let j = i; while (j < lines.length && isLab(lines[j])) j++;
    let k = j; while (k < lines.length && AMT_ONLY_.test(lines[k])) k++;
    const nl = j - i, na = k - j;
    if (nl >= 2 && na >= nl) for (let t = 0; t < nl; t++) out.push(lines[i + t] + ' ' + lines[k - nl + t]);
    i = Math.max(j, i + 1);
  }
  return out;
}
function parseReceipt_(text) {
  let lines = String(text || '').replace(/[﻿​]/g, '').replace(/\r/g, '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 400);
  const all = lines.join('\n');
  const euro = (all.match(/\d,\d{2}(?!\d)/g) || []).length >= 2 && !/\d\.\d{2}(?!\d)/.test(all);
  if (euro) lines = lines.map(l => l.replace(/(\d{1,3}(?:\.\d{3})*),(\d{2})(?!\d)/g, (m, a, b) => a.replace(/\./g, '') + '.' + b));
  const out = { merchant: '', date: '', amount: null, tax: null, currency: 'CAD', category: 'Other',
    data: { items: [], subtotal: '', time: '', address: '', phone: '', payment: '' }, flags: {} };
  // currency
  if (/€|\bEUR\b/.test(all)) out.currency = 'EUR'; else if (/£|\bGBP\b/.test(all)) out.currency = 'GBP'; else if (/\bUSD\b|US\s?\$/.test(all)) out.currency = 'USD';
  // business and category
  const head = lines.slice(0, 14).join('\n');
  let br = BRANDS_.find(b => b[0].test(head)) || BRANDS_.find(b => b[0].test(all));
  if (br && br[1]) { out.merchant = br[1]; out.flags.merchant = true; }
  if (!out.merchant) {
    const cand = lines.slice(0, 8).find(l => /[A-Za-z]{3}/.test(l) && !SKIP_NAME_.test(l) && (l.replace(/[^\d]/g, '').length / l.length) < 0.3 && l.length <= 50 && !/\b(st|street|ave|avenue|rd|road|blvd|hwy|dr)\b\.?/i.test(l) && !/@|\.com\b/i.test(l));
    if (cand) { out.merchant = titleCase_(cand.replace(/\s*[#*-]\s*\d+.*$/, '').replace(/\s+(store|unit|location)\s*#?\s*\d+.*$/i, '').trim()).slice(0, 60); out.flags.merchant = !!out.merchant; }
  }
  if (br) out.category = br[2];
  else { const cw = CAT_WORDS_.find(c => c[0].test(all)); if (cw) out.category = cw[1]; }
  // date and time
  const ds = datesIn_(lines, euro || /\b(totale|iva|scontrino)\b/i.test(all)).sort((a, b) => (b.hasTime - a.hasTime) || (a.idx - b.idx));
  if (ds.length) {
    out.date = ds[0].date; out.flags.date = true; out.flags.dateAmbiguous = ds[0].amb;
    const tl = lines[ds[0].idx], tm = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/.exec(tl) || /\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/.exec(lines[ds[0].idx + 1] || '');
    if (tm) { let h = +tm[1]; if (tm[3]) { h = h % 12 + (/p/i.test(tm[3]) ? 12 : 0); } if (h < 24) out.data.time = (h < 10 ? '0' : '') + h + ':' + tm[2]; }
  }
  // amounts
  let t = totalsIn_(lines);
  if (t.total == null) { const t2 = totalsIn_(lines.concat(pairColumns_(lines))); t = { total: t2.total, sub: t.sub != null ? t.sub : t2.sub, tax: t.tax != null ? t.tax : t2.tax }; }
  let amt = t.total;
  if (amt == null) {
    const pool = []; lines.forEach(l => { if (!/cash|change|tender|received|points|saved/i.test(l)) moneyIn_(l).forEach(v => pool.push(v)); });
    if (pool.length) { amt = Math.max.apply(null, pool); out.flags.amountGuess = true; }
  }
  if (amt == null && t.sub != null) { amt = +(t.sub + (t.tax || 0)).toFixed(2); out.flags.amountGuess = true; }
  if (amt != null) { out.amount = amt; out.flags.amount = true; }
  out.tax = t.tax; out.data.subtotal = t.sub != null ? t.sub : '';
  // payment, phone, address
  const pm = /\b(visa|mastercard|master\s?card|amex|american express|interac|debit|credit|cash|apple pay|google pay|discover|gift card)\b/i.exec(all);
  if (pm) { const pl = lines.find(l => /\b(visa|mastercard|master\s?card|amex|american express|interac|debit|credit|discover)\b/i.test(l)) || '', l4 = /(?:\*{2,}|x{2,}|ending in|\.{3})\s*(\d{4})\b/i.exec(pl); out.data.payment = (pm[1][0].toUpperCase() + pm[1].slice(1).toLowerCase()).replace(/^Master\s?card$/i, 'Mastercard') + (l4 ? ' ••••' + l4[1] : ''); }
  const ph = /\(?\b(\d{3})\)?[-. ](\d{3})[-. ](\d{4})\b/.exec(head); if (ph) out.data.phone = '(' + ph[1] + ') ' + ph[2] + '-' + ph[3];
  const ai = lines.slice(0, 12).findIndex(l => /\d{1,6}\s+[A-Za-z0-9 .'-]*\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|hwy|highway|way|ln|lane|cres|crescent|pl|place|ct|court|trail|tr|sq)\b/i.test(l));
  if (ai >= 0) { const nx = lines[ai + 1] || ''; out.data.address = (lines[ai] + (/[A-Z]\d[A-Z] ?\d[A-Z]\d|\b[A-Z]{2}\b.*\d{5}|,\s*[A-Z]{2}\b/.test(nx) ? ', ' + nx : '')).slice(0, 140); }
  // line items
  const NOT_ITEM = /total|tax|gst|hst|pst|qst|vat|visa|master|debit|credit|interac|cash|change|tender|balance|amount|payment|approved|auth\b|ref\b|card|saving|discount|points|rounding|\btip\b|gratuity|you saved|due\b|paid|invoice|phone|tel\b|receipt|date|time|thank|iva\b|^shipping|^items?:?\b|handling/i;
  const items = [];
  lines.forEach(l => {
    const q = /^(\d+)\s*(?:@|x)\s*\$?\s*(\d+\.\d{2})/i.exec(l);
    if (q && items.length) { items[items.length - 1].q = +q[1]; return; }
    if (NOT_ITEM.test(l) || datesIn_([l], false).length) return;
    const m = /^(.*?)\s*[$€£]?\s*(-?\d{1,3}(?:,\d{3})*\.\d{2})\s*(-?)\s*[A-Za-z]{0,2}$/.exec(l);
    if (!m) return;
    let d = m[1].replace(/^\d{4,}\s+/, '').replace(/\s+\d{4,}$/, '').replace(/[$€£]\s*$/, '').trim();
    if ((d.match(/[A-Za-z]/g) || []).length < 2 || d.length > 70) return;
    const mq = /^(\d{1,2})\s*[xX]\s+(.*)$/.exec(d) || /^(\d{1,2})\s+([A-Za-z].*)$/.exec(d), price = (m[3] ? -1 : 1) * parseFloat(m[2].replace(/,/g, ''));
    items.push({ d: titleCase_(mq ? mq[2] : d).slice(0, 60), q: mq && +mq[1] > 1 ? +mq[1] : '', p: price });
  });
  if (items.length <= 60) out.data.items = items.filter(i => !(out.amount != null && Math.abs(i.p - out.amount) < 0.005 && items.length === 1)).slice(0, 60);
  return out;
}


// ---------- the list of everything the page may ask for ----------
const API = { getSources, saveSources, getFamily, getHousehold, savePrefs, saveProfile, googleProfile, syncMe, getRecipes, saveRecipe, deleteRecipe,
  saveEvent, deleteEvent, setSharedColor, saveSharedEvent, deleteSharedEvent, syncShared, searchPlaces, setWeatherPlace, getForecast, getInvite, inviteMember,
  getLists, listOp, getMeals, saveConfig, saveMeal, removeMeal, importMeals, getVault, scanReceipt, discardScan, saveReceipt, deleteReceipt, getReceiptFile };
window.AUTH = AUTH;
window.SRV = { call(fn, args) {
  const f = API[fn];
  if (!f) return Promise.reject(new Error(fn + ' is not available in this version of Scout.'));
  try { return Promise.resolve(f.apply(null, args)); } catch (e) { return Promise.reject(e); }
} };
})();
