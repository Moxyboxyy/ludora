// Steam-Freundesliste – über Steams Web-Schnittstelle, NICHT als zweiter Steam-Client.
//
// Früher hat sich Ludora als zusätzlicher Steam-Client angemeldet. Steam schickt so einer
// Sitzung aber keinen Online-Status der Freunde (dafür müsste sie selbst "online" gehen und
// würde damit deinen Status ändern), und der echte Steam-Client kam durcheinander.
//
// Jetzt: Anmeldung per QR-Code (Steam-App) als *Web*-Sitzung – genau wie wenn du dich im
// Browser im Steam-Shop anmeldest. Darüber läuft eine Web-Chat-Verbindung (wie steamcommunity.com/chat),
// die deinen aktuellen Status übernimmt und dafür jede Statusänderung der Freunde live bekommt.
// Fällt sie aus, fragt Ludora ersatzweise über api.steampowered.com ab (langsamer, verzögert):
//   IFriendsListService/GetFriendsList     – wer ist befreundet
//   IPlayerService/GetPlayerLinkDetails    – Online-Status, Spiel, Lobby, Avatar
//   IFriendMessagesService/*               – Chat (Verlauf, senden, gelesen, ungelesen)
// Dein Steam-Client und dein Online-Status bleiben komplett unberührt.
// Das Anmelde-Token wird verschlüsselt gespeichert (safeStorage), nie im Klartext.
const { t } = require('./i18n.js');
const settings = require('./settings');

const electron = () => require('electron');
const API = 'https://api.steampowered.com';
const STEAMID_BASE = 76561197960265728n;

let session = null;      // steam-session LoginSession (für Token-Erneuerung)
let qrSession = null;
let refreshToken = null;
let accessToken = null;
let accessExp = 0;       // Sekunden (JWT exp)
let gen = 0;             // erhöht sich bei jeder An-/Abmeldung – alte Vorgänge werden ignoriert

let state = { status: 'disconnected', error: null, qr: null, me: null, friends: [] };
const listeners = new Set();
const chatListeners = new Set();
const unread = new Map();     // steamid -> ungelesene Nachrichten
const lastMsg = new Map();    // steamid -> Zeitpunkt (s) der letzten bekannten Nachricht
const watched = new Map();    // steamid -> Anzahl offener Chatfenster
const gameNames = new Map();  // appid -> Name
let pollTimer = null;
let chatTimer = null;
let fastPoll = false;

function emit(patch) {
  state = { ...state, ...patch, ...(patch.friends ? { updatedAt: Date.now() } : {}) };
  for (const l of listeners) { try { l(state); } catch { /* egal */ } }
}
function emitChat(ev) {
  for (const l of chatListeners) { try { l(ev); } catch { /* egal */ } }
}
function onChat(fn) { chatListeners.add(fn); return () => chatListeners.delete(fn); }
function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ---------- Token speichern (verschlüsselt) ----------

const TOKEN_KEY = 'steamWebToken'; // neu: Web-Token (das alte Client-Token wird verworfen)

function loadToken() {
  const enc = settings.get(TOKEN_KEY);
  if (!enc) return null;
  try {
    const { safeStorage } = electron();
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : null;
  } catch { return null; }
}

function saveToken(token) {
  if (!token) { settings.set({ [TOKEN_KEY]: null }); return; }
  try {
    const { safeStorage } = electron();
    if (!safeStorage.isEncryptionAvailable()) return; // unverschlüsselt speichern wir nicht
    settings.set({ [TOKEN_KEY]: safeStorage.encryptString(token).toString('base64') });
  } catch { /* egal */ }
}

/** Inhalt eines JWT (ohne Prüfung – nur um SteamID und Ablauf zu lesen) */
function jwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return {}; }
}

// ---------- Anmeldung ----------

