// Updates aus den GitHub-Releases (Windows, macOS, Linux).
//
// Prüft beim Start, danach alle 15 Minuten, wenn das Fenster wieder in den Vordergrund kommt und nach
// dem Aufwachen aus dem Ruhezustand: https://api.github.com/repos/<repo>/releases/latest.
// Ist dort eine neuere Version, zeigt Ludora sofort (ohne Neustart) oben rechts ein grünes Download-Symbol.
// Ein Klick lädt den passenden Installer und installiert ihn:
//   Windows   -> Setup.exe still (/S) ausführen, Ludora startet danach neu
//   macOS     -> .zip entpacken, Ludora.app austauschen, neu starten
//   Linux     -> AppImage austauschen und neu starten; .deb über pkexec/apt (sonst Paketinstallation öffnen)
// Im Entwicklungsmodus (npm run dev) wird nur die Release-Seite geöffnet.
//
// Sicherheit: Ludora installiert nur Dateien, die mit dem Release-Schlüssel des Entwicklers signiert sind
// (Ed25519, signatures/<tag>.json im Repository, erstellt mit scripts/sign-release.mjs). Der private
// Schlüssel liegt nicht auf GitHub – wer das GitHub-Konto übernimmt, kann trotzdem keine Updates verteilen.
// Nach dem Download wird die SHA-256-Prüfsumme der Datei mit der signierten verglichen.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'Moxyboxyy/ludora';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbG63MKjZGta8GbK8BHMBjubqWbEa9O1ommvKAL5gwiA=
-----END PUBLIC KEY-----`;
let signatures = null; // { name: { sha256, sig } } für das aktuelle Release (nur geprüfte Einträge)

/** Signierte Prüfsumme für eine Datei – null, wenn nicht (gültig) signiert (für Tests getrennt) */
function verifiedSha(sigs, tag, name, publicKey = PUBLIC_KEY) {
  const e = sigs?.tag === tag ? sigs.files?.[name] : null;
  if (!e || !/^[0-9a-f]{64}$/.test(String(e.sha256))) return null;
  try {
    const msg = Buffer.from(`ludora-update\n${tag}\n${name}\n${e.sha256}`);
    return crypto.verify(null, msg, crypto.createPublicKey(publicKey), Buffer.from(String(e.sig), 'base64')) ? e.sha256 : null;
  } catch { return null; }
}
let state = { status: 'idle', current: null, latest: null, progress: 0, error: null, notes: null, page: null };
const listeners = new Set();
let release = null;
let timer = null;
let electron = null;

function set(patch) {
  state = { ...state, ...patch };
  for (const l of listeners) { try { l(state); } catch { /* egal */ } }
}

/** "0.10.2" > "0.9.9"? (Vorabversionen wie 0.5.0-beta zählen als älter) */
function newer(a, b) {
  const p = (v) => String(v || '').replace(/^v/, '').split('-');
  const [ma, pa] = p(a);
  const [mb, pb] = p(b);
  const na = ma.split('.').map(Number);
  const nb = mb.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) > (nb[i] || 0);
  }
  return !pa && !!pb;
}

/** Passende Datei aus dem Release für dieses System (für Tests getrennt) */
function pickAsset(assets, platform, arch, kind) {
  const files = (assets || []).filter((a) => a && a.name && !/\.(blockmap|yml)$/i.test(a.name));
  const find = (re) => files.find((a) => re.test(a.name));
  if (platform === 'win32') return find(/setup.*\.exe$/i) || find(/\.exe$/i);
  if (platform === 'darwin') {
    const a = arch === 'arm64' ? 'arm64' : 'x64';
    return find(new RegExp(`${a}[^/]*\\.zip$`, 'i')) || find(new RegExp(`${a === 'arm64' ? 'AppleSilicon' : 'Intel'}[^/]*\\.zip$`, 'i'));
  }
  if (platform === 'linux') return kind === 'deb' ? find(/amd64\.deb$/i) : find(/x86_64\.AppImage$/i);
  return null;
}

function linuxKind() {
  if (process.env.APPIMAGE) return 'appimage';
  return fs.existsSync('/usr/bin/dpkg') ? 'deb' : 'appimage';
}

const CHECK_EVERY = 15 * 60 * 1000;  // regelmäßig, solange Ludora offen ist
const MIN_GAP = 3 * 60 * 1000;       // Fokus/Aufwachen: nicht öfter als alle 3 Minuten (GitHub-Limit: 60/h)
let lastCheck = 0;
let checking = null;

/** Nachschauen, falls die letzte Prüfung länger her ist (Fenster im Vordergrund, Aufwachen …) */
function poke(minGap = MIN_GAP) {
  if (!electron || state.status === 'downloading' || state.status === 'installing') return;
  if (Date.now() - lastCheck < minGap) return;
  check().catch(() => {});
}

function check() {
  if (!checking) checking = doCheck().finally(() => { checking = null; });
  return checking;
}

async function doCheck() {
  const { app, net } = electron;
  lastCheck = Date.now();
  // Ein bereits angezeigtes Update bleibt während der Prüfung sichtbar (kein Flackern)
  const keep = ['downloading', 'installing', 'available'].includes(state.status);
  if (!keep) set({ status: 'checking', current: app.getVersion(), error: null });
  try {
    const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `Ludora/${app.getVersion()}` }
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const j = await r.json();
    const latest = String(j.tag_name || '').replace(/^v/, '');
    // Update erst anbieten, wenn die Datei für dieses System signiert ist
    let signed = false;
    if (latest && newer(latest, app.getVersion())) {
      const asset = pickAsset(j.assets, process.platform, process.arch, process.platform === 'linux' ? linuxKind() : null);
      const sr = await net.fetch(`https://raw.githubusercontent.com/${REPO}/main/signatures/${encodeURIComponent(j.tag_name)}.json`, {
        headers: { 'user-agent': `Ludora/${app.getVersion()}` }, cache: 'no-store'
      }).catch(() => null);
      signatures = sr?.ok ? await sr.json().catch(() => null) : null;
      signed = !!(asset && verifiedSha(signatures, j.tag_name, asset.name));
    }
    if (signed) {
      release = j;
      const busy = state.status === 'downloading' || state.status === 'installing';
      set({ status: busy ? state.status : 'available', latest, notes: j.body || null, page: j.html_url, error: null });
    } else if (state.status === 'downloading' || state.status === 'installing') {
      // läuft schon – nichts umwerfen
    } else {
      release = null;
      set({ status: 'none', latest: latest || null, page: j.html_url || null });
    }
  } catch (err) {
    // still: kein Netz o. Ä. -> nächstes Mal; ein schon gefundenes Update bleibt angezeigt
    if (state.status === 'checking') set({ status: 'idle', error: String(err.message || err) });
  }
  return state;
}

