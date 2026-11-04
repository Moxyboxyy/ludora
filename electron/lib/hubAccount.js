// Ludora-Konto (Server: Supabase)
//
// - Registrieren/Anmelden mit Name + Passwort. Supabase braucht intern eine E-Mail-Adresse;
//   Ludora nimmt dafür "<name>@gamehub.local" (es werden nie E-Mails verschickt).
// - Verknüpfen: Launcher-Konten (Steam, Epic, GOG, Riot) über die Prüf-Funktion "link".
// - Nachschlagen: Zu welchem Ludora-Konto gehören die Konten meiner Freundesliste?
// Die Anmeldung wird verschlüsselt gespeichert (safeStorage, siehe secrets.js).
// Mit dem Passwort werden außerdem die Launcher-Anmeldungen Ende-zu-Ende-verschlüsselt abgeglichen (vault.js).
const { t } = require('./i18n.js');
const path = require('path');
const fs = require('fs');
const { createStore, saveSecret, loadSecret } = require('./friends/common');
const vault = require('./vault');

const SECRET = 'hubSession';
const store = createStore({ status: 'signedOut', user: null, links: [], friends: [], configured: false });
let session = null; // { access_token, refresh_token, expires_at, user_id }
let cfg = null;

function config() {
  if (cfg) return cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hub-config.json'), 'utf8')); } catch { cfg = {}; }
  // Für Tests/Entwicklung überschreibbar
  if (process.env.GAMEHUB_HUB_URL) cfg.url = process.env.GAMEHUB_HUB_URL;
  if (process.env.GAMEHUB_HUB_KEY) cfg.anonKey = process.env.GAMEHUB_HUB_KEY;
  cfg.url = String(cfg.url || '').replace(/\/+$/, '');
  return cfg;
}
const configured = () => !!(config().url && config().anonKey);

/** Name prüfen: 3–24 Zeichen, Buchstaben/Zahlen/._- */
function normalizeName(name) {
  const display = String(name || '').trim();
  const username = display.toLowerCase();
  if (!/^[a-z0-9_.-]{3,24}$/.test(username)) {
    throw new Error(t(
      "Name: 3–24 Zeichen, nur Buchstaben, Zahlen, Punkt, Minus und Unterstrich."
    ));
  }
  return { username, display };
}
const emailFor = (username) => `${username}@gamehub.local`;

const MIN_PASSWORD = 10;
/**
 * Dein Passwort verlässt das Gerät nie: an den Server geht nur ein daraus abgeleiteter Wert (scrypt).
 * Den Tresor-Schlüssel (vault.js) leitet Ludora getrennt davon ab – der Server kann ihn nicht berechnen.
 */
async function serverSecret(password, username) {
  return (await vault.deriveKey(password, username, 'auth')).toString('base64');
}

async function request(pathname, { method = 'GET', body, auth = true, headers = {} } = {}) {
  const { url, anonKey } = config();
  const h = { apikey: anonKey, 'content-type': 'application/json', ...headers };
  if (auth) {
    await ensureSession();
    h.authorization = `Bearer ${session.access_token}`;
  }
  const res = await fetch(url + pathname, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data?.error_description || data?.msg || data?.message || data?.error || t("Server antwortet mit {0}", [res.status]);
    const err = new Error(typeof msg === 'string' ? msg : t("Server antwortet mit {0}", [res.status]));
    err.status = res.status;
    err.code = data?.error_code || data?.code;
    throw err;
  }
  return data;
}

function setSession(s) {
  session = s ? {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: Date.now() + (Number(s.expires_in) || 3600) * 1000,
    user_id: s.user?.id || session?.user_id
  } : null;
  saveSecret(SECRET, session ? { refresh_token: session.refresh_token, user_id: session.user_id } : null);
}

let refreshing = null;
async function ensureSession() {
  if (!session) throw new Error(t("Nicht bei Ludora angemeldet"));
  if (session.expires_at - 60000 > Date.now()) return;
  // Läuft Ludora zweimal (installiert + Entwicklung), hat die andere vielleicht schon erneuert -> deren Token nehmen
  const disk = loadSecret(SECRET);
  if (disk?.refresh_token && disk.user_id === session.user_id) session.refresh_token = disk.refresh_token;
  refreshing ||= request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: session.refresh_token } })
    .then(setSession)
    .finally(() => { refreshing = null; });
  await refreshing;
}