async function startQr() {
  const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
  const QRCode = require('qrcode');
  try { qrSession?.cancelLoginAttempt(); } catch { /* egal */ }
  const my = ++gen;
  const s = new LoginSession(EAuthTokenPlatformType.WebBrowser);
  qrSession = s;
  s.loginTimeout = 3 * 60 * 1000;
  const { qrChallengeUrl } = await s.startWithQR();
  const qr = await QRCode.toDataURL(qrChallengeUrl, { margin: 1, width: 260, color: { dark: '#0f1115', light: '#ffffff' } });
  s.on('remoteInteraction', () => { if (my === gen) emit({ status: 'qr-scanned' }); });
  s.on('authenticated', () => {
    if (my !== gen) return;
    qrSession = null;
    saveToken(s.refreshToken);
    emit({ qr: null });
    connect(s.refreshToken, s.accessToken);
  });
  s.on('timeout', () => { if (my === gen) emit({ status: 'disconnected', qr: null, error: t("QR-Code abgelaufen – bitte neu anfordern.") }); });
  s.on('error', (err) => { if (my === gen) emit({ status: 'disconnected', qr: null, error: err.message }); });
  emit({ status: 'qr', qr, error: null, friends: [], me: null });
  return state;
}

async function ensureAccess() {
  if (accessToken && accessExp - 300 > Date.now() / 1000) return accessToken;
  const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
  if (!session) session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
  session.refreshToken = refreshToken;
  // Holt ein frisches Zugriffs-Token und verlängert dabei, wenn Steam will, auch das Anmelde-Token
  let renewed = false;
  try { renewed = await session.renewRefreshToken(); } catch { await session.refreshAccessToken(); }
  if (renewed && session.refreshToken) { refreshToken = session.refreshToken; saveToken(refreshToken); }
  accessToken = session.accessToken;
  accessExp = Number(jwtPayload(accessToken).exp) || Date.now() / 1000 + 3600;
  return accessToken;
}

async function connect(token, firstAccess) {
  const my = ++gen;
  stopChat();
  refreshToken = token;
  session = null;
  accessToken = firstAccess || null;
  accessExp = firstAccess ? Number(jwtPayload(firstAccess).exp) || 0 : 0;
  const steamid = String(jwtPayload(token).sub || '');
  emit({ status: 'connecting', error: null, me: steamid ? { steamid } : null });
  try {
    await ensureAccess();
    if (my !== gen) return;
    emit({ status: 'connected', error: null, me: { steamid } });
    schedulePoll(100);
    ensureChat().catch(() => { /* klappt beim ersten Senden erneut; Liste läuft auch ohne */ });
  } catch (err) {
    if (my !== gen) return;
    if (/AccessDenied|Expired|Revoked|InvalidSignature|InvalidPassword|401/i.test(String(err.message))) saveToken(null);
    emit({ status: 'disconnected', error: t(
      "Steam-Anmeldung abgelaufen – bitte neu per QR-Code anmelden. ({0})",
      [err.message]
    ) });
  }
}

function logout() {
  gen++;
  stopPoll();
  stopChat();
  clearTimeout(chatTimer);
  try { qrSession?.cancelLoginAttempt(); } catch { /* egal */ }
  qrSession = null;
  session = null;
  refreshToken = null;
  accessToken = null;
  saveToken(null);
  unread.clear();
  lastMsg.clear();
  emit({ status: 'disconnected', me: null, friends: [], qr: null, error: null });
}

// ---------- Web-API ----------

