// Optionale Konto-Verbindungen (zurzeit: Battle.net).
//
// Der Login läuft in einem eigenen Fenster über die echte Anmeldeseite des Anbieters.
// Ludora sieht das Passwort nie – es bleiben nur die Cookies in einer eigenen,
// abgeschotteten Browser-Sitzung ("persist:account-battlenet") auf deinem PC.
// Electron erst bei Bedarf laden (damit die Tests auch ohne Electron laufen)
const { t } = require('./i18n.js');
const electron = () => require('electron');
const settings = require('./settings');

const ACCOUNTS = {
  battlenet: {
    name: 'Battle.net',
    partition: 'persist:account-battlenet',
    loginUrl: 'https://account.battle.net/login/de-de/?ref=' + encodeURIComponent('https://account.battle.net/games'),
    // Nicht offiziell dokumentiert (von Playnite & Co. genutzt)
    libraryUrl: 'https://account.battle.net/api/games-and-subs',
    loggedInHost: /(^|\.)account\.battle\.net$/i
  }
};

function ses(id) {
  return electron().session.fromPartition(ACCOUNTS[id].partition);
}

/** Sucht rekursiv alle Objekte mit localizedGameName heraus. */
function collectGames(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectGames(n, out));
  else if (node && typeof node === 'object') {
    if (typeof node.localizedGameName === 'string') {
      out.push({ name: node.localizedGameName, titleId: node.titleId, status: node.gameAccountStatus });
    }
    Object.values(node).forEach((v) => collectGames(v, out));
  }
  return out;
}

/** Bibliothek mit den gespeicherten Cookies abrufen. Gibt null zurück, wenn nicht angemeldet. */
async function fetchLibrary(id) {
  const acc = ACCOUNTS[id];
  const res = await ses(id).fetch(acc.libraryUrl, {
    headers: { Accept: 'application/json' },
    redirect: 'manual'
  });
  if (res.status !== 200) return null;
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) return null;
  const games = collectGames(await res.json());
  // Doppelte Namen (z. B. mehrere Regionen) zusammenfassen
  const seen = new Set();
  return games.filter((g) => !seen.has(g.name.toLowerCase()) && seen.add(g.name.toLowerCase()));
}

/** Öffnet das Login-Fenster. Löst auf, sobald die Bibliothek abrufbar ist oder das Fenster zu ist. */
function login(id, parent) {
  const acc = ACCOUNTS[id];
  return new Promise((resolve) => {
    const win = new (electron().BrowserWindow)({
      width: 520,
      height: 760,
      parent,
      modal: !!parent,
      title: `Bei ${acc.name} anmelden`,
      autoHideMenuBar: true,
      backgroundColor: '#0f1115',
      webPreferences: { partition: acc.partition, contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (!win.isDestroyed()) win.close();
      resolve(result);
    };

    const check = async () => {
      try {
        const host = new URL(win.webContents.getURL()).hostname;
        if (!acc.loggedInHost.test(host) || /\/login/i.test(win.webContents.getURL())) return;
        const games = await fetchLibrary(id);
        if (games) {
          settings.set({ [`account_${id}`]: { connected: true, at: Date.now(), games } });
          finish({ ok: true, count: games.length });
        }
      } catch { /* weiter warten */ }
    };
    win.webContents.on('did-navigate', check);
    win.webContents.on('did-navigate-in-page', check);
    win.on('closed', () => finish({ ok: false, error: t("Anmeldung abgebrochen") }));
    // Popups (z. B. "Passwort vergessen") im Standardbrowser statt in Ludora
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) electron().shell.openExternal(url);
      return { action: 'deny' };
    });
    win.loadURL(acc.loginUrl);
  });
}

async function logout(id) {
  await ses(id).clearStorageData();
  settings.set({ [`account_${id}`]: null });
}

/**
 * Bibliothek für den Scan: frisch abrufen, wenn möglich – sonst die zuletzt
 * gespeicherte Liste (z. B. offline). warning ist gesetzt, wenn der Login abgelaufen ist.
 */
async function library(id) {
  const saved = settings.get(`account_${id}`);
  if (!saved?.connected) return { games: [], warning: null };
  try {
    const games = await fetchLibrary(id);
    if (games) {
      settings.set({ [`account_${id}`]: { connected: true, at: Date.now(), games } });
      return { games, warning: null };
    }
    return { games: saved.games || [], warning: t(
      "{0}-Anmeldung abgelaufen – in den Einstellungen neu anmelden.",
      [ACCOUNTS[id].name]
    ) };
  } catch {
    return { games: saved.games || [], warning: null }; // offline: gespeicherte Liste
  }
}

function status() {
  const out = {};
  for (const id of Object.keys(ACCOUNTS)) {
    const s = settings.get(`account_${id}`);
    out[id] = s?.connected ? { connected: true, count: s.games?.length || 0, at: s.at } : { connected: false };
  }
  return out;
}

module.exports = { login, logout, library, status, collectGames, ACCOUNTS };
