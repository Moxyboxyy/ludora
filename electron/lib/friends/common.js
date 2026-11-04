// Gemeinsame Bausteine für die Freundeslisten (Riot, Epic, GOG)
//
// - Einheitliches Format für Freunde:
//     { id, name, tag?, avatar?, state: 'online'|'away'|'busy'|'offline', gameName?, richText?, lastOnline? }
// - Anmelde-Fenster über die echte Login-Seite des Anbieters (Ludora sieht nie ein Passwort)
// - Anmelde-Token verschlüsselt speichern (Windows-/macOS-Verschlüsselung über safeStorage)
const settings = require('../settings');

const electron = () => require('electron');

/** Kleiner Zustandsspeicher mit Benachrichtigung */
function createStore(initial) {
  let state = { status: 'disconnected', error: null, friends: [], ...initial };
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch, ...(patch.friends ? { updatedAt: Date.now() } : {}) };
      for (const l of listeners) { try { l(state); } catch { /* egal */ } }
    },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}

// Anmeldungen liegen gemeinsam in logins.json (siehe ../secrets.js)
function saveSecret(key, value) { require('../secrets').set(key, value || null); }
function loadSecret(key) { return require('../secrets').get(key); }

/** Netzwerkfehler (kein Internet, Server kurz weg) – dann später erneut versuchen statt abzumelden */
function isTransient(err) {
  const m = String(err?.code || '') + ' ' + String(err?.message || err || '');
  if (/invalid_grant|invalid_token|unauthori[sz]ed|\b40[013]\b|expired|revoked/i.test(m)) return false;
  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|socket|network|fetch failed|timeout|\b5\d\d\b|\b429\b/i.test(m);
}

/**
 * Anmelde-Fenster öffnen. `check(url, webContents)` wird nach jeder Navigation aufgerufen und
 * gibt ein Ergebnis zurück, sobald die Anmeldung fertig ist (sonst null/undefined).
 */
function loginWindow({ title, url, partition, check, parent }) {
  return new Promise((resolve) => {
    const win = new (electron().BrowserWindow)({
      width: 520,
      height: 780,
      parent,
      modal: !!parent,
      title,
      autoHideMenuBar: true,
      backgroundColor: '#0f1115',
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (!win.isDestroyed()) win.close();
      resolve(result);
    };
    const run = async (target) => {
      try {
        const r = await check(target || win.webContents.getURL(), win.webContents);
        if (r) finish(r);
      } catch { /* weiter warten */ }
    };
    // Weiterleitungen abfangen, bevor die Zielseite lädt (z. B. GOGs ...?code=...)
    win.webContents.on('will-redirect', (_e, u) => run(u));
    win.webContents.on('did-navigate', (_e, u) => run(u));
    win.webContents.on('did-navigate-in-page', (_e, u) => run(u));
    win.webContents.on('did-finish-load', () => run());
    win.on('closed', () => finish(null));
    win.webContents.setWindowOpenHandler(({ url: u }) => {
      if (/^https:\/\//.test(u)) electron().shell.openExternal(u);
      return { action: 'deny' };
    });
    win.loadURL(url);
  });
}

async function clearPartition(partition) {
  try { await electron().session.fromPartition(partition).clearStorageData(); } catch { /* egal */ }
}

async function getJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** XML-Entitäten zurückwandeln (für Text aus XMPP-Nachrichten) */
function unescapeXml(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

module.exports = { createStore, saveSecret, loadSecret, isTransient, loginWindow, clearPartition, getJson, unescapeXml, escapeXml };