async function call(iface, method, params = {}, { post = false } = {}) {
  const token = await ensureAccess();
  const qs = new URLSearchParams();
  qs.set('access_token', token);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x, i) => qs.set(`${k}[${i}]`, String(x)));
    else if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const url = `${API}/${iface}/${method}/v1/`;
  const res = post
    ? await fetch(url, { method: 'POST', body: qs, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    : await fetch(`${url}?${qs}`);
  if (res.status === 401 || res.status === 403) { accessExp = 0; throw new Error(t("Steam lehnt die Anfrage ab ({0})", [res.status])); }
  if (!res.ok) throw new Error(t("Steam antwortet mit {0}", [res.status]));
  const eresult = Number(res.headers.get('x-eresult') || 1);
  if (eresult !== 1) throw new Error(t("Steam-Fehler {0}", [eresult]));
  const data = await res.json().catch(() => ({}));
  return data.response || {};
}

const toSteamId = (accountid) => String(STEAMID_BASE + BigInt(accountid));
const toAccountId = (steamid) => String(BigInt(steamid) - STEAMID_BASE);

function avatarUrl(digest) {
  if (!digest) return null;
  const hex = /^[0-9a-f]{40}$/i.test(digest) ? digest : Buffer.from(digest, 'base64').toString('hex');
  if (!hex || /^0+$/.test(hex)) return 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg';
  return `https://avatars.steamstatic.com/${hex}_medium.jpg`;
}

async function resolveGameNames(appids) {
  const missing = [...new Set(appids)].filter((id) => id && !gameNames.has(id));
  if (!missing.length) return;
  try {
    const input = { ids: missing.map((a) => ({ appid: Number(a) })), context: { language: 'german', country_code: 'DE', steam_realm: 1 } };
    const r = await fetch(`${API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`);
    const data = await r.json();
    for (const it of data?.response?.store_items || []) if (it.appid && it.name) gameNames.set(String(it.appid), it.name);
  } catch { /* Name bleibt leer */ }
}

// ---------- Freunde abfragen ----------

const STATE_NAMES = { 0: 'offline', 1: 'online', 2: 'busy', 3: 'away', 4: 'snooze', 5: 'online', 6: 'online', 7: 'offline' };

let lastChatTry = 0;
function stopPoll() { clearTimeout(pollTimer); pollTimer = null; }
function schedulePoll(ms) { stopPoll(); pollTimer = setTimeout(poll, ms); }

async function loadFriendIds() {
  const r = await call('IFriendsListService', 'GetFriendsList');
  const list = r.friendslist?.friends || [];
  return list.filter((f) => Number(f.efriendrelationship) === 3).map((f) => String(f.ulfriendid));
}

async function loadDetails(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = await call('IPlayerService', 'GetPlayerLinkDetails', { steamids: chunk });
    for (const a of r.accounts || []) {
      const pub = a.public_data || {};
      const priv = a.private_data || {};
      if (pub.steamid) out.set(String(pub.steamid), { pub, priv });
    }
  }
  return out;
}

async function poll() {
  const my = gen;
  if (state.status !== 'connected') return;
  try {
    // Live-Sitzung vorhanden? Dann kommt der Status von dort (sofort bei jeder Änderung) –
    // hier nur noch ungelesene Nachrichten abgleichen.
    if (friendsFromChat(chatUser)) {
      await checkMessages(my);
      scheduleLive(0);
      return;
    }
    // Keine Live-Verbindung (z. B. beim Start fehlgeschlagen)? Alle 2 Minuten neu versuchen –
    // bis dahin kommt der Status über die Web-API.
    if (!chatUser && !chatReady && Date.now() - lastChatTry > 120000) {
      lastChatTry = Date.now();
      ensureChat().then(() => scheduleLive(1500)).catch(() => {});
    }
    const ids = await loadFriendIds();
    const details = ids.length ? await loadDetails(ids) : new Map();
    if (my !== gen) return;

    const appids = [];
    const friends = ids.map((id) => {
      const { pub = {}, priv = {} } = details.get(id) || {};
      const gameId = priv.game_id && String(priv.game_id) !== '0' ? String(priv.game_id) : null;
      // game_id: bei Steam-Spielen die AppID, bei Nicht-Steam-Spielen eine große Zahl (+ game_extra_info)
      const appid = gameId && BigInt(gameId) < 0x1000000n ? gameId : null;
      if (appid) appids.push(appid);
      const rp = Array.isArray(priv.rich_presence_kv) ? priv.rich_presence_kv
        : priv.rich_presence_kv && typeof priv.rich_presence_kv === 'object'
          ? Object.entries(priv.rich_presence_kv).map(([key, value]) => ({ key, value })) : [];
      const connectStr = rp.find((x) => x.key === 'connect')?.value || null;
      const lobby = priv.lobby_steam_id && String(priv.lobby_steam_id) !== '0' ? String(priv.lobby_steam_id) : null;
      const lastOff = Number(priv.last_seen_online || priv.last_logoff_time) || 0;
      return {
        steamid: id,
        name: pub.persona_name || id,
        avatar: avatarUrl(pub.sha_digest_avatar),
        state: STATE_NAMES[Number(priv.persona_state) || 0] || 'offline',
        appid: appid || (gameId ? gameId : null),
        gameName: priv.game_extra_info || null,
        richText: rp.find((x) => x.key === 'status')?.value || null,
        lobby,
        joinable: !!(gameId && (lobby || connectStr || (priv.game_server_ip_and_port && Number(priv.game_server_ip_and_port)))),
        lastOnline: lastOff ? lastOff * 1000 : null
      };
    });

    await resolveGameNames(appids);
    for (const f of friends) if (!f.gameName && f.appid) f.gameName = gameNames.get(f.appid) || null;

    await checkMessages(my);
    for (const f of friends) f.unread = unread.get(f.steamid) || 0;
    if (my !== gen) return;
    emit({ friends, error: null });
  } catch (err) {
    if (my === gen) emit({ error: t("Freunde konnten nicht geladen werden: {0}", [err.message]) });
  } finally {
    if (my === gen && state.status === 'connected') schedulePoll(fastPoll ? 5000 : 15000);
  }
}

