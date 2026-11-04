// Epic-Freundesliste
//
// Anmeldung einmal über Epics echte Login-Seite (eigenes Fenster). Danach:
//   Freunde:  friends-public-service-prod.ol.epicgames.com/friends/api/v1/<konto>/summary
//   Namen:    account-public-service-prod.ol.epicgames.com/account/api/public/account?accountId=...
//   Status:   Epics Chat-Verbindung (XMPP über WebSocket, wie im Epic-Launcher)
// Den Status der Freunde schickt Epic nur, wenn man selbst einen Status sendet – Ludora meldet
// sich dort als "Abwesend". Alle Schnittstellen sind inoffiziell (wie bei Legendary/Heroic/fnbr).
const { t } = require('../i18n.js');
const crypto = require('crypto');
const { createStore, saveSecret, loadSecret, loginWindow, clearPartition, getJson, unescapeXml, escapeXml } = require('./common');

// Öffentliche Kennung des Epic-Launchers (so nutzen sie auch Legendary/Heroic)
const CLIENT = { id: '34a02cf8f4414e29b15921876da36f9a', secret: 'daafbccc737745039dffe53d94fc76cf' };
const OAUTH = 'https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token';
const FRIENDS = 'https://friends-public-service-prod.ol.epicgames.com/friends/api/v1';
const ACCOUNTS = 'https://account-public-service-prod.ol.epicgames.com/account/api/public/account';
const XMPP_URL = 'wss://xmpp-service-prod.ol.epicgames.com//';
const XMPP_DOMAIN = 'prod.ol.epicgames.com';
const PARTITION = 'persist:friends-epic';
const SECRET = 'friendsEpic';

const store = createStore({ needsLogin: true });
let auth = null;          // { access_token, refresh_token, account_id, expires_at }
let friendIds = [];
const names = new Map();  // accountId -> Anzeigename
const presence = new Map(); // accountId -> Map(resource -> { show, status })
let ws = null;
let pollTimer = null;
let pingTimer = null;
let gen = 0;

// ---------- Anmeldung ----------

