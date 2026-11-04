// Updates aus den GitHub-Releases (Windows, macOS, Linux).
//
// Prüft beim Start und alle 6 Stunden https://api.github.com/repos/<repo>/releases/latest.
// Ist dort eine neuere Version, zeigt Ludora oben rechts ein grünes Download-Symbol.
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

async function check() {
  const { app, net } = electron;
  set({ status: state.status === 'downloading' ? 'downloading' : 'checking', current: app.getVersion(), error: null });
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
      set({ status: state.status === 'downloading' ? 'downloading' : 'available', latest, notes: j.body || null, page: j.html_url });
    } else {
      release = null;
      set({ status: 'none', latest: latest || null, page: j.html_url || null });
    }
  } catch (err) {
    set({ status: 'idle', error: String(err.message || err) }); // still: kein Netz o. Ä. -> nächstes Mal
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
      // Still installieren (gleicher Ordner wie bisher), danach startet Ludora von selbst neu
      detached(file, ['/S', '--updated', '--force-run']);
      setTimeout(quit, 300);
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
      const script = path.join(dir, 'update.sh');
      fs.writeFileSync(script, [
        '#!/bin/sh',
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.5; done`,
        `rm -rf "${current}"`,
        `mv "${path.join(unpack, newApp)}" "${current}"`,
        `xattr -dr com.apple.quarantine "${current}" 2>/dev/null`,
        `open "${current}"`
      ].join('\n'));
      detached('/bin/sh', [script]);
      setTimeout(quit, 300);
      return { ok: true };
    }

    if (process.platform === 'linux' && kind === 'appimage' && process.env.APPIMAGE) {
      const target = process.env.APPIMAGE;
      const next = `${target}.new`;
      fs.copyFileSync(file, next);
      fs.chmodSync(next, 0o755);
      fs.renameSync(next, target); // laufendes AppImage bleibt bis zum Beenden gemountet
      detached(target, [], { env: { ...process.env, APPIMAGE: target } });
      setTimeout(quit, 300);
      return { ok: true };
    }

    if (process.platform === 'linux') {
      // .deb: mit Passwortabfrage (pkexec) installieren, sonst Paketinstallation des Systems öffnen
      fs.chmodSync(file, 0o644);
      const code = fs.existsSync('/usr/bin/pkexec') ? await run('/usr/bin/pkexec', ['/usr/bin/apt-get', 'install', '-y', file]) : 1;
      if (code === 0) {
        detached('/opt/Ludora/ludora', []);
        setTimeout(quit, 300);
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
  timer = setInterval(check, 6 * 60 * 60 * 1000);
  timer.unref?.();
}

module.exports = {
  _verifiedSha: verifiedSha,
  init, check, install,
  getState: () => state,
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  _newer: newer, _pickAsset: pickAsset
};