async function download(asset, file) {
  const { net } = electron;
  const r = await net.fetch(asset.browser_download_url, { headers: { 'user-agent': 'Ludora' } });
  if (!r.ok || !r.body) throw new Error(`Download ${r.status}`);
  const total = Number(r.headers.get('content-length')) || asset.size || 0;
  const out = fs.createWriteStream(file);
  let done = 0;
  let last = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    done += value.length;
    if (!out.write(Buffer.from(value))) await new Promise((res) => out.once('drain', res));
    if (total && Date.now() - last > 250) { last = Date.now(); set({ progress: done / total }); }
  }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  if (asset.size && fs.statSync(file).size !== asset.size) throw new Error('Download unvollständig');
  set({ progress: 1 });
}

const run = (cmd, args) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: 'ignore' });
  p.on('error', () => resolve(1));
  p.on('exit', (code) => resolve(code));
});
const detached = (cmd, args, opts = {}) => {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
  p.on('error', () => {});
  p.unref();
};

/**
 * Neustart nach dem Update, sicher gegen "Ludora läuft noch":
 * Ein kleines Skript wartet, bis dieses Ludora (PID) wirklich beendet ist (höchstens 60 s, dann hart beenden),
 * führt dann die Installation aus und startet Ludora erst danach neu. Würde Ludora früher starten,
 * sähe es die alte Instanz noch laufen und schlösse sich sofort wieder (Einzelinstanz-Sperre).
 */