async function loadProfile() {
  const rows = await request(`/rest/v1/profiles?id=eq.${session.user_id}&select=username,display_name`);
  return rows?.[0] || null;
}

async function loadLinks() {
  const rows = await request('/rest/v1/linked_accounts?select=launcher,account_id,account_name,verified,updated_at&order=launcher');
  return rows || [];
}

async function refreshState() {
  const [profile, links] = await Promise.all([loadProfile(), loadLinks()]);
  store.set({ status: 'signedIn', error: null, user: profile, links });
  vault.attach(request, session.user_id);
  if (!beatTimer) startLoops();
  return store.get();
}

const friendly = (err) => {
  const m = String(err.message || err);
  if (/already registered|already exists|duplicate key/i.test(m)) return t("Dieser Name ist schon vergeben.");
  if (/Invalid login credentials/i.test(m)) return t("Name oder Passwort falsch.");
  if (/Password should be/i.test(m)) return t("Passwort zu kurz (mindestens {0} Zeichen).", [MIN_PASSWORD]);
  if (/Email not confirmed/i.test(m)) return t(
    "Im Supabase-Projekt ist \"Confirm email\" noch an – bitte ausschalten (siehe Anleitung)."
  );
  return m;
};

async function register(name, password) {
  if (!configured()) return { ok: false, error: t("Ludora-Server ist noch nicht eingerichtet (hub-config.json).") };
  try {
    const { username, display } = normalizeName(name);
    if (String(password || '').length < MIN_PASSWORD) throw new Error(t("Passwort zu kurz (mindestens {0} Zeichen).", [MIN_PASSWORD]));
    const secret = await serverSecret(password, username);
    const s = await request('/auth/v1/signup', { method: 'POST', auth: false, body: { email: emailFor(username), password: secret, data: { username } } });
    if (!s?.access_token) throw new Error('Email not confirmed');
    setSession(s);
    await request('/rest/v1/profiles', { method: 'POST', body: { id: session.user_id, username, display_name: display }, headers: { prefer: 'return=minimal' } });
    await refreshState();
    await unlockVault(password, username);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendly(err) };
  }
}

async function login(name, password) {
  if (!configured()) return { ok: false, error: t("Ludora-Server ist noch nicht eingerichtet (hub-config.json).") };
  try {
    const { username } = normalizeName(name);
    const secret = await serverSecret(password, username);
    const signIn = (pw) => request('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email: emailFor(username), password: pw } });
    let s;
    try {
      s = await signIn(secret);
    } catch (err) {
      if (!/Invalid login credentials/i.test(String(err.message))) throw err;
      // Konto von vor 0.7: Server kennt noch das echte Passwort -> einmalig auf den abgeleiteten Wert umstellen
      s = await signIn(password);
      setSession(s);
      await request('/auth/v1/user', { method: 'PUT', body: { password: secret } });
    }
    setSession(s);
    await refreshState();
    const restored = await unlockVault(password, username);
    return { ok: true, restored };
  } catch (err) {
    return { ok: false, error: friendly(err) };
  }
}

/** Launcher-Anmeldungen über das Konto abgleichen (Fehler hier verhindern die Anmeldung nicht) */
async function unlockVault(password, username) {
  try {
    await vault.unlock(password, username);
    return await vault.sync();
  } catch (err) {
    console.warn('[vault]', err.message);
    store.set({ vaultError: /vaults|PGRST205|42P01|404/i.test(String(err.message) + err.code)
      ? t("Auf dem Ludora-Server fehlt noch supabase/04_vault.sql (im SQL Editor ausführen).")
      : null });
    return [];
  }
}

async function logout() {
  clearTimeout(retryTimer);
  try { if (session) await request('/auth/v1/logout', { method: 'POST' }); } catch { /* egal */ }
  setSession(null);
  vault.detach({ forget: true });
  stopLoops();
  store.set({ status: 'signedOut', user: null, links: [], friends: [], error: null });
  return { ok: true };
}

/** Eigenes Ludora-Konto endgültig löschen (Profil, Verknüpfungen, Freundschaften) */
async function deleteAccount() {
  if (!session) return { ok: false, error: t("Nicht bei Ludora angemeldet") };
  try {
    await request('/rest/v1/rpc/delete_my_account', { method: 'POST', body: {} });
  } catch (err) {
    return { ok: false, error: friendly(err) };
  }
  setSession(null);
  vault.detach({ forget: true });
  stopLoops();
  store.set({ status: 'signedOut', user: null, links: [], friends: [], error: null });
  return { ok: true };
}

let workingFn = null;

/** Launcher-Konto verknüpfen. token: Anmelde-Token des Launchers (wird nur zur Prüfung geschickt) */
async function link(launcher, token, claim) {
  if (!session) return { ok: false, error: t("Nicht bei Ludora angemeldet") };
  // Name der Prüf-Funktion: laut hub-config.json; gibt es die auf dem Server nicht (umbenannt/neu angelegt),
  // werden die üblichen Namen probiert und der funktionierende gemerkt.
  const names = [...new Set([workingFn, config().linkFunction, 'link', 'super-worker', 'hello-world'].filter(Boolean))];
  let lastErr = null;
  for (const name of names) {
    try {
      const r = await request(`/functions/v1/${encodeURIComponent(name)}`, { method: 'POST', body: { launcher, token: token || '', claim: claim || {} } });
      workingFn = name;
      await refreshState();
      return { ok: true, ...r };
    } catch (err) {
      lastErr = err;
      if (!(err.status === 404 || /Requested function was not found|NOT_FOUND/i.test(String(err.message) + err.code))) break;
    }
  }
  return {
    ok: false,
    error: /Requested function was not found|NOT_FOUND/i.test(String(lastErr?.message) + lastErr?.code)
      ? t("Die Prüf-Funktion fehlt auf dem Ludora-Server (Supabase → Edge Functions, Inhalt von supabase/functions/link/index.ts).")
      : friendly(lastErr)
  };
}

async function unlink(launcher, accountId) {
  try {
    await request(`/rest/v1/linked_accounts?launcher=eq.${encodeURIComponent(launcher)}&account_id=eq.${encodeURIComponent(accountId)}`, { method: 'DELETE' });
    await refreshState();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendly(err) };
  }
}

