/* Scout in the browser. This is the old Apps Script server (Code.gs) rewritten to call Google's own APIs directly,
   using the signed-in person's Google account. Every function the page used to ask Apps Script for is in API at the bottom. */
(function () {
'use strict';
const CLIENT_ID = '205279511864-5t1kng7vpjsk98oor9nuev8jksvckuk7.apps.googleusercontent.com';
const SHEET_ID = '1YcY3HbP-yWpypR83tpE8s5fIwUdtmrsYO49zFUtZ4qI'; // the Scout sheet; point this at another sheet to switch data
const SCOPES = 'openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks.readonly https://www.googleapis.com/auth/drive';
const APP_NAME = 'Scout';
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Edmonton'; } catch (e) { return 'America/Edmonton'; } })();
const HEAD = {
  Sources: ['key', 'owner', 'kind', 'sourceId', 'name', 'color', 'selected'],
  Profiles: ['email', 'name', 'color', 'photo'],
  Recipes: ['id', 'title', 'image', 'source', 'servings', 'time', 'tags', 'ingredients', 'steps', 'notes', 'fav', 'addedBy', 'created'],
  Lists: ['id', 'name', 'kind', 'owner', 'created', 'date', 'event'],
  Board: ['id', 'kind', 'text', 'done', 'color', 'assignee', 'due', 'by', 'created', 'updated'],
  ListItems: ['id', 'list', 'text', 'done', 'assignee', 'addedBy', 'created', 'qty'],
  Meals: ['id', 'container', 'name', 'created', 'frozen', 'moved', 'loc', 'addedBy', 'movedAt'],
  Config: ['key', 'value'],
  Events: ['sourceKey', 'owner', 'id', 'title', 'start', 'end', 'allDay', 'location'],
  SharedEvents: ['id', 'title', 'start', 'end', 'allDay', 'location', 'notes', 'createdBy', 'updatedBy', 'updated'],
  Rev: ['family', 'lists', 'board', 'meals', 'rec'], // row 2: a stamp per part, changed on every save, so other phones know what to re-read
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
const KEYS_URL = 'SCOUT_KEYS_URL' in window ? window.SCOUT_KEYS_URL : 'https://script.google.com/macros/s/AKfycbzuzbFoloAkEWgyeh163QAYWqlmjW7iVWHOj8-qDITyIU1taltCLWJrKrzXmNm6YgNi/exec'; // tests set window.SCOUT_KEYS_URL first; set it to '' to go back to the hourly Reconnect
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
      tc = KEYS_URL ? google.accounts.oauth2.initCodeClient(Object.assign({ ux_mode: 'popup', login_hint: A.email || undefined, select_account: !A.email, callback: gotCode }, common))
                    : google.accounts.oauth2.initTokenClient(Object.assign({ callback: got }, common));
    }
    if (gate) gate.querySelector('#gb').disabled = false;
  }
  function click() { // must call Google straight from the tap, or iPhone blocks the pop-up
    if (!tc) return;
    gate.querySelector('#gb').disabled = true;
    try { KEYS_URL ? tc.requestCode() : tc.requestAccessToken({ prompt: A.email ? '' : 'select_account', login_hint: A.email || undefined }); } catch (e) { show(!A.email, e.message); }
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
    signOut() { ls_.del('fw-cache-1'); ls_.del(AK); location.reload(); }, // this device only; revoking everywhere is done at myaccount.google.com/permissions
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
  const sig = a => a.map(o => HEAD.Events.map(k => o[k] == null ? '' : String(o[k])).join('\u0001')).sort().join('\u0002');
  let changed = false;
  // a calendar that failed keeps its old events instead of vanishing; nothing is written when nothing changed
  await locked_(async () => {
    const all = await rows_('Events'), was = all.filter(r => r.owner === me && !failed.has(r.sourceKey));
    if (sig(was) === sig(ev)) return;
    changed = true; await write_('Events', all.filter(r => r.owner !== me || failed.has(r.sourceKey)).concat(ev));
  });
  try { await mirrorShared_(); } catch (e) { errors.push('Shared Events calendar: ' + e.message); } // also put the household's shared events in this person's Google Calendar
  await cfgSet_('sync:' + me, new Date().toISOString()); // so everyone can see how fresh each person's calendar is
  return { count: ev.length, errors, unchanged: !changed };
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
  // shortcut: one-off household rename (JackTheRedFox → Jack); only touches that exact old name, so a later change by Jack sticks; delete once applied
  const rn = prof.find(r => r.email.toLowerCase() === 'jrjr6@hotmail.ca' && r.name === 'JackTheRedFox');
  if (rn) { rn.name = 'Jack'; try { await locked_(async () => { const r = await findRow_('Profiles', 1, v => v[0].toLowerCase() === 'jrjr6@hotmail.ca'); if (r) await putRow_('Profiles', r, Object.assign({}, rn)); }); } catch (e) {} }
  const sel = new Set(src.filter(r => r.selected === 'Y').map(r => r.key)), names = Object.fromEntries(src.map(r => [r.key, r.name]));
  // Everyone sees everyone's selected calendars. These two maps tell the screen who is sharing what, and how fresh it is.
  const cv = k => (conf.find(r => r.key === k) || { value: '' }).value, sharing = {}, sync = {};
  src.forEach(r => { if (r.selected === 'Y') sharing[r.owner] = (sharing[r.owner] || 0) + 1; });
  conf.forEach(r => { if (r.key.indexOf('sync:') === 0) sync[r.key.slice(5)] = r.value; });
  const rev = cv('sharedRev'), mirrored = ls_.get(mk('mirrored')) || '';
  const have = new Set(prof.map(r => r.email.toLowerCase()));
  const invited = conf.filter(r => r.key.indexOf('invite:') === 0 && !have.has(r.key.slice(7))).map(r => ({ email: r.key.slice(7), at: r.value }));
  let writable = null; try { writable = JSON.parse(ls_.get(mk('writable')) || 'null'); } catch (e) {}
  return { me, profiles: prof, invited, weather: placeOf_(cv(WX_KEY)), prefs: { theme: themePick_(cv('theme:' + me)), nav: cv('nav:' + me) },
    places: (() => { try { return JSON.parse(cv('places') || '[]'); } catch (e) { return []; } })(),
    where: Object.fromEntries(conf.filter(r => r.key.indexOf('where:') === 0 && r.value).map(r => { try { return [r.key.slice(6), JSON.parse(r.value)]; } catch (e) { return [r.key.slice(6), null]; } })), hasSaved: src.some(r => r.owner === me), writable,
    sharing, sync, sharedColor: sharedColor_(conf), sharedStale: !!rev && rev !== mirrored,
    events: evs.filter(e => sel.has(e.sourceKey)).map(e => Object.assign(e, { cal: names[e.sourceKey] || '' })).concat(shr.map(sharedOut_)) };
}
// Lists + meals in one round trip, loaded quietly after the calendar appears so those tabs open instantly.
async function getHousehold() { const [l, i, m, c, b] = (await manyR_(['Lists', 'ListItems', 'Meals', 'Config', 'Board'])).map(a => a.map(x => x.o)); return { lists: l, items: i, meals: m, config: cfg_(c), board: b }; }
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
  await cfgSet_('invite:' + email, new Date().toISOString()); // shown in the Household list until they open the app
  return { url: appUrl_() };
}