// ---------- Nachrichten ----------

/** Ungelesene Nachrichten abgleichen und neue Nachrichten als Ereignis melden */
async function checkMessages(my = gen) {
  let r;
  try { r = await call('IFriendMessagesService', 'GetActiveMessageSessions', { only_sessions_with_messages: true }); } catch { return; }
  if (my !== gen) return;
  const first = lastMsg.size === 0 && !checkMessages.done;
  checkMessages.done = true;
  for (const s of r.message_sessions || []) {
    const id = toSteamId(s.accountid_friend);
    const last = Number(s.last_message) || 0;
    const n = Number(s.unread_message_count) || 0;
    if (n) unread.set(id, n); else unread.delete(id);
    const known = lastMsg.get(id) || 0;
    lastMsg.set(id, Math.max(known, last));
    // Neue Nachricht seit dem letzten Abgleich -> holen und melden (Benachrichtigung, offener Chat)
    if (!first && last > known && (n > 0 || watched.has(id))) {
      try {
        for (const m of await recent(id, 10)) if (m.ts / 1000 > known) emitChat({ type: 'message', steamid: id, ...m });
      } catch { /* nächster Durchlauf */ }
    }
  }
}

async function recent(steamid, count = 60) {
  const me = state.me?.steamid;
  const r = await call('IFriendMessagesService', 'GetRecentMessages', {
    steamid1: me, steamid2: steamid, count, most_recent_conversation: false, bbcode_format: false
  });
  const myAcc = me ? toAccountId(me) : null;
  return (r.messages || []).map((m) => ({
    fromMe: String(m.accountid) === myAcc,
    text: m.message || '',
    ts: (Number(m.timestamp) || 0) * 1000,
    ordinal: Number(m.ordinal) || 0
  })).sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
}

function scheduleChatPoll() {
  clearTimeout(chatTimer);
  if (!watched.size || state.status !== 'connected') return;
  chatTimer = setTimeout(async () => { await checkMessages(); scheduleChatPoll(); }, 4000);
}

/** Chatfenster offen/geschlossen – solange einer offen ist, wird alle 4 s nach Nachrichten geschaut */
function watch(steamid, on) {
  const n = (watched.get(steamid) || 0) + (on ? 1 : -1);
  if (n > 0) watched.set(steamid, n); else watched.delete(steamid);
  scheduleChatPoll();
}

function setFast(on) {
  fastPoll = !!on;
  if (on && state.status === 'connected') schedulePoll(200);
}

