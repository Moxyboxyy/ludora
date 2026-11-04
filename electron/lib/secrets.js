// Anmeldungen (Tokens) sicher speichern – verschlüsselt mit der Schlüsselverwaltung des Betriebssystems
// (Electron safeStorage: Windows DPAPI, macOS Schlüsselbund, Linux Secret Service).
//
// Gespeichert in <AppData>/Ludora/logins.json – derselben Datei für die installierte App und den
// Entwicklungsmodus, damit man sich nur einmal anmelden muss. Jeder Eintrag merkt sich, wann er
// zuletzt geändert wurde (für den Abgleich über das Ludora-Konto, siehe vault.js).
const fs = require('fs');
const path = require('path');

let file = null;
let legacy = null;   // settings-Modul (alte Speicherstelle, wird beim ersten Lesen übernommen)
let cache = null;
const listeners = new Set();

function electron() { return require('electron'); }

function init({ dir, settings }) {
  file = path.join(dir, 'logins.json');
  legacy = settings || null;
  cache = null;
  cacheMtime = 0;
}

let cacheMtime = 0;
function readAll() {
  // Neu einlesen, wenn eine andere Ludora-Instanz (z. B. installiert + Entwicklung) die Datei geändert hat
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* noch keine Datei */ }
  if (cache && mtime === cacheMtime) return cache;
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { cache = cache || {}; }
  cacheMtime = mtime;
  return cache;
}

function writeAll() {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 1));
    fs.renameSync(tmp, file); // atomar: nie eine halb geschriebene Datei
    cacheMtime = fs.statSync(file).mtimeMs;
  } catch { /* egal */ }
}

function encrypt(value) {
  const { safeStorage } = electron();
  if (!safeStorage.isEncryptionAvailable()) return null; // unverschlüsselt speichern wir nicht
  return safeStorage.encryptString(JSON.stringify(value)).toString('base64');
}
function decrypt(enc) {
  const { safeStorage } = electron();
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  return JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64')));
}

/** Wert lesen (null, wenn nicht vorhanden oder nicht entschlüsselbar) */
function get(key) {
  const all = readAll();
  let entry = all[key];
  // Alte Speicherstelle (settings.json) einmalig übernehmen
  if (!entry && legacy && legacy.get(key)) {
    try {
      const old = legacy.get(key);
      const { safeStorage } = electron();
      const raw = safeStorage.decryptString(Buffer.from(old, 'base64'));
      let value;
      try { value = JSON.parse(raw); } catch { value = raw; } // Steam speicherte einen reinen Text
      entry = { v: old, at: Date.now() };
      all[key] = { v: encrypt(value), at: entry.at };
      writeAll();
      legacy.set({ [key]: null });
      return value;
    } catch { return null; }
  }
  if (!entry?.v) return null;
  try { return decrypt(entry.v) ?? null; } catch { return null; }
}

/** Wann wurde der Eintrag zuletzt geändert (ms)? 0 = nie */
const changedAt = (key) => Number(readAll()[key]?.at) || 0;

/** Wert speichern (null/undefined = löschen). at: Änderungszeit (für Abgleich von anderen Geräten) */
function set(key, value, { at = Date.now(), silent = false } = {}) {
  const all = readAll();
  if (value === null || value === undefined) {
    if (!all[key]?.v && all[key]?.at) return;
    all[key] = { v: null, at };
  } else {
    let enc;
    try { enc = encrypt(value); } catch { enc = null; }
    if (!enc) return;
    all[key] = { v: enc, at };
  }
  writeAll();
  if (!silent) for (const l of listeners) { try { l(key, value); } catch { /* egal */ } }
}

module.exports = {
  init, get, set, changedAt,
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  _reset() { cache = null; cacheMtime = 0; }
};