// ---------- shopping lists: one per trip, named for the store, with an optional planned date ----------
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
async function getLists() { const [l, i] = (await manyR_(['Lists', 'ListItems'])).map(a => a.map(x => x.o)); return { lists: l.filter(x => x.kind !== 'todo'), items: i }; } // old to-do lists stay in the sheet but are not shown
function listOp_(op, a) {
  const me = me_(), now = new Date().toISOString(), nid = () => uuid_().slice(0, 8), t = (v, n) => clip_(v, n);
  return locked_(async () => {
    if (op === 'addList') {
      const l = { id: nid(), name: t(a.name, 60) || 'Costco', kind: 'shopping', owner: me, created: now, date: ISO_DAY.test(a.date) ? a.date : '' };
      await addRows_('Lists', [l]); return l;
    }
    if (op === 'editList') {
      const x = await byKey_('Lists', a.id);
      if (x) { const o = x.o; o.name = t(a.name, 60) || o.name; if (a.date != null) o.date = ISO_DAY.test(a.date) ? a.date : ''; await putRow_('Lists', x.r, o); }
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
      (a.texts || []).slice(0, 200).forEach((x, k) => { x = t(x, 200); if (x) out.push({ id: nid(), list: a.list, text: x, done: 'N', assignee: t(a.assignee, 120), addedBy: me, created: now, qty: qty_((a.qtys || [])[k]) }); });
      await addRows_('ListItems', out); return out;
    }
    if (op === 'setItem') {
      const x = await byKey_('ListItems', a.id); if (!x) return true;
      const i = x.o;
      Object.assign(i, a.done != null ? { done: a.done ? 'Y' : 'N' } : {}, a.assignee != null ? { assignee: t(a.assignee, 120) } : {}, a.text != null ? { text: t(a.text, 200) || i.text } : {}, a.qty != null ? { qty: qty_(a.qty) } : {});
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

const qty_ = v => { const n = Math.round(+v); return n > 1 ? String(Math.min(n, 99)) : ''; }; // 1 is stored as blank
// A shopping trip with a date shows on everyone's calendar as an all-day shared event; the list keeps the event's id.
async function listOp(op, a) {
  const before = op === 'delList' ? await byKey_('Lists', a.id) : null;
  const r = await listOp_(op, a);
  if (op === 'addList' || op === 'editList' || op === 'delList') {
    try { await tripEvent_(op === 'delList' ? (before && before.o) : null, op === 'addList' ? r.id : a.id, op === 'delList'); bump_('family'); } catch (e) { /* the list is saved even if the calendar could not be updated */ }
  }
  if (op === 'addList') { const x = await byKey_('Lists', r.id); if (x) r.event = x.o.event; }
  return r;
}
async function tripEvent_(gone, id, deleted) {
  const x = deleted ? null : await byKey_('Lists', id), l = deleted ? gone : x && x.o;
  if (!l) return;
  if (!deleted && ISO_DAY.test(l.date)) {
    const d = new Date(l.date + 'T12:00:00'); d.setDate(d.getDate() + 1);
    const end = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const ev = { title: '🛒 ' + l.name + ' trip', allDay: true, start: l.date, end, notes: 'From the Shopping list in Scout' };
    let saved;
    try { saved = await saveSharedEvent(l.event ? Object.assign({ id: l.event }, ev) : ev); }
    catch (e) { if (!l.event) throw e; saved = await saveSharedEvent(ev); } // someone deleted it from the calendar: make a new one
    if (saved.id !== l.event) await locked_(async () => { const y = await byKey_('Lists', id); if (y) { y.o.event = saved.id; await putRow_('Lists', y.r, y.o); } });
  } else if (l.event) {
    await deleteSharedEvent(l.event);
    if (!deleted) await locked_(async () => { const y = await byKey_('Lists', id); if (y) { y.o.event = ''; await putRow_('Lists', y.r, y.o); } });
  }
}

// ---------- whiteboard: to-dos written on the board and sticky-note notices, shared by the household ----------
const NOTE_COLORS = ['yellow', 'pink', 'blue', 'green', 'orange', 'purple'];
async function getBoard() { me_(); return (await rows_('Board')); }
function boardOp(op, a) {
  const me = me_(), now = new Date().toISOString(), t = (v, n) => clip_(v, n);
  return locked_(async () => {
    if (op === 'add') {
      const note = a.kind === 'note', text = t(a.text, note ? 400 : 140);
      if (!text) throw new Error('Write something first.');
      const o = { id: uuid_().slice(0, 8), kind: note ? 'note' : 'todo', text, done: 'N', color: NOTE_COLORS.includes(a.color) ? a.color : note ? 'yellow' : '', assignee: note ? '' : t(a.assignee, 120), due: !note && ISO_DAY.test(a.due) ? a.due : '', by: me, created: now, updated: now };
      await addRows_('Board', [o]); return o;
    }
    if (op === 'set') {
      const x = await byKey_('Board', a.id); if (!x) return null;
      const o = x.o, note = o.kind === 'note';
      if (a.text != null) o.text = t(a.text, note ? 400 : 140) || o.text;
      if (a.done != null) o.done = a.done ? 'Y' : 'N';
      if (a.color != null && NOTE_COLORS.includes(a.color)) o.color = a.color;
      if (a.assignee != null && !note) o.assignee = t(a.assignee, 120);
      if (a.due != null && !note) o.due = ISO_DAY.test(a.due) ? a.due : '';
      o.updated = now; await putRow_('Board', x.r, o); return o;
    }
    if (op === 'del') { const x = await byKey_('Board', a.id); if (x) await delRow_('Board', x.r); return true; }
    if (op === 'clearDone') {
      const B = await rows_('Board'); if (B.some(i => i.kind === 'todo' && i.done === 'Y')) await write_('Board', B.filter(i => !(i.kind === 'todo' && i.done === 'Y')));
      return true;
    }
    throw new Error('Unknown whiteboard action.');
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

// ---------- live updates ----------
// Every save stamps its part of the household in Rev row 2. Open phones read that one row every few seconds and re-read only what changed.
const AREA = { saveSources: 'family', savePrefs: 'family', saveNav: 'family', saveProfile: 'family', syncMe: 'family', saveEvent: 'family', deleteEvent: 'family', setSharedColor: 'family',
  saveSharedEvent: 'family', deleteSharedEvent: 'family', syncShared: 'family', setWeatherPlace: 'family', inviteMember: 'family',
  setWhere: 'family', savePlaces: 'family',
  listOp: 'lists', boardOp: 'board', saveConfig: 'meals', saveMeal: 'meals', removeMeal: 'meals', importMeals: 'meals', saveRecipe: 'rec', deleteRecipe: 'rec' };
const REV = { seen: null, mine: {} };
function bump_(area) {
  const v = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  REV.mine[area] = v;
  return tabs_().then(() => g(S + '/values/' + enc('Rev!' + colL(HEAD.Rev.indexOf(area) + 1) + '2') + '?valueInputOption=RAW', { method: 'PUT', json: { values: [[v]] } })).catch(() => {});
}
async function revChanges() { // which parts someone else changed since the last call (the first call only takes a reading)
  await tabs_();
  const row = ((await g(S + '/values/' + enc('Rev!A2:' + colL(HEAD.Rev.length) + '2') + '?valueRenderOption=FORMATTED_VALUE')).values || [[]])[0] || [];
  const now = Object.fromEntries(HEAD.Rev.map((k, i) => [k, row[i] == null ? '' : String(row[i])])), was = REV.seen;
  REV.seen = now;
  // shortcut: if someone else saves the same part and then this phone saves it again before the next check, their change waits for the next re-read
  return was ? HEAD.Rev.filter(k => now[k] !== was[k] && now[k] !== REV.mine[k]) : [];
}
async function saveNav(order) {
  const ok = ['cal', 'board', 'meals', 'lists', 'rec'], o = (Array.isArray(order) ? order : []).filter((x, i, a) => ok.indexOf(x) >= 0 && a.indexOf(x) === i);
  if (o.length !== ok.length) throw new Error('Unknown menu order.');
  await cfgSet_('nav:' + me_(), o.join(',')); return true;
}

// ---------- where everyone is ----------
// Only a label ever leaves the phone ("Home", "Dane's Parents", "Out"); coordinates of named places are stored, a person's position never is.
async function setWhere(label) {
  const l = String(label || '').trim().slice(0, 40);
  await cfgSet_('where:' + me_(), l ? JSON.stringify({ label: l, at: new Date().toISOString() }) : '');
  return true;
}
async function savePlaces(list) {
  const out = (Array.isArray(list) ? list : []).slice(0, 30).map(p => ({ label: String(p.label || '').trim().slice(0, 40), addr: String(p.addr || '').trim().slice(0, 120), lat: +p.lat, lon: +p.lon }))
    .filter(p => p.label && isFinite(p.lat) && isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
  await cfgSet_('places', JSON.stringify(out)); return out;
}

// ---------- the list of everything the page may ask for ----------
const API = { getSources, saveSources, getFamily, getHousehold, savePrefs, saveProfile, googleProfile, syncMe, getRecipes, saveRecipe, deleteRecipe,
  saveEvent, deleteEvent, setSharedColor, saveSharedEvent, deleteSharedEvent, syncShared, searchPlaces, setWeatherPlace, getForecast, getInvite, inviteMember,
  getLists, listOp, getBoard, boardOp, getMeals, saveConfig, saveMeal, removeMeal, importMeals, revChanges, saveNav, setWhere, savePlaces };
window.AUTH = AUTH;
window.SRV = { call(fn, args) {
  const f = API[fn];
  if (!f) return Promise.reject(new Error(fn + ' is not available in this version of Scout.'));
  let p; try { p = Promise.resolve(f.apply(null, args)); } catch (e) { return Promise.reject(e); }
  return AREA[fn] ? p.then(v => { if (!(v && v.unchanged)) bump_(AREA[fn]); return v; }) : p; // a sync that found nothing new tells nobody
} };
})();