/** Beim App-Start: gespeichertes Token nutzen */
function init() {
  settings.set({ steamFriendsToken: null }); // altes Client-Token (zweite Steam-Sitzung) nicht mehr verwenden
  const token = loadToken();
  if (token) connect(token);
}

/** Steams eigener "Spiel beitreten"-Link – Steam kümmert sich um Lobby/Server */
function joinUrl(f) {
  return f?.appid ? `steam://friends/joingame/${f.steamid}` : null;
}

function applyUnread() {
  emit({ friends: state.friends.map((f) => ({ ...f, unread: unread.get(f.steamid) || 0 })) });
}

// ---------- Web-Chat-Verbindung (zum Senden) ----------
//
// Senden geht bei Steam nicht über die Web-API (404), sondern nur über eine Chat-Verbindung.
// Ludora nutzt dafür denselben Weg wie der Steam-Webchat im Browser (steamcommunity.com/chat):
// ein kurzlebiges Chat-Token aus der Web-Anmeldung -> Anmeldung als *Web*-Chat.
// So eine Sitzung verträgt sich mit dem Desktop-Client (wie Browser-Chat + Steam gleichzeitig).
// Ludora setzt keinen Online-Status – dein Status bleibt, wie Steam ihn setzt.

let chatUser = null;
let chatReady = null;   // Promise, solange die Verbindung aufgebaut wird
let chatRetry = null;

async function webCookieHeader() {
  const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
  const s = new LoginSession(EAuthTokenPlatformType.WebBrowser);
  s.refreshToken = refreshToken;
  const cookies = await s.getWebCookies();
  const jar = new Map();
  for (const c of cookies) {
    const [pair, ...attrs] = String(c).split(';');
    const domain = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a));
    if (domain && !/steamcommunity\.com/i.test(domain)) continue;
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  if (!jar.has('sessionid')) jar.set('sessionid', require('crypto').randomBytes(12).toString('hex'));
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function chatToken() {
  const res = await fetch('https://steamcommunity.com/chat/clientjstoken', { headers: { cookie: await webCookieHeader() } });
  const data = await res.json().catch(() => null);
  if (!data?.logged_in || !data.token) throw new Error(t("Steam-Chat-Anmeldung fehlgeschlagen"));
  return data;
}

function stopChat() {
  clearTimeout(chatRetry);
  clearTimeout(liveTimer);
  chatRetry = null;
  const u = chatUser;
  chatUser = null;
  chatReady = null;
  if (u) { try { u.removeAllListeners(); u.chat?.removeAllListeners?.(); u.logOff(); } catch { /* egal */ } }
}