/** items: [{ launcher, account_id }] -> [{ launcher, account_id, username, display_name, verified }] */
async function lookup(items) {
  if (!session || !items?.length) return [];
  const out = [];
  for (let i = 0; i < items.length; i += 1000) {
    out.push(...((await request('/rest/v1/rpc/lookup_accounts', { method: 'POST', body: { items: items.slice(i, i + 1000) } })) || []));
  }
  return out;
}

// ---------- Ludora-Freunde ----------

let friendsTimer = null;
let beatTimer = null;

/** Freunde + Anfragen laden: [{ username, display_name, relation, last_seen, accounts }] */
async function loadFriends() {
  if (!session) return [];
  const rows = (await request('/rest/v1/rpc/my_friends', { method: 'POST', body: {} })) || [];
  const now = Date.now();
  const list = rows.map((r) => ({
    username: r.username,
    displayName: r.display_name || r.username,
    relation: r.relation,
    online: !!(r.last_seen && now - new Date(r.last_seen).getTime() < 75000), // Herzschlag alle 30 s
    lastSeen: r.last_seen ? new Date(r.last_seen).getTime() : null,
    accounts: Array.isArray(r.accounts) ? r.accounts : []
  }));
  store.set({ friends: list, friendsError: null });
  return list;
}

async function refreshFriends() {
  try { await loadFriends(); } catch (err) {
    // Fehlt 02_friends.sql noch auf dem Server, gibt es die Funktion nicht
    store.set({ friendsError: /my_friends|404|PGRST202/i.test(String(err.message) + err.code)
      ? t(
      "Auf dem Ludora-Server fehlt noch supabase/02_friends.sql (im SQL Editor ausführen)."
    )
      : t("Ludora-Freunde: {0}", [friendly(err)]) });
  }
}

function startLoops() {
  stopLoops();
  const beat = () => request('/rest/v1/rpc/heartbeat', { method: 'POST', body: {} }).catch(() => {});
  beat();
  beatTimer = setInterval(beat, 30000);
  beatTimer.unref?.();
  refreshFriends();
  friendsTimer = setInterval(refreshFriends, fastFriends ? 5000 : 15000);
  friendsTimer.unref?.();
}
let fastFriends = false;
/** Freundesfenster offen -> alle 5 s abgleichen, sonst alle 15 s */
function setFast(on) {
  if (fastFriends === !!on) return;
  fastFriends = !!on;
  if (!session || !friendsTimer) return;
  clearInterval(friendsTimer);
  if (on) refreshFriends();
  friendsTimer = setInterval(refreshFriends, fastFriends ? 5000 : 15000);
  friendsTimer.unref?.();
}