function restartScript(platform, { pid, install = [], start }) {
  if (platform === 'win32') {
    // "timeout" geht ohne Konsole nicht -> ping als Pause
    return [
      '@echo off',
      'setlocal',
      'set /a n=0',
      ':wait',
      `tasklist /FI "PID eq ${pid}" /NH 2>NUL | find " ${pid} " >NUL`,
      'if errorlevel 1 goto go',
      'set /a n+=1',
      `if %n% GEQ 60 (taskkill /F /PID ${pid} >NUL 2>&1 & ping -n 3 127.0.0.1 >NUL & goto go)`,
      'ping -n 2 127.0.0.1 >NUL',
      'goto wait',
      ':go',
      'ping -n 2 127.0.0.1 >NUL',
      ...install,
      start,
      ''
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    'n=0',
    `while kill -0 ${pid} 2>/dev/null; do`,
    '  n=$((n+1))',
    `  if [ $n -ge 120 ]; then kill -9 ${pid} 2>/dev/null; sleep 1; break; fi`,
    '  sleep 0.5',
    'done',
    'sleep 1',
    ...install,
    start,
    ''
  ].join('\n');
}

/** Skript schreiben und unabhängig von Ludora starten */
function runRestart(dir, platform, opts) {
  const win = platform === 'win32';
  const script = path.join(dir, win ? 'update.cmd' : 'update.sh');
  fs.writeFileSync(script, restartScript(platform, { pid: process.pid, ...opts }));
  if (win) detached('cmd.exe', ['/d', '/c', script], { windowsHide: true });
  else { fs.chmodSync(script, 0o755); detached('/bin/sh', [script]); }
}

/** Ludora beenden; hängt das Beenden (z. B. ein Dienst antwortet nicht), nach 10 s hart beenden */
function leave(quit) {
  setTimeout(quit, 300);
  setTimeout(() => { try { electron.app.exit(0); } catch { process.exit(0); } }, 10000).unref?.();
}

const q = (x) => `"${String(x).replace(/"/g, '')}"`;

// Ab 0.8.0 ist Ludora eine Rust-App (Tauri). Deren Installer legt Ludora.exe pro Benutzer unter
// %LOCALAPPDATA%\Ludora ab und entfernt die alte Electron-Version. Nach dem Update also die neue
// App starten, wenn es sie gibt – sonst wie bisher die alte.
function winStart(execPath) {
  const next = '"%LOCALAPPDATA%\\Ludora\\Ludora.exe"';
  // Sprungmarken statt Klammern: Pfade mit ")" würden einen (…)-Block zerlegen
  return [
    `if exist ${next} goto rust`,
    `start "" ${q(execPath)} --after-update`,
    'goto done',
    ':rust',
    `start "" ${next} --after-update`,
    ':done'
  ].join('\r\n');
}
// Linux (.deb): die Rust-Version liegt unter /usr/bin/ludora, die Electron-Version unter /opt/Ludora
function linuxDebStart() {
  return 'if [ -x /usr/bin/ludora ]; then /usr/bin/ludora --after-update >/dev/null 2>&1 & else /opt/Ludora/ludora --after-update >/dev/null 2>&1 & fi';
}

/** Update herunterladen und installieren. quit(): Ludora sauber beenden (Tray, Fenster) */
async function install(quit) {
  const { app, shell } = electron;
  if (!release) await check();
  if (!release) return { ok: false, error: 'none' };
  // Entwicklungsmodus: nichts überschreiben, nur die Release-Seite zeigen
  if (!app.isPackaged) { shell.openExternal(release.html_url); return { ok: true, page: true }; }

  const kind = process.platform === 'linux' ? linuxKind() : null;
  const asset = pickAsset(release.assets, process.platform, process.arch, kind);
  if (!asset) { shell.openExternal(release.html_url); return { ok: true, page: true }; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ludora-update-'));
  const file = path.join(dir, asset.name);
  try {
    set({ status: 'downloading', progress: 0, error: null });
    const expected = verifiedSha(signatures, release.tag_name, asset.name);
    if (!expected) throw new Error('Update ist nicht signiert – aus Sicherheitsgründen nicht installiert');
    await download(asset, file);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actual !== expected) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error('Prüfsumme stimmt nicht – Download verworfen');
    }
    set({ status: 'installing' });

    if (process.platform === 'win32') {
      // Still installieren (gleicher Ordner wie bisher), erst wenn Ludora beendet ist; danach neu starten
      runRestart(dir, 'win32', {
        install: [`start "" /wait ${q(file)} /S --updated`],
        start: winStart(process.execPath)
      });
      leave(quit);
      return { ok: true };
    }

    if (process.platform === 'darwin') {
      // .app aus dem Zip holen und das laufende Ludora.app austauschen, sobald Ludora beendet ist
      const unpack = path.join(dir, 'app');
      fs.mkdirSync(unpack);
      if (await run('/usr/bin/ditto', ['-xk', file, unpack]) !== 0) throw new Error('Entpacken fehlgeschlagen');
      const newApp = fs.readdirSync(unpack).find((n) => n.endsWith('.app'));
      const current = path.resolve(app.getPath('exe'), '..', '..', '..'); // …/Ludora.app/Contents/MacOS/Ludora
      if (!newApp || !current.endsWith('.app')) throw new Error('App-Paket nicht gefunden');
      runRestart(dir, 'darwin', {
        install: [
          `rm -rf ${q(current)}`,
          `mv ${q(path.join(unpack, newApp))} ${q(current)}`,
          `xattr -dr com.apple.quarantine ${q(current)} 2>/dev/null`
        ],
        start: `open -n ${q(current)} --args --after-update`
      });
      leave(quit);
      return { ok: true };
    }

    if (process.platform === 'linux' && kind === 'appimage' && process.env.APPIMAGE) {
      const target = process.env.APPIMAGE;
      const next = `${target}.new`;
      fs.copyFileSync(file, next);
      fs.chmodSync(next, 0o755);
      fs.renameSync(next, target); // laufendes AppImage bleibt bis zum Beenden gemountet
      runRestart(dir, 'linux', { start: `${q(target)} --after-update >/dev/null 2>&1 &` });
      leave(quit);
      return { ok: true };
    }

    if (process.platform === 'linux') {
      // .deb: mit Passwortabfrage (pkexec) installieren, sonst Paketinstallation des Systems öffnen
      fs.chmodSync(file, 0o644);
      const code = fs.existsSync('/usr/bin/pkexec') ? await run('/usr/bin/pkexec', ['/usr/bin/apt-get', 'install', '-y', file]) : 1;
      if (code === 0) {
        runRestart(dir, 'linux', { start: linuxDebStart() });
        leave(quit);
        return { ok: true };
      }
      await shell.openPath(file);
      set({ status: 'available' });
      return { ok: true, manual: true };
    }
    shell.openExternal(release.html_url);
    return { ok: true, page: true };
  } catch (err) {
    set({ status: 'available', error: String(err.message || err) });
    return { ok: false, error: String(err.message || err) };
  }
}

function init(el) {
  electron = el;
  state.current = el.app.getVersion();
  setTimeout(check, 8000).unref?.();
  timer = setInterval(() => poke(CHECK_EVERY - 30e3), 60 * 1000); // fällig? (übersteht auch Ruhezustand)
  timer.unref?.();
  try {
    el.app.on('browser-window-focus', () => poke());
    el.powerMonitor?.on('resume', () => setTimeout(() => poke(0), 10e3)); // erst Netz abwarten
  } catch { /* Tests */ }
}

module.exports = {
  _verifiedSha: verifiedSha,
  _restartScript: restartScript,
  _winStart: winStart,
  init, check, poke, install,
  getState: () => state,
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  _newer: newer, _pickAsset: pickAsset
};
