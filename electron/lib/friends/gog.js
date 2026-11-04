// GOG-Freundesliste
//
// Anmeldung einmal über GOGs echte Login-Seite (wie in GOG Galaxy). Danach:
//   Freunde: chat.gog.com/users/<id>/friends          (Name + Avatar)
//   Status:  presence.gog.com/statuses?user_id=a,b,…  (wer online ist – nur lesen, du selbst
//            erscheinst dadurch NICHT online)
// Schnittstellen inoffiziell (dokumentiert in gogapidocs), Kennung von GOG Galaxy.
const { t } = require('../i18n.js');
const { createStore, saveSecret, loadSecret, loginWindow, clearPartition, getJson } = require('./common');

const CLIENT = { id: '46899977096215655', secret: '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9' };
const REDIRECT = 'https://embed.gog.com/on_login_success?origin=client';
const PARTITION = 'persist:friends-gog';
const SECRET = 'friendsGog';

const store = createStore({ needsLogin: true });
let auth = null; // { access_token, refresh_token, user_id, expires_at }
let friends = [];
let timer = null;
let fast = false;
let gen = 0;

async function token(params) {
  const qs = new URLSearchParams({ client_id: CLIENT.id, client_secret: CLIENT.secret, ...params });
  const j = await getJson(`https://auth.gog.com/token?${qs}`);
  if (!j.access_token) throw new Error(t("GOG-Anmeldung fehlgeschlagen"));
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    user_id: String(j.user_id),
    expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000
  };
}

let renewing = null;
function ensureToken() {
  if (auth && auth.expires_at - 60000 > Date.now()) return Promise.resolve(auth);
  // Gleichzeitige Aufrufe teilen sich eine Erneuerung (ein Refresh-Token gilt nur einmal)
  renewing ||= renew().finally(() => { renewing = null; });
  return renewing;
}

async function renew() {
  if (!auth?.refresh_token) throw new Error(t("Nicht angemeldet"));
  // Hat eine andere Ludora-Instanz/ein anderes Gerät inzwischen erneuert? Dann deren Token nehmen
  const disk = loadSecret(SECRET);
  if (disk?.refresh_token && disk.user_id === auth.user_id) auth.refresh_token = disk.refresh_token;
  auth = await token({ grant_type: 'refresh_token', refresh_token: auth.refresh_token });
  saveSecret(SECRET, { refresh_token: auth.refresh_token, user_id: auth.user_id });
  return auth;
}

async function login(parent) {
  const url = `https://auth.gog.com/auth?client_id=${CLIENT.id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&layout=client2`;
  const code = await loginWindow({
    title: t("Bei GOG anmelden"),
    url,
    partition: PARTITION,
    parent,
    check: (u) => (/^https:\/\/embed\.gog\.com\/on_login_success/.test(u) ? new URL(u).searchParams.get('code') : null)
  });
  if (!code) return { ok: false, error: t("Anmeldung abgebrochen") };
  try {
    auth = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
    saveSecret(SECRET, { refresh_token: auth.refresh_token, user_id: auth.user_id });
    start();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function logout() {
  gen++;
  clearTimeout(timer);
  auth = null;
  friends = [];
  saveSecret(SECRET, null);
  await clearPartition(PARTITION);
  store.set({ status: 'disconnected', needsLogin: true, friends: [], error: null });
}

/** Freunde + Online-Liste -> einheitliches Format (für Tests getrennt) */
// presence.gog.com liefert pro Nutzer einen Eintrag; ob online, steht (je nach Version) in presence/status/state
const OFFLINE = /^(offline|invisible|unavailable)$/i;
function isOnline(x) {
  const v = x.presence ?? x.status ?? x.state ?? x.online;
  if (v === undefined || v === null) return true; // nur online Nutzer gelistet
  if (typeof v === 'boolean') return v;
  if (typeof v === 'object') return !OFFLINE.test(String(v.status || v.presence || v.state || 'online'));
  return !OFFLINE.test(String(v));
}
function merge(items, online) {
  const on = new Set((online || []).filter(isOnline).map((x) => String(x.user_id ?? x.userId ?? x.id)));
  return (items || []).map((f) => ({
    id: String(f.user_id),
    name: f.username || String(f.user_id),
    avatar: f.images?.medium_2x || f.images?.medium || null,
    state: on.has(String(f.user_id)) ? 'online' : 'offline',
    gameName: null,
    richText: null,
    lastOnline: null
  }));
}

async function poll(loadList = false) {
  const my = gen;
  clearTimeout(timer);
  try {
    const a = await ensureToken();
    const h = { authorization: `Bearer ${a.access_token}` };
    // Freundesliste selbst alle 10 Minuten neu (neue Freunde), Status bei jedem Durchlauf
    if (loadList || !friends.length || Date.now() - (poll.listAt || 0) > 600000) {
      poll.listAt = Date.now();
      friends = (await getJson(`https://chat.gog.com/users/${a.user_id}/friends`, { headers: h })).items || [];
    }
    let online = [];
    for (let i = 0; i < friends.length; i += 100) {
      const ids = friends.slice(i, i + 100).map((f) => f.user_id).join(',');
      const r = await getJson(`https://presence.gog.com/statuses?user_id=${ids}`, { headers: h }).catch(() => ({ items: [] }));
      online = online.concat(r.items || []);
    }
    if (my !== gen) return;
    poll.vaultAsked = false;
    store.set({ status: 'connected', needsLogin: false, error: null, friends: merge(friends, online) });
  } catch (err) {
    if (my !== gen) return;
    if (err.status === 400 || err.status === 401 || /Nicht angemeldet/.test(err.message)) {
      store.set({ status: 'disconnected', needsLogin: true, error: t("GOG-Anmeldung abgelaufen – bitte neu anmelden.") });
      // Vielleicht hat ein anderes Gerät die Anmeldung erneuert -> über das Ludora-Konto holen
      if (!poll.vaultAsked) { poll.vaultAsked = true; require('../vault').sync().catch(() => { /* egal */ }); }
      return;
    }
    store.set({ status: 'error', error: `GOG: ${err.message}` });
  } finally {
    if (my === gen && auth) timer = setTimeout(() => poll(false), fast ? 5000 : 15000);
  }
}

function start() {
  gen++;
  store.set({ status: 'connecting', needsLogin: false, error: null });
  poll(true);
}

/** Anmeldung kam über das Ludora-Konto von einem anderen Gerät */
function restore() {
  const saved = loadSecret(SECRET);
  if (!saved?.refresh_token || saved.refresh_token === auth?.refresh_token) return;
  auth = { refresh_token: saved.refresh_token, user_id: saved.user_id, expires_at: 0 };
  start();
}

function init() {
  const saved = loadSecret(SECRET);
  if (saved?.refresh_token) {
    auth = { refresh_token: saved.refresh_token, user_id: saved.user_id, expires_at: 0 };
    start();
  }
}

module.exports = {
  id: 'gog',
  restore,
  async getLinkProof() { if (!auth) return null; const a = await ensureToken(); return { token: a.access_token, accountId: a.user_id }; },
  name: 'GOG',
  getState: store.get,
  onChange: store.on,
  init,
  login,
  logout,
  refresh: () => poll(true),
  setFast(on) { fast = !!on; if (on && auth) poll(false); },
  _merge: merge
};