/** Beim Beenden: sofort als offline melden (sonst sähen Freunde dich noch ~1 Minute online) */
async function goOffline() {
  if (!session?.user_id) return;
  try {
    await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(session.user_id)}`, {
      method: 'PATCH', body: { last_seen: new Date(Date.now() - 10 * 60000).toISOString() }, headers: { prefer: 'return=minimal' }
    });
  } catch { /* egal */ }
}

function stopLoops() {
  clearInterval(beatTimer);
  clearInterval(friendsTimer);
  beatTimer = null;
  friendsTimer = null;
}

const REQUEST_TEXT = {
  requested: 'Anfrage gesendet.',
  accepted: 'Ihr seid jetzt befreundet – er/sie hatte dich schon angefragt.',
  already_friends: 'Ihr seid schon befreundet.',
  already_requested: 'Du hast schon eine Anfrage geschickt.',
  not_found: 'Diesen Ludora-Namen gibt es nicht.',
  self: 'Das bist du selbst 🙂'
};

async function friendRequest(name) {
  try {
    const target = String(name || '').trim().replace(/^@/, '').toLowerCase();
    if (!target) return { ok: false, error: t("Bitte einen Ludora-Namen eingeben.") };
    const code = await request('/rest/v1/rpc/friend_request', { method: 'POST', body: { target_username: target } });
    await refreshFriends();
    const ok = code === 'requested' || code === 'accepted';
    return { ok, code, message: REQUEST_TEXT[code] ? t(REQUEST_TEXT[code]) : String(code), error: ok ? undefined : REQUEST_TEXT[code] ? t(REQUEST_TEXT[code]) : String(code) };
  } catch (err) {
    return { ok: false, error: friendly(err) };
  }
}
async function friendAccept(name) {
  try { await request('/rest/v1/rpc/friend_accept', { method: 'POST', body: { from_username: name } }); await refreshFriends(); return { ok: true }; } catch (err) { return { ok: false, error: friendly(err) }; }
}
async function friendRemove(name) {
  try { await request('/rest/v1/rpc/friend_remove', { method: 'POST', body: { other_username: name } }); await refreshFriends(); return { ok: true }; } catch (err) { return { ok: false, error: friendly(err) }; }
}

async function init() {
  store.set({ configured: configured() });
  const saved = loadSecret(SECRET);
  if (!configured() || !saved?.refresh_token) return;
  session = { refresh_token: saved.refresh_token, user_id: saved.user_id, expires_at: 0 };
  await connectSaved();
}

let retryTimer = null;
let retries = 0;
/** Gespeicherte Anmeldung verwenden; ohne Internet angemeldet bleiben und es später erneut versuchen */
async function connectSaved() {
  clearTimeout(retryTimer);
  try {
    await refreshState();
    retries = 0;
    if (vault.hasKey()) vault.sync().catch((err) => console.warn('[vault]', err.message));
  } catch (err) {
    if (!session) return;
    if (err.status === 400 || err.status === 401) {
      setSession(null);
      vault.detach();
      store.set({ status: 'signedOut', error: t("Ludora-Anmeldung abgelaufen – bitte neu anmelden.") });
      return;
    }
    store.set({ status: 'signedIn', error: t("Ludora-Server nicht erreichbar – neuer Versuch läuft …") });
    retryTimer = setTimeout(connectSaved, Math.min(5 * 60e3, 10e3 * 2 ** (retries++)));
    retryTimer.unref?.();
  }
}

module.exports = {
  init, register, login, logout, deleteAccount, link, unlink, lookup, setFast, goOffline,
  friendRequest, friendAccept, friendRemove, refreshFriends,
  setLinkError(launcher, msg) { store.set({ linkErrors: { ...(store.get().linkErrors || {}), [launcher]: msg || undefined } }); },
  getState: store.get, onChange: store.on, isSignedIn: () => !!session, configured,
  _normalizeName: normalizeName, _reset: () => { cfg = null; session = null; stopLoops(); store.set({ status: 'signedOut' }); }
};