/** Web-Chat-Verbindung herstellen (oder die bestehende nutzen) */
function ensureChat() {
  if (chatUser?.steamID && chatUser._chatOk) return Promise.resolve(chatUser);
  if (chatReady) return chatReady;
  const my = gen;
  chatReady = (async () => {
    const SteamUser = require('steam-user');
    const tok = await chatToken();
    if (my !== gen) throw new Error('abgemeldet');
    const u = new SteamUser({ autoRelogin: false, language: 'german' });
    chatUser = u;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t("Zeitüberschreitung beim Steam-Chat"))), 20000);
      u.once('loggedOn', () => { clearTimeout(timer); resolve(); });
      u.once('error', (err) => { clearTimeout(timer); reject(err); });
      u.logOn({ accountName: tok.account_name, webLogonToken: tok.token, steamID: tok.steamid });
    });
    u._chatOk = true;

    // Live-Status der Freunde: Steam schickt ihn nur Sitzungen mit eigenem Status.
    // Ludora übernimmt deshalb genau deinen aktuellen Status (nichts ändert sich für deine Freunde).
    u.on('friendsList', () => scheduleLive());
    u.on('user', (sid, persona) => {
      const id = sid.getSteamID64();
      if (id === u.steamID.getSteamID64()) {
        // Du hast im Steam-Client deinen Status geändert -> mitziehen
        const st = Number(persona?.persona_state);
        if (u._presence && Number.isFinite(st) && st !== 0 && st !== u._myState) { u._myState = st; try { u.setPersona(st); } catch { /* egal */ } }
        return;
      }
      scheduleLive();
    });
    mirrorPersona(u).then((ok) => { if (ok) scheduleLive(800); }).catch(() => {});

    // Live: eingehende Nachrichten, eigene von anderen Geräten, Tippen
    const toEv = (m, fromMe) => ({
      type: 'message',
      steamid: m.steamid_friend.getSteamID64(),
      fromMe,
      text: m.message_no_bbcode || m.message,
      ts: new Date(m.server_timestamp).getTime(),
      ordinal: m.ordinal || 0
    });
    const seen = (ev) => lastMsg.set(ev.steamid, Math.max(lastMsg.get(ev.steamid) || 0, Math.floor(ev.ts / 1000)));
    u.chat.on('friendMessage', (m) => {
      const ev = toEv(m, false);
      seen(ev);
      unread.set(ev.steamid, (unread.get(ev.steamid) || 0) + 1);
      emitChat(ev);
      applyUnread();
    });
    u.chat.on('friendMessageEcho', (m) => { const ev = toEv(m, true); seen(ev); emitChat(ev); });
    u.chat.on('friendTyping', (m) => emitChat({ type: 'typing', steamid: m.steamid_friend.getSteamID64() }));

    // Verbindung weg -> später neu (Chat-Token sind kurzlebig, darum jedes Mal ein neues)
    const lost = () => {
      if (chatUser !== u) return;
      u._chatOk = false;
      chatUser = null;
      chatReady = null;
      if (my === gen && state.status === 'connected') {
        clearTimeout(chatRetry);
        chatRetry = setTimeout(() => ensureChat().then(() => scheduleLive(1500)).catch(() => {}), 10000);
        schedulePoll(500); // bis dahin über die Web-API
      }
    };
    u.on('disconnected', lost);
    u.on('error', lost);
    return u;
  })().catch((err) => {
    chatReady = null;
    if (chatUser) { try { chatUser.removeAllListeners(); chatUser.logOff(); } catch { /* egal */ } chatUser = null; }
    throw err;
  });
  return chatReady;
}

/**
 * Deinen aktuellen Steam-Status übernehmen (Online, Abwesend, Unsichtbar, ...).
 * Bist du gerade gar nicht bei Steam (offline), geht Ludora "unsichtbar" –
 * so siehst du deine Freunde, ohne dass du für sie online wirkst.
 */
async function mirrorPersona(u) {
  const me = u.steamID.getSteamID64();
  let st;
  try {
    const { personas } = await u.getPersonas([me]);
    st = personas?.[me]?.persona_state;
  } catch { /* unbekannt */ }
  if (st === undefined || st === null) return false; // lieber nichts setzen
  st = Number(st);
  const target = st === 0 ? 7 : st; // 0 = offline -> 7 = unsichtbar
  u._myState = target;
  u.setPersona(target);
  u._presence = true;
  return true;
}

const REL_FRIEND = 3;
let liveTimer = null;

/** Freundesliste aus der Live-Sitzung (null, wenn noch keine Daten da sind) */
function friendsFromChat(u) {
  if (!u?._presence || !u.myFriends) return null;
  const ids = Object.keys(u.myFriends).filter((id) => Number(u.myFriends[id]) === REL_FRIEND);
  const users = u.users || {};
  const known = ids.filter((id) => users[id] && users[id].persona_state !== undefined);
  if (ids.length && known.length < ids.length * 0.5) return null; // Steam liefert noch nach
  return ids.map((id) => {
    const p = users[id] || {};
    const gameId = p.gameid && String(p.gameid) !== '0' ? String(p.gameid) : null;
    const appid = Number(p.game_played_app_id) ? String(p.game_played_app_id) : gameId;
    const rp = Array.isArray(p.rich_presence) ? p.rich_presence : [];
    const lobby = p.game_lobby_id && String(p.game_lobby_id) !== '0' ? String(p.game_lobby_id) : null;
    const connectStr = rp.find((x) => x.key === 'connect')?.value || null;
    return {
      steamid: id,
      name: p.player_name || id,
      avatar: p.avatar_url_medium || p.avatar_url_icon || null,
      state: STATE_NAMES[Number(p.persona_state) || 0] || 'offline',
      appid: appid || null,
      gameName: p.game_name || null,
      richText: p.rich_presence_string || rp.find((x) => x.key === 'status')?.value || null,
      lobby,
      joinable: !!(appid && (lobby || connectStr)),
      lastOnline: p.last_logoff ? new Date(p.last_logoff).getTime() : null
    };
  });
}