async function token(params) {
  const body = new URLSearchParams({ ...params, token_type: 'eg1' });
  const res = await fetch(OAUTH, {
    method: 'POST',
    headers: {
      authorization: 'basic ' + Buffer.from(`${CLIENT.id}:${CLIENT.secret}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(j.errorMessage || t("Epic-Anmeldung fehlgeschlagen ({0})", [res.status]));
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    account_id: j.account_id,
    display_name: j.displayName,
    expires_at: Date.now() + (Number(j.expires_in) || 7200) * 1000
  };
}

async function ensureToken() {
  if (auth && auth.expires_at - 60000 > Date.now()) return auth;
  if (!auth?.refresh_token) throw new Error(t("Nicht angemeldet"));
  auth = await token({ grant_type: 'refresh_token', refresh_token: auth.refresh_token });
  saveSecret(SECRET, { refresh_token: auth.refresh_token, account_id: auth.account_id });
  return auth;
}

async function login(parent) {
  const redirect = `https://www.epicgames.com/id/api/redirect?clientId=${CLIENT.id}&responseType=code`;
  const url = `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent(redirect)}`;
  const code = await loginWindow({
    title: t("Bei Epic Games anmelden"),
    url,
    partition: PARTITION,
    parent,
    async check(u, wc) {
      if (!/\/id\/api\/redirect/.test(u)) return null;
      // Die Seite zeigt JSON mit "authorizationCode"
      const text = await wc.executeJavaScript('document.body && document.body.innerText', true);
      const j = JSON.parse(text || '{}');
      return j.authorizationCode || null;
    }
  });
  if (!code) return { ok: false, error: t("Anmeldung abgebrochen") };
  try {
    auth = await token({ grant_type: 'authorization_code', code });
    saveSecret(SECRET, { refresh_token: auth.refresh_token, account_id: auth.account_id });
    start();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function logout() {
  gen++;
  stopXmpp();
  clearTimeout(pollTimer);
  auth = null;
  saveSecret(SECRET, null);
  await clearPartition(PARTITION);
  presence.clear();
  store.set({ status: 'disconnected', needsLogin: true, friends: [], error: null });
}

// ---------- Freunde + Namen ----------

async function loadFriends() {
  const a = await ensureToken();
  const h = { authorization: `bearer ${a.access_token}` };
  const sum = await getJson(`${FRIENDS}/${a.account_id}/summary`, { headers: h });
  friendIds = (sum.friends || []).map((f) => {
    if (f.alias) names.set(f.accountId, f.alias);
    return f.accountId;
  });
  const missing = friendIds.filter((id) => !names.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    const qs = missing.slice(i, i + 100).map((id) => `accountId=${encodeURIComponent(id)}`).join('&');
    const list = await getJson(`${ACCOUNTS}?${qs}`, { headers: h }).catch(() => []);
    for (const acc of list || []) {
      const ext = Object.values(acc.externalAuths || {}).find((x) => x?.externalDisplayName);
      names.set(acc.id, acc.displayName || ext?.externalDisplayName || acc.id);
    }
  }
}

/** Status-Text aus Epics Presence-JSON lesen */
function parseStatus(raw) {
  try { return JSON.parse(unescapeXml(raw)); } catch { return { Status: unescapeXml(raw) }; }
}

/** Bester Status eines Freundes über alle Geräte/Apps (Spiel > online > abwesend) */
function bestPresence(id) {
  const res = presence.get(id);
  if (!res || !res.size) return null;
  let best = null;
  for (const [resource, p] of res) {
    const app = resource.split(':')[1] || '';
    const score = (p.status?.bIsPlaying ? 4 : 0) + (p.show ? 1 : 2) + (/launcher/i.test(app) ? 0 : 1);
    if (!best || score > best.score) best = { ...p, app, score };
  }
  return best;
}

const APP_NAMES = { Fortnite: 'Fortnite', launcher: null, RocketLeague: 'Rocket League', FallGuys: 'Fall Guys' };
const SHOW = { away: 'away', xa: 'away', dnd: 'busy', chat: 'online' };

function buildList() {
  return friendIds.map((id) => {
    const p = bestPresence(id);
    const appName = p ? (p.app in APP_NAMES ? APP_NAMES[p.app] : p.app) : null;
    return {
      id,
      name: names.get(id) || id,
      avatar: null,
      state: p ? (SHOW[p.show] || 'online') : 'offline',
      gameName: p && (p.status?.bIsPlaying || (appName && !/launcher/i.test(p.app))) ? appName || null : null,
      richText: p?.status?.Status || null,
      lastOnline: null
    };
  });
}

function publish() {
  store.set({ status: 'connected', needsLogin: false, error: null, friends: buildList() });
}

// ---------- XMPP (Status live) ----------

function stopXmpp() {
  clearInterval(pingTimer);
  if (ws) { try { ws.close(); } catch { /* egal */ } }
  ws = null;
}

/** <presence …/> und <presence …>…</presence> aus einer Nachricht lösen (Kind-Elemente wie <delay/> beachten) */
function splitPresences(msg) {
  const out = [];
  const re = /<presence\b[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(msg))) {
    if (m[1] === '/') { out.push(m[0]); continue; }
    const end = msg.indexOf('</presence>', re.lastIndex);
    if (end < 0) { out.push(m[0]); continue; }
    out.push(msg.slice(m.index, end + 11));
    re.lastIndex = end + 11;
  }
  return out;
}

/** Eine Presence-Nachricht auswerten (für Tests getrennt) */
function handlePresence(xml) {
  const head = xml.match(/^<presence\b[^>]*>/)?.[0] || xml;
  const from = head.match(/from=["']([^"']+)["']/)?.[1];
  if (!from) return false;
  const [bare, resource = ''] = from.split('/');
  const id = bare.split('@')[0];
  if (!id || id === auth?.account_id) return false;
  const type = head.match(/type=["']([^"']+)["']/)?.[1];
  const map = presence.get(id) || new Map();
  if (type === 'unavailable') map.delete(resource);
  else {
    const show = xml.match(/<show>([^<]*)<\/show>/)?.[1] || null;
    const status = xml.match(/<status>([\s\S]*?)<\/status>/)?.[1];
    map.set(resource, { show, status: status ? parseStatus(status) : null });
  }
  presence.set(id, map);
  return true;
}

function startXmpp(my) {
  stopXmpp();
  if (typeof WebSocket === 'undefined') return;
  const a = auth;
  const sock = new WebSocket(XMPP_URL, 'xmpp');
  ws = sock;
  let step = 'open';
  const send = (s) => { try { sock.send(s); } catch { /* egal */ } };
  const open = () => send(`<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="${XMPP_DOMAIN}" version="1.0"/>`);
  let publishTimer = null;
  const schedulePublish = () => { clearTimeout(publishTimer); publishTimer = setTimeout(publish, 300); };

  sock.addEventListener('open', open);
  sock.addEventListener('message', (ev) => {
    if (my !== gen || ws !== sock) return;
    const msg = String(ev.data);
    if (step === 'open' && /<mechanisms/.test(msg)) {
      const plain = Buffer.from(`\u0000${a.account_id}\u0000${a.access_token}`).toString('base64');
      send(`<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="PLAIN">${plain}</auth>`);
      step = 'auth';
    } else if (step === 'auth' && /<success/.test(msg)) {
      step = 'bind';
      open();
    } else if (step === 'auth' && /<failure/.test(msg)) {
      store.set({ error: t("Epic-Chat: Anmeldung abgelehnt – Status nicht verfügbar.") });
      stopXmpp();
    } else if (step === 'bind' && /<bind/.test(msg) && !/<jid>/.test(msg)) {
      const resource = `V2:launcher:WIN::Ludora${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
      send(`<iq type="set" id="bind1"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>${escapeXml(resource)}</resource></bind></iq>`);
    } else if (step === 'bind' && /<jid>/.test(msg)) {
      step = 'ready';
      send('<iq type="set" id="sess1"><session xmlns="urn:ietf:params:xml:ns:xmpp-session"/></iq>');
      // Eigener Status "Abwesend" – nötig, damit Epic die Status der Freunde schickt
      const status = escapeXml(JSON.stringify({ Status: '', bIsPlaying: false, bIsJoinable: false, bHasVoiceSupport: false, SessionId: '', Properties: {} }));
      send(`<presence><show>away</show><status>${status}</status></presence>`);
      pingTimer = setInterval(() => { send(`<iq type="get" id="ping${Date.now()}"><ping xmlns="urn:xmpp:ping"/></iq>`); publish(); }, 45000);
    } else if (step === 'ready') {
      // Ping vom Server beantworten – sonst trennt Epic nach ein paar Minuten und Status bleiben stehen
      for (const ping of msg.match(/<iq[^>]*type=["']get["'][^>]*>\s*<ping[^>]*\/>\s*<\/iq>/g) || []) {
        const id = ping.match(/id=["']([^"']+)["']/)?.[1];
        const from = ping.match(/from=["']([^"']+)["']/)?.[1];
        send(`<iq type="result"${id ? ` id="${escapeXml(id)}"` : ''}${from ? ` to="${escapeXml(from)}"` : ''}/>`);
      }
      // Eine Nachricht kann mehrere <presence> enthalten
      let changed = false;
      for (const m of splitPresences(msg)) changed = handlePresence(m) || changed;
      if (changed) schedulePublish();
    }
  });
  const reconnect = () => {
    if (my !== gen || ws !== sock) return;
    ws = null;
    clearInterval(pingTimer);
    presence.clear(); // nach dem Neuverbinden schickt Epic die aktuellen Status neu
    schedulePublish();
    setTimeout(() => { if (my === gen && auth) ensureToken().then(() => startXmpp(my)).catch(() => {}); }, 5000);
  };
  sock.addEventListener('close', reconnect);
  sock.addEventListener('error', () => { try { sock.close(); } catch { /* egal */ } });
}

// ---------- Ablauf ----------

async function refresh() {
  const my = gen;
  try {
    await loadFriends();
    if (my !== gen) return;
    publish();
  } catch (err) {
    if (my !== gen) return;
    if (err.status === 401 || /Nicht angemeldet|invalid_grant|refresh/i.test(err.message)) {
      store.set({ status: 'disconnected', needsLogin: true, error: t("Epic-Anmeldung abgelaufen – bitte neu anmelden.") });
      return;
    }
    store.set({ status: 'error', error: `Epic: ${err.message}` });
  } finally {
    clearTimeout(pollTimer);
    // Freundesliste selbst ändert sich selten; der Status kommt live über XMPP
    if (my === gen && auth) pollTimer = setTimeout(refresh, 5 * 60 * 1000);
  }
}

function start() {
  const my = ++gen;
  store.set({ status: 'connecting', needsLogin: false, error: null });
  ensureToken()
    .then(() => { refresh(); startXmpp(my); })
    .catch(() => store.set({ status: 'disconnected', needsLogin: true, error: t("Epic-Anmeldung abgelaufen – bitte neu anmelden.") }));
}

function init() {
  const saved = loadSecret(SECRET);
  if (saved?.refresh_token) {
    auth = { refresh_token: saved.refresh_token, account_id: saved.account_id, expires_at: 0 };
    start();
  }
}

module.exports = {
  _splitPresences: splitPresences,
  id: 'epic',
  async getLinkProof() { if (!auth) return null; const a = await ensureToken(); return { token: a.access_token, accountId: a.account_id }; },
  name: 'Epic Games',
  getState: store.get,
  onChange: store.on,
  init,
  login,
  logout,
  refresh,
  setFast() { /* Status kommt ohnehin live */ },
  _handlePresence: handlePresence,
  _buildList: buildList,
  _test: { presence, names, setFriends: (ids) => { friendIds = ids; }, setAuth: (a) => { auth = a; } }
};
