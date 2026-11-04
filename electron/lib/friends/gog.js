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

async function ensureToken() {
  if (auth && auth.expires_at - 60000 > Date.now()) return auth;
  if (!auth?.refresh_token) throw new Error(t("Nicht angemeldet"));
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
function merge(items, online) {
  const on = new Set((online || []).map((x) => String(x.user_id)));
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
    if (loadList || !friends.length) {
      friends = (await getJson(`https://chat.gog.com/users/${a.user_id}/friends`, { headers: h })).items || [];
    }
    let online = [];
    for (let i = 0; i < friends.length; i += 100) {
      const ids = friends.slice(i, i + 100).map((f) => f.user_id).join(',');
      const r = await getJson(`https://presence.gog.com/statuses?user_id=${ids}`, { headers: h }).catch(() => ({ items: [] }));
      online = online.concat(r.items || []);
    }
    if (my !== gen) return;
    store.set({ status: 'connected', needsLogin: false, error: null, friends: merge(friends, online) });
  } catch (err) {
    if (my !== gen) return;
    if (err.status === 401 || /Nicht angemeldet/.test(err.message)) {
      store.set({ status: 'disconnected', needsLogin: true, error: t("GOG-Anmeldung abgelaufen – bitte neu anmelden.") });
      return;
    }
    store.set({ status: 'error', error: `GOG: ${err.message}` });
  } finally {
    if (my === gen && auth) timer = setTimeout(() => poll(false), fast ? 10000 : 30000);
  }
}

function start() {
  gen++;
  store.set({ status: 'connecting', needsLogin: false, error: null });
  poll(true);
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