/** Änderung von Steam -> Liste kurz gebündelt neu aufbauen und anzeigen */
function scheduleLive(ms = 400) {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    const my = gen;
    const friends = friendsFromChat(chatUser);
    if (!friends || state.status !== 'connected') return;
    await resolveGameNames(friends.filter((f) => f.appid && !f.gameName).map((f) => f.appid));
    if (my !== gen) return;
    for (const f of friends) {
      if (!f.gameName && f.appid) f.gameName = gameNames.get(f.appid) || null;
      f.unread = unread.get(f.steamid) || 0;
    }
    emit({ friends, error: null, live: true });
  }, ms);
}

// ---------- Chat ----------

function requireConnected() {
  if (state.status !== 'connected') throw new Error(t("Nicht mit Steam verbunden"));
}

async function history(steamid, max = 60) {
  requireConnected();
  const msgs = await recent(steamid, max);
  const last = msgs.length ? Math.floor(msgs[msgs.length - 1].ts / 1000) : 0;
  lastMsg.set(steamid, Math.max(lastMsg.get(steamid) || 0, last));
  return msgs;
}

async function send(steamid, text) {
  requireConnected();
  const msg = String(text || '').slice(0, 4000);
  if (!msg.trim()) return null;
  let r;
  try {
    const u = await ensureChat();
    r = await u.chat.sendFriendMessage(steamid, msg);
  } catch (err) {
    throw new Error(t(
      "Senden fehlgeschlagen ({0}). Notfalls den Chat in Steam öffnen (Symbol oben rechts).",
      [err.message]
    ));
  }
  const ts = r?.server_timestamp ? new Date(r.server_timestamp).getTime() : Date.now();
  lastMsg.set(steamid, Math.max(lastMsg.get(steamid) || 0, Math.floor(ts / 1000)));
  const ev = { type: 'message', steamid, fromMe: true, text: msg, ts, ordinal: r?.ordinal || 0 };
  emitChat(ev);
  return ev;
}

function typing(steamid) {
  if (state.status !== 'connected') return;
  ensureChat().then((u) => u.chat.sendFriendTyping(steamid)).catch(() => {});
}

function markRead(steamid) {
  if (state.status === 'connected' && chatUser?._chatOk) {
    try { chatUser.chat.ackFriendMessage(steamid, new Date()); } catch { /* egal */ }
  }
  unread.delete(steamid);
  applyUnread();
}

function getState() { return state; }
function findFriend(id) { return state.friends.find((f) => f.steamid === id); }

/** Nachweis für die Ludora-Verknüpfung: frisches Web-Zugriffs-Token (Konto = "sub" im Token) */
async function getLinkProof() {
  if (state.status !== 'connected' || !refreshToken) return null;
  const token = await ensureAccess();
  const me = state.me?.steamid;
  const name = me && chatUser?.users?.[me]?.player_name;
  return { token, claim: name ? { name } : {}, accountId: me };
}

module.exports = {
  getLinkProof,
  init, startQr, logout, onChange, onChat, getState, setFast, joinUrl, findFriend,
  history, send, typing, markRead, watch,
  _test: { avatarUrl, jwtPayload, toSteamId, toAccountId }
};
