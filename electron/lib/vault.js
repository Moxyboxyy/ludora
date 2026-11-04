// Logins über das Ludora-Konto auf andere Geräte mitnehmen – Ende-zu-Ende-verschlüsselt.
//
// Ludora verschlüsselt die Launcher-Anmeldungen (Epic, GOG) auf deinem Gerät mit einem Schlüssel,
// der aus deinem Ludora-Passwort abgeleitet wird (scrypt). Auf den Ludora-Server kommt nur der
// verschlüsselte Block – ohne dein Passwort kann ihn niemand lesen, auch nicht der Server-Betreiber.
// Meldest du dich auf einem anderen Gerät mit deinem Ludora-Konto an, holt Ludora den Block,
// entschlüsselt ihn mit deinem Passwort und ist bei Epic und GOG gleich mit angemeldet.
//
// Der abgeleitete Schlüssel bleibt (wieder vom Betriebssystem verschlüsselt) auf dem Gerät, damit
// erneuerte Tokens auch später ohne Passworteingabe abgeglichen werden können.
const crypto = require('crypto');
const secrets = require('./secrets');

// Diese Anmeldungen werden mitgenommen (Riot ist rein lokal, das Ludora-Konto selbst sowieso).
// Steam bleibt ebenfalls lokal: Steam tauscht das Anmelde-Token bei jeder Erneuerung aus. Teilen sich
// mehrere Geräte eins, macht die Erneuerung auf einem Gerät das Token der anderen ungültig – und deren
// Abmeldung wurde dann wieder auf alle Geräte übertragen (ständiges Neu-Anmelden).
const SYNCED = ['friendsEpic', 'friendsGog'];
const KEY_SECRET = 'vaultKey';

let request = null;   // (pathname, opts) -> Promise (aus hubAccount, mit Anmeldung)
let userId = null;
let pushTimer = null;
let applying = false;
const restoreListeners = new Set();

/**
 * Schlüssel aus Passwort + Ludora-Name ableiten (gleich auf jedem Gerät; läuft im Hintergrund).
 * purpose 'vault' = Tresor-Schlüssel, 'auth' = was statt des Passworts an den Server geht.
 * Beide sind voneinander unabhängig: aus dem, was der Server sieht, lässt sich der Tresor nicht öffnen.
 */
function deriveKey(password, username, purpose = 'vault') {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), `ludora-${purpose}:${String(username).toLowerCase()}`, 32,
      { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function encrypt(obj, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') });
}

function decrypt(text, key) {
  const j = JSON.parse(text);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(j.iv, 'base64'));
  d.setAuthTag(Buffer.from(j.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(j.ct, 'base64')), d.final()]).toString('utf8'));
}

function key() {
  const k = secrets.get(KEY_SECRET);
  return k ? Buffer.from(k, 'base64') : null;
}

/** Lokale Anmeldungen als { name: { value, at } } */
function localEntries() {
  const out = {};
  for (const name of SYNCED) {
    const at = secrets.changedAt(name);
    if (at) out[name] = { value: secrets.get(name), at };
  }
  return out;
}

async function fetchRemote() {
  const rows = await request(`/rest/v1/vaults?user_id=eq.${encodeURIComponent(userId)}&select=data,updated_at`);
  return rows?.[0]?.data || null;
}

/**
 * Abgleichen: neuere Einträge vom Server übernehmen, danach den zusammengeführten Stand hochladen.
 * Gibt die Namen der übernommenen Anmeldungen zurück.
 */
async function sync() {
  const k = key();
  if (!request || !userId || !k) return [];
  let remote = {};
  const raw = await fetchRemote();
  if (raw) {
    try { remote = decrypt(raw, k).entries || {}; } catch { remote = {}; } // anderes Passwort -> neu anlegen
  }
  const local = localEntries();
  const restored = [];
  applying = true;
  try {
    for (const [name, r] of Object.entries(remote)) {
      if (!SYNCED.includes(name) || !r?.at) continue;
      const l = local[name];
      if (l && l.at >= r.at) continue;
      secrets.set(name, r.value ?? null, { at: r.at, silent: true });
      local[name] = r;
      if (r.value) restored.push(name);
    }
  } finally { applying = false; }
  // Zusammengeführten Stand hochladen (nur, wenn sich etwas unterscheidet)
  const merged = {};
  for (const name of SYNCED) if (local[name]) merged[name] = local[name];
  const same = JSON.stringify(merged) === JSON.stringify(Object.fromEntries(Object.entries(remote).filter(([n]) => SYNCED.includes(n))));
  if (!same) {
    await request('/rest/v1/vaults', {
      method: 'POST',
      body: { user_id: userId, data: encrypt({ entries: merged }, k), updated_at: new Date().toISOString() },
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' }
    });
  }
  for (const name of restored) for (const l of restoreListeners) { try { l(name); } catch { /* egal */ } }
  return restored;
}

/** Nach einer Änderung (neues Token, Abmeldung) gebündelt hochladen */
function schedulePush() {
  if (applying || !key() || !userId) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => sync().catch((err) => console.warn('[vault]', err.message)), 3000);
  pushTimer.unref?.();
}

secrets.onChange((name) => { if (SYNCED.includes(name)) schedulePush(); });

module.exports = {
  SYNCED,
  /** Nach Anmeldung/Registrierung: Schlüssel aus dem Passwort ableiten und merken */
  async unlock(password, username) {
    secrets.set(KEY_SECRET, (await deriveKey(password, username)).toString('base64'));
  },
  /** Verbindung zum Ludora-Server (aus hubAccount) */
  attach(req, uid) { request = req; userId = uid; },
  detach({ forget = false } = {}) {
    clearTimeout(pushTimer);
    request = null;
    userId = null;
    if (forget) secrets.set(KEY_SECRET, null);
  },
  sync,
  hasKey: () => !!key(),
  /** fn(name): eine Anmeldung kam von einem anderen Gerät -> betreffendes Modul neu starten */
  onRestore(fn) { restoreListeners.add(fn); return () => restoreListeners.delete(fn); },
  deriveKey, _deriveKey: deriveKey, _encrypt: encrypt, _decrypt: decrypt
};
