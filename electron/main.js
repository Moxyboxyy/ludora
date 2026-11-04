const i18n = require('./lib/i18n.js');
const { t } = i18n;
const { app, BrowserWindow, ipcMain, shell, dialog, protocol, net, session, Notification } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

// Eigenes Protokoll für lokale Bilder (z. B. Steams Cover-Cache).
// ghimg://steam/<appid>/tall|wide – die Oberfläche kann damit nur diese Bilder lesen,
// keine beliebigen Dateien.
// Bild-Zwischenspeicher von Chromium auf 200 MB begrenzen
app.commandLine.appendSwitch('disk-cache-size', String(200 * 1024 * 1024));

// Umbenennung GameHub -> Ludora: Einstellungen, Anmeldungen und eigene Cover aus dem alten
// Datenordner einmalig übernehmen (Zwischenspeicher bleiben weg, die füllen sich neu).
{
  const fsx = require('fs');
  const appData = app.getPath('appData');
  const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'blob_storage', 'Shared Dictionary']);
  for (const [from, to] of [['GameHub', 'Ludora'], ['GameHub-dev', 'Ludora-dev']]) {
    const src = path.join(appData, from);
    const dst = path.join(appData, to);
    if (!fsx.existsSync(src) || fsx.existsSync(dst)) continue;
    try {
      fsx.cpSync(src, dst, { recursive: true, filter: (p) => !SKIP.has(path.basename(p)) || path.dirname(p) !== src });
    } catch (err) {
      console.error('[umbenennung] alte Daten nicht übernommen:', err.message);
    }
  }
}

// Entwickler-Start (npm run dev) bekommt einen eigenen Datenordner. So kommt er dem installierten
// Ludora nicht in die Quere (sonst: "Unable to move the cache: Zugriff verweigert").
// Beim ersten Mal werden Einstellungen, Steam-Anmeldung und eigene Cover übernommen.
// Anmeldungen (logins.json) liegen immer im Ordner der installierten App – auch im Entwicklungsmodus.
const SHARED_DIR = app.getPath('userData');
if (process.env.VITE_DEV_SERVER_URL) {
  const fsx = require('fs');
  const main = SHARED_DIR;
  const dev = `${main}-dev`;
  if (!fsx.existsSync(dev)) {
    try {
      fsx.mkdirSync(dev, { recursive: true });
      for (const name of fsx.existsSync(main) ? fsx.readdirSync(main) : []) {
        const src = path.join(main, name);
        if (/\.json$/i.test(name)) fsx.copyFileSync(src, path.join(dev, name));
        else if (name === 'custom-covers') fsx.cpSync(src, path.join(dev, name), { recursive: true });
      }
    } catch { /* dann eben frisch */ }
  }
  // Denselben Windows-Schlüssel wie die installierte App benutzen (steht in "Local State"),
  // sonst kann der Entwicklungsmodus die gemeinsam gespeicherten Anmeldungen nicht entschlüsseln.
  try {
    const read = (f) => JSON.parse(fsx.readFileSync(f, 'utf8'));
    const mainState = read(path.join(main, 'Local State'));
    if (mainState?.os_crypt) {
      const devFile = path.join(dev, 'Local State');
      let devState = {};
      try { devState = read(devFile); } catch { /* neu */ }
      if (JSON.stringify(devState.os_crypt) !== JSON.stringify(mainState.os_crypt)) {
        devState.os_crypt = mainState.os_crypt;
        fsx.writeFileSync(devFile, JSON.stringify(devState));
      }
    }
  } catch { /* installierte App noch nie gestartet -> eigener Schlüssel */ }
  app.setPath('userData', dev);
}

// Nur ein Ludora gleichzeitig (pro Datenordner): ein zweiter Start holt das offene Fenster nach vorne
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'ghimg', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);
const { spawn } = require('child_process');
const { scanAll, providers } = require('./providers');
const hide = require('./lib/hide');
const shop = require('./lib/shop');
const tray = require('./lib/tray');
const updater = require('./lib/updater');

// Sprache für die Oberfläche (preload fragt sie beim Laden synchron ab)
ipcMain.on('i18n:lang', (e) => { e.returnValue = i18n.getLanguage(); });

// Beim Schließen läuft Ludora im Tray weiter; nur "Beenden" (Tray/Menü) beendet wirklich
let isQuitting = false;
// Autostart mit dem System: dann versteckt im Tray starten
const startHidden = process.argv.includes('--hidden');
const manual = require('./providers/manual');
const settings = require('./lib/settings');
const steam = require('./providers/steam');
const covers = require('./lib/covers');
const accounts = require('./lib/accounts');
const coverCheck = require('./lib/coverCheck');
const steamFriends = require('./lib/steamFriends');
const { readIo } = require('./lib/procio');
const ioSampler = require('./lib/ioSampler');
const { isMac, appBundle } = require('./lib/platform');
const macIcon = require('./lib/macIcon');
const running = require('./lib/running');
const reg = require('./lib/registry');

/**
 * Programm-Symbol als PNG. Auf dem Mac NICHT app.getFileIcon verwenden –
 * das läuft dort in einem Hintergrund-Thread und lässt Electron abstürzen.
 */
async function fileIconPng(file) {
  if (isMac) return macIcon.iconPng(file);
  const img = await app.getFileIcon(file, { size: 'large' });
  return img.isEmpty() ? null : img.toPNG();
}

/** Prozessnamen eines Launchers für das Verstecken (je nach System) */
const procNames = (p) => (isMac ? p?.processesMac : p?.processes) || null;
const fs = require('fs');

let win;
// Letzter Scan: Starten geht nur für Spiele, die der Hauptprozess selbst gefunden hat.
// Die Oberfläche schickt nur die ID, nie einen Pfad – so kann sie nichts Beliebiges ausführen.
let lastScan = { games: [] };

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Bereich im Fenster öffnen (vom Tray aus) */
function navigate(page) {
  showWindow();
  const send = () => win?.webContents.send('app:navigate', page);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'Ludora',
    show: !startHidden,
    autoHideMenuBar: true,
    // Eigene Leiste oben (TitleBar.jsx). Windows/Linux: echte Fensterknöpfe in unseren Farben darüber,
    // macOS: die Ampel-Knöpfe sitzen in unserer Leiste.
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : { titleBarOverlay: { color: '#0f1115', symbolColor: '#aab1c2', height: 44 } }),
    // Fenster-/Taskleistensymbol (auf dem Mac kommt das Symbol aus dem App-Paket)
    ...(isMac ? {} : { icon: path.join(__dirname, 'assets', 'icon.png') }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Schließen (✕) -> in den Tray statt beenden (abschaltbar in den Einstellungen)
  let trayHintShown = settings.get('trayHintShown', false);
  // Windows-Abmeldung/Herunterfahren: wirklich beenden, nicht verstecken
  win.on('session-end', () => { isQuitting = true; });
  win.on('close', (e) => {
    if (isQuitting || !settings.get('closeToTray', true)) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      settings.set({ trayHintShown: true });
      new Notification({
        title: t("Ludora läuft weiter"),
        body: process.platform === 'darwin'
          ? t("Ludora ist oben in der Menüleiste. Beenden über das Symbol dort.")
          : t(
          "Ludora ist unten rechts im Infobereich. Rechtsklick auf das Symbol → Beenden."
        )
      }).show();
    }
  });

  // Externe Links im System-Browser öffnen statt im App-Fenster
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ---------- Cover-Prüfung & Programm-Symbole ----------

const urlCache = new Map();
async function coverUrlOk(url) {
  if (urlCache.has(url)) return urlCache.get(url);
  let ok = false;
  try {
    if (url.startsWith('ghimg://steam/')) {
      const [appid, kind] = url.slice('ghimg://steam/'.length).split('/');
      ok = !!(await steam.findCachedImage(appid, kind));
    } else if (url.startsWith('ghimg://lutris/')) {
      const [slug, kind] = url.slice('ghimg://lutris/'.length).split('/');
      ok = !!require('./lib/linuxLaunchers').lutrisImage(decodeURIComponent(slug), kind);
    } else if (url.startsWith('ghimg://custom/')) {
      ok = fs.existsSync(path.join(customCoverDir(), path.basename(decodeURIComponent(url.slice('ghimg://custom/'.length).split('?')[0]))));
    } else if (/^https:\/\//.test(url)) {
      const res = await net.fetch(url, { method: 'HEAD' });
      ok = res.ok && (res.headers.get('content-type') || 'image').startsWith('image');
    }
  } catch { ok = false; }
  urlCache.set(url, ok);
  return ok;
}

const SKIP_EXE = /unins|uninst|crash|report|redist|setup|install|helper|vc_?redist|dxsetup|dotnet|ue4prereq|easyanticheat|battleye|cleanup|touchup|activation|launcherpatcher/i;

/** Haupt-EXE eines Spiels raten: größte passende .exe im Ordner (und eine Ebene tiefer). */
async function guessGameExe(dir) {
  const found = [];
  const scan = async (d, depth) => {
    let entries = [];
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && /\.exe$/i.test(e.name) && !SKIP_EXE.test(e.name)) {
        try { found.push({ p, size: (await fs.promises.stat(p)).size }); } catch { /* egal */ }
      } else if (e.isDirectory() && depth < 1 && /^(bin|binaries|win64|x64|game)$/i.test(e.name)) {
        await scan(p, depth + 1);
      }
    }
  };
  await scan(dir, 0);
  found.sort((a, b) => b.size - a.size);
  return found[0]?.p || null;
}

const iconCache = new Map();
async function gameIcon(id) {
  if (iconCache.has(id)) return iconCache.get(id);
  const g = lastScan.games.find((x) => x.id === id);
  let png = null;
  try {
    let file = null;
    if (!file && g?.launch?.type === 'exe' && /\.exe$/i.test(g.launch.target) && g.provider !== 'riot' &&
        !/battle\.net|galaxyclient|launcher\.exe|steam\.exe/i.test(g.launch.target)) {
      file = g.launch.target;
    }
    if (!file && isMac && g?.installDir) {
      // macOS: das .app-Paket des Spiels (oder der Ordner selbst) liefert das Symbol
      file = appBundle(g.installDir) || (await fs.promises.readdir(g.installDir).catch(() => []))
        .filter((n) => n.endsWith('.app')).map((n) => path.join(g.installDir, n))[0] || null;
    }
    if (!file && !isMac && g?.installDir) file = await guessGameExe(g.installDir);
    if (file) png = await fileIconPng(file);
  } catch { png = null; }
  iconCache.set(id, png);
  return png;
}

function customCoverDir() {
  return path.join(app.getPath('userData'), 'custom-covers');
}

const launcherIconCache = new Map();
/** Programm-Symbol des Launchers (Steam, Epic, ...) für die Seitenleiste */
async function launcherIcon(id) {
  if (launcherIconCache.has(id)) return launcherIconCache.get(id);
  let png = null;
  try {
    const p = providers.find((x) => x.id === id);
    const launch = p?.client ? await p.client() : null;
    if (launch?.type === 'exe' && launch.target && fs.existsSync(launch.target)) {
      png = await fileIconPng(launch.target);
    }
  } catch { png = null; }
  launcherIconCache.set(id, png);
  return png;
}

// ---------- Download-Geschwindigkeit & Restzeit ----------

const speedSamples = new Map(); // id -> [{t, bytes}]

// Für Launcher ohne eigenen Fortschritt (Epic): empfangene Bytes der Launcher-Prozesse messen
const ioState = new Map(); // providerId -> { samples: [{t, bytes}], last }
const ioDone = new Map();  // gameId -> seit Beobachtungsbeginn geladene Bytes

async function measureIo(provider) {
  const bytes = await readIo(provider.processes);
  const st = ioState.get(provider.id) || { samples: [] };
  const now = Date.now();
  if (bytes === null) { ioState.delete(provider.id); return null; }
  const delta = st.last !== undefined && bytes >= st.last ? bytes - st.last : 0;
  st.last = bytes;
  st.samples = st.samples.filter((s) => now - s.t < 20000);
  st.samples.push({ t: now, bytes });
  ioState.set(provider.id, st);
  const first = st.samples[0];
  const dt = (now - first.t) / 1000;
  const speed = dt >= 2 ? Math.max(0, (bytes - first.bytes) / dt) : null;
  return { speed, delta };
}

function applyIo(id, u, io) {
  if (!io) return u;
  const done = (ioDone.get(id) || 0) + io.delta;
  ioDone.set(id, done);
  const out = { ...u, speed: io.speed || undefined };
  if (u.bytesTotal) {
    // Gezählt wird erst ab Beobachtungsbeginn -> Restzeit ist eine Obergrenze
    out.bytesDone = Math.min(done, u.bytesTotal);
    out.progress = Math.min(0.99, out.bytesDone / u.bytesTotal);
    out.eta = io.speed > 0 ? Math.max(0, u.bytesTotal - out.bytesDone) / io.speed : null;
    out.etaUpper = true;
  }
  return out;
}

// ---------- Sekundengenaue Werte aus der Live-Messung (Windows) ----------

const liveState = new Map(); // gameId -> { done, lastBytes }

/**
 * Tempo, Fortschritt und Restzeit sekundengenau: Die Live-Messung der Launcher-Programme
 * zählt die empfangenen Bytes; der vom Launcher gemeldete Stand ist die Untergrenze.
 */
function applyLive(id, u, r) {
  const st = liveState.get(id) || { done: u.bytesDone || 0, lastBytes: r.total };
  const delta = Math.max(0, r.total - st.lastBytes);
  st.lastBytes = r.total;
  st.done = Math.max(st.done + delta, u.bytesDone || 0);
  if (u.bytesTotal) st.done = Math.min(st.done, u.bytesTotal * 0.995);
  liveState.set(id, st);
  const out = { ...u, speed: r.speed };
  delete out.ioMeasure;
  if (u.bytesTotal) {
    out.bytesDone = st.done;
    out.progress = Math.max(u.progress || 0, st.done / u.bytesTotal);
    out.eta = r.speed > 0 ? Math.max(0, u.bytesTotal - st.done) / r.speed : null;
    out.etaUpper = false;
  } else {
    out.eta = undefined; // aus dem Prozent-Verlauf (addSpeed)
  }
  out.live = true;
  return out;
}

/**
 * Ergänzt update um speed (Bytes/s) und eta (Sekunden).
 * 1. Liefert der Launcher selbst Werte (Battle.net, Steam-Log), werden die genommen.
 * 2. Sonst: gemessen über die geladenen Bytes der letzten ~20 s.
 * 3. Gibt es nur Prozent (Riot), wird die Restzeit aus dem Fortschritt der letzten ~60 s hochgerechnet.
 */
function addSpeed(id, u) {
  if (!u || u.state !== 'downloading') { speedSamples.delete(id); return u; }
  const now = Date.now();
  const list = (speedSamples.get(id) || []).filter((s) => now - s.t < 60000);
  const last = list[list.length - 1];
  // Zurückgesprungen (neuer Abschnitt) -> neu anfangen
  if (last && ((u.bytesDone || 0) < (last.bytes || 0) || (u.progress ?? 0) < (last.p ?? 0) - 0.001)) list.length = 0;
  list.push({ t: now, bytes: u.bytesDone || 0, p: u.progress });
  speedSamples.set(id, list);

  const out = { ...u };
  const remaining = u.bytesTotal ? Math.max(0, u.bytesTotal - (u.bytesDone || 0)) : null;
  if (out.speed === undefined && u.bytesDone) {
    const recent = list.filter((s) => now - s.t < 20000);
    const first = recent[0];
    const dt = (now - first.t) / 1000;
    if (dt >= 2) out.speed = Math.max(0, (u.bytesDone - first.bytes) / dt);
  }
  if (out.eta === undefined || out.eta === null) {
    if (out.speed > 0 && remaining !== null) out.eta = remaining / out.speed;
    else if (u.progress !== undefined) {
      const first = list.find((s) => s.p !== undefined);
      const dt = first ? (now - first.t) / 1000 : 0;
      const dp = first ? u.progress - first.p : 0;
      out.eta = dt >= 10 && dp > 0 ? ((1 - u.progress) / dp) * dt : null;
    } else out.eta = null;
  }
  // Ohne Gesamtgröße, aber mit Prozent und Tempo: Größe abschätzen ist unsicher -> weglassen
  return out;
}

// ---------- Installation: Launcher nach dem Bestätigungsdialog in den Hintergrund ----------

/**
 * Steam und Epic zeigen bei einer Neuinstallation zwingend einen Dialog (Speicherort).
 * Sobald der Download wirklich läuft, schieben wir den Launcher in den Tray.
 */
function watchInstallStart(game) {
  const p = providers.find((x) => x.id === game.provider);
  if (!p?.updates || !procNames(p)) return;
  const started = Date.now();
  const tick = async () => {
    if (Date.now() - started > 5 * 60 * 1000) return; // nach 5 Minuten aufgeben
    try {
      const list = await p.updates();
      const hit = list.find((u) => String(u.nativeId) === String(game.nativeId) && u.update?.state === 'downloading');
      if (hit) {
        hide.keepInBackground(p.id, procNames(p), { seconds: 15, mode: 'hide' });
        return;
      }
    } catch { /* weiter versuchen */ }
    setTimeout(tick, 2500);
  };
  setTimeout(tick, 3000);
}

/** Wartet bis zu `ms`, ob der Launcher das Update dieses Spiels herunterlädt (oder einreiht) */
async function waitForDownload(game, p, ms) {
  if (!p?.updates) return false;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const hit = (await p.updates()).find((u) => String(u.nativeId) === String(game.nativeId));
      if (hit && ['downloading', 'queued'].includes(hit.update?.state)) return true;
    } catch { /* weiter */ }
  }
  return false;
}

// ---------- Laufende Spiele ----------

const runningCache = { t: 0, map: new Map(), busy: null };
/** Laufende Spiele (Map gameId -> pid), höchstens alle 3 s neu ermittelt */
async function runningGames() {
  if (Date.now() - runningCache.t < 3000) return runningCache.map;
  if (!runningCache.busy) {
    runningCache.busy = running.detect(lastScan.games)
      .then((m) => { runningCache.map = m; runningCache.t = Date.now(); return m; })
      .finally(() => { runningCache.busy = null; });
  }
  return runningCache.busy;
}

// ---------- Deinstallieren ----------

/**
 * Wie wird ein Spiel deinstalliert?
 * 1. Der Launcher hat einen eigenen Weg (z. B. steam://uninstall) -> der zeigt auch die Rückfrage
 * 2. Windows: Deinstallations-Eintrag des Spiels (Systemsteuerung "Programme und Features")
 * 3. Sonst: Launcher beim Spiel öffnen, dort "Deinstallieren" wählen
 */
async function uninstallPlan(game, p) {
  const name = p?.name || 'Launcher';
  const silentUninstall = require('./lib/silentUninstall');
  // 1. Lautlos über den Launcher selbst (Steam, Epic, Battle.net) – kein Launcher-Fenster
  if (p?.uninstallSilent && (process.platform === 'win32' || game.provider !== 'epic')) {
    const restart = game.provider === 'steam' || game.provider === 'epic';
    return {
      silent: true,
      via: name,
      detail: t(
        "Ludora entfernt das Spiel im Hintergrund – {0} bleibt unsichtbar.",
        [name]
      ) +
        (restart ? t(
        " {0} wird dafür kurz im Hintergrund beendet und neu gestartet; laufende Downloads machen danach weiter.",
        [name]
      ) : '') +
        t(
          " Spielstände in der Cloud bleiben erhalten, lokale Spielstände im Spielordner werden mit gelöscht."
        )
    };
  }
  // 2. Windows: Deinstallationsprogramm mit "lautlos"-Schalter
  if (process.platform === 'win32') {
    const entry = await findUninstallEntry(game);
    const quiet = entry && silentUninstall.silentCommand(entry.cmd, entry.quiet);
    if (quiet) {
      return {
        quietCommand: quiet,
        via: entry.name,
        detail: t(
          "Das Deinstallationsprogramm von „{0}“ läuft unsichtbar im Hintergrund. Spielstände in der Cloud bleiben erhalten; lokale Spielstände können verloren gehen.",
          [entry.name]
        )
      };
    }
  }
  if (p?.uninstall) {
    const launch = await p.uninstall(game);
    if (launch) return { launch, via: name, detail: t(
      "{0} übernimmt die Deinstallation und fragt ggf. noch einmal nach.",
      [name]
    ) };
  }
  if (process.platform === 'win32') {
    const entry = await findUninstallEntry(game);
    if (entry) {
      return {
        command: entry.cmd,
        via: entry.name,
        detail: t(
          "Das Deinstallationsprogramm von „{0}“ wird gestartet. Spielstände in der Cloud bleiben erhalten; lokale Spielstände können verloren gehen.",
          [entry.name]
        )
      };
    }
  }
  if (game.provider === 'manual') return null;
  const page = (p?.uninstallPage && (await p.uninstallPage(game))) || (p?.client && (await p.client()));
  if (!page) return null;
  return { launch: page, via: name, page: true, detail: t(
    "{0} lässt das Deinstallieren nicht von außen zu. Ludora öffnet {1} – dort beim Spiel „Deinstallieren“ wählen.",
    [name, name]
  ) };
}

async function findUninstallEntry(game) {
  const { normalize } = require('./lib/names');
  const dir = game.installDir ? running._norm(game.installDir) : null;
  const name = normalize(game.name);
  let best = null;
  for (const { values: v } of await reg.getUninstallEntries()) {
    const cmd = v.UninstallString;
    if (!cmd || !v.DisplayName || v.SystemComponent === '0x1') continue;
    const loc = v.InstallLocation ? running._norm(v.InstallLocation) : null;
    if (dir && loc && loc === dir) return { cmd, quiet: v.QuietUninstallString || null, name: v.DisplayName };
    if (!best && name && normalize(v.DisplayName) === name) best = { cmd, quiet: v.QuietUninstallString || null, name: v.DisplayName };
  }
  return best;
}

/** Deinstallations-Befehl aus der Registry starten (zeigt das Fenster des Herstellers) */
function runUninstallCommand(cmd) {
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], {
    detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true
  });
  child.on('error', () => {});
  child.unref();
}

// ---------- Chatfenster (eins pro Freund) ----------

const chatWindows = new Map(); // Chat-ID -> BrowserWindow ("7656…" = Steam, "riot:<puuid>", "epic:<accountId>")

// Chat-IDs: Steam = SteamID64, andere Launcher = "<launcher>:<id>"
const CHAT_ID = /^(\d{17}|(riot|epic):[A-Za-z0-9-]{8,80})$/;
const chatSources = {}; // launcher -> Modul mit .chat (wird beim Start gefüllt)
function chatTarget(id) {
  const m = String(id).match(/^(riot|epic):(.+)$/);
  return m ? { launcher: m[1], id: m[2], mod: chatSources[m[1]] } : { launcher: 'steam', id: String(id), mod: null };
}
function chatName(id) {
  const c = chatTarget(id);
  if (c.launcher === 'steam') return steamFriends.findFriend(c.id)?.name || null;
  const f = (c.mod?.getState().friends || []).find((x) => x.id === c.id);
  return f ? `${f.name}${f.tag ? '#' + f.tag : ''}` : null;
}
function chatWatch(id, on) {
  const c = chatTarget(id);
  if (c.launcher === 'steam') steamFriends.watch(c.id, on);
  else c.mod?.chat?.watch(c.id, on);
}

function openChatWindow(steamid) {
  const existing = chatWindows.get(steamid);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }
  const name = chatName(steamid);
  const w = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 320,
    minHeight: 400,
    title: name ? `${name} – Chat` : 'Chat',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const hash = `chat=${encodeURIComponent(steamid)}`;
  if (process.env.VITE_DEV_SERVER_URL) w.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${hash}`);
  else w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash });
  chatWindows.set(steamid, w);
  chatWatch(steamid, true); // solange offen: häufiger nach neuen Nachrichten schauen
  w.on('closed', () => { chatWindows.delete(steamid); chatWatch(steamid, false); });
  return w;
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function findGame(id) {
  const g = lastScan.games.find((x) => x.id === id);
  if (!g) throw new Error(t("Spiel nicht gefunden – bitte Bibliothek neu laden."));
  return g;
}

/** Startet ein Programm abgekoppelt von Ludora */
function spawnDetached(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/**
 * macOS: alles über "open" – mit -g bleibt das Programm im Hintergrund (kommt nicht nach vorne).
 * .app-Pakete werden mit "open -a <App> --args ..." gestartet.
 */
async function runLaunchMac(launch, background) {
  const g = background ? ['-g'] : [];
  if (launch.type === 'url') return shell.openExternal(launch.target);
  if (launch.type === 'uri') return spawnDetached('open', [...g, launch.target]);
  const bundle = appBundle(launch.target);
  if (bundle) {
    const args = launch.args?.length ? ['--args', ...launch.args] : [];
    return spawnDetached('open', [...g, '-a', bundle, ...args]);
  }
  return spawnDetached(launch.target, launch.args || [], launch.cwd || path.dirname(launch.target));
}

async function runLaunch(launch, { background = false } = {}) {
  if (!launch) throw new Error(t("Launcher nicht gefunden."));
  if (launch.type === 'none') return; // schon erledigt (z. B. Update direkt beim Launcher-Dienst angestoßen)
  if (launch.type === 'url' && !/^https:\/\//.test(launch.target)) throw new Error(t("Ungültige Adresse"));
  if (isMac) return runLaunchMac(launch, background);
  if (launch.type === 'url') {
    // Feste Shop-Webseiten aus den Launcher-Modulen -> System-Browser
    await shell.openExternal(launch.target);
    return;
  }
  if (launch.type === 'uri') {
    // Der jeweilige Launcher (Steam, Epic, ...) ist für das Protokoll registriert
    // und startet sich bei Bedarf selbst im Hintergrund.
    await shell.openExternal(launch.target);
    return;
  }
  if (launch.type === 'exe' && process.platform === 'linux' && !/\.desktop$/i.test(launch.target)) {
    // Linux: Programme (Heroic, Lutris, AppImages, Skripte) direkt starten
    await spawnDetached(launch.target, launch.args || [], launch.cwd || (path.isAbsolute(launch.target) ? path.dirname(launch.target) : undefined));
    return;
  }
  if (launch.type === 'exe' && !/\.exe$/i.test(launch.target)) {
    // Verknüpfungen (.lnk, .url, .bat) über Windows öffnen lassen
    const err = await shell.openPath(launch.target);
    if (err) throw new Error(err);
    return;
  }
  if (launch.type === 'exe') {
    // Spiel läuft weiter, auch wenn Ludora geschlossen wird
    await spawnDetached(launch.target, launch.args || [], launch.cwd || path.dirname(launch.target));
    return;
  }
  throw new Error(`Unbekannter Starttyp: ${launch.type}`);
}

async function launchGame(game) {
  const provider = providers.find((p) => p.id === game.provider);
  // Beim Spielen den Launcher im Hintergrund halten. Beim Installieren erst den
  // Dialog (Speicherort) zeigen und nach Download-Start verstecken.
  const installed = game.status !== 'notInstalled';
  if (procNames(provider) && installed) {
    hide.keepInBackground(provider.id, procNames(provider), { mode: settings.get('launcherMode', 'hide') });
  }
  if (!installed && settings.get('launcherMode', 'hide') !== 'off') watchInstallStart(game);
  await runLaunch(game.launch, { background: installed && settings.get('launcherMode', 'hide') !== 'off' });
}

app.whenReady().then(() => {
  // macOS/Linux: Herunterfahren -> wirklich beenden
  require('electron').powerMonitor.on('shutdown', () => { isQuitting = true; app.quit(); });
  if (!primaryInstance) return; // zweiter Start: nur das offene Fenster nach vorne holen (siehe oben)
  manual.init(app.getPath('userData'));
  settings.init(app.getPath('userData'));
  require('./lib/secrets').init({ dir: SHARED_DIR, settings });
  i18n.setLanguage(settings.get('language', 'en')); // Standard: Englisch
  covers.init(app.getPath('userData'));
  coverCheck.init(app.getPath('userData'));
  macIcon.init(app.getPath('userData'));
  shop.setCacheFile(path.join(app.getPath('userData'), 'shop-cache.json'));

  // Updates aus den GitHub-Releases
  updater.init({ app, net, shell });
  updater.onChange((st) => broadcast('update:state', st));
  ipcMain.handle('update:get', () => updater.getState());
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:install', async () => {
    const st = updater.getState();
    if (st.status !== 'available') return { ok: false };
    const { response } = await dialog.showMessageBox(win, {
      type: 'info', buttons: [t("Später"), t("Jetzt aktualisieren")], defaultId: 1, cancelId: 0,
      title: t("Update verfügbar"),
      message: t("Ludora {0} ist da (du hast {1}).", [st.latest, st.current]),
      detail: t("Ludora lädt das Update herunter, installiert es und startet danach neu. Deine Einstellungen und Anmeldungen bleiben erhalten.")
    });
    if (response !== 1) return { ok: false, cancelled: true };
    return updater.install(quitApp);
  });

  protocol.handle('ghimg', async (req) => {
    const u = new URL(req.url);
    const [appid, kind] = u.pathname.replace(/^\//, '').split('/');
    if (u.hostname === 'steam') {
      const file = await steam.findCachedImage(appid, kind);
      if (file) return net.fetch(pathToFileURL(file).toString());
    }
    if (u.hostname === 'riot') {
      const id = decodeURIComponent(u.pathname.slice(1));
      if (/^[a-z0-9_.-]+$/i.test(id)) {
        const base = isMac ? '/Users/Shared' : (process.env.PROGRAMDATA || 'C:\\ProgramData');
        const file = path.join(base, 'Riot Games', 'Metadata', id, `${id}.ico`);
        if (fs.existsSync(file)) return net.fetch(pathToFileURL(file).toString());
      }
    }
    if (u.hostname === 'lutris') {
      const file = require('./lib/linuxLaunchers').lutrisImage(decodeURIComponent(appid || ''), kind);
      if (file) return net.fetch(pathToFileURL(file).toString());
    }
    if (u.hostname === 'launcher') {
      const png = await launcherIcon(decodeURIComponent(u.pathname.slice(1)));
      if (png) return new Response(png, { headers: { 'content-type': 'image/png' } });
    }
    if (u.hostname === 'custom') {
      const name = path.basename(decodeURIComponent(u.pathname.slice(1)));
      const file = path.join(customCoverDir(), name);
      if (fs.existsSync(file)) return net.fetch(pathToFileURL(file).toString());
    }
    if (u.hostname === 'icon') {
      const png = await gameIcon(decodeURIComponent(u.pathname.slice(1)));
      if (png) return new Response(png, { headers: { 'content-type': 'image/png' } });
    }
    return new Response(null, { status: 404 });
  });

  ipcMain.handle('settings:get', async () => {
    const s = settings.getAll();
    // Erkannte SteamID als Vorschlag mitschicken
    const steamPath = await steam.findSteamPath();
    const detectedSteamId = steamPath ? await steam.findSteamId(steamPath) : null;
    return {
      steamApiKey: s.steamApiKey || '',
      steamId: s.steamId || '',
      steamGridDbKey: s.steamGridDbKey || '',
      launcherMode: s.launcherMode || 'hide',
      closeToTray: s.closeToTray !== false,
      language: i18n.getLanguage(),
      bnetAccountLibrary: s.bnetAccountLibrary === true,
      autostart: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false,
      autostartAvailable: app.isPackaged,
      accounts: accounts.status(),
      enabledLaunchers: s.enabledLaunchers || {},
      launchers: providers.map((p) => ({
        id: p.id, name: t(p.name), accent: p.accent,
        // Battle.net-Konto (inoffizielle Schnittstelle) nur nach ausdrücklichem Einschalten
        account: !!accounts.ACCOUNTS[p.id] && (p.id !== 'battlenet' || s.bnetAccountLibrary === true)
      })),
      detectedSteamId
    };
  });

  ipcMain.handle('settings:set', async (_e, patch) => {
    const before = settings.get('steamGridDbKey', '');
    const allowed = {};
    for (const k of ['steamApiKey', 'steamId', 'steamGridDbKey']) {
      if (typeof patch?.[k] === 'string') allowed[k] = patch[k].trim();
    }
    if (['hide', 'minimize', 'off'].includes(patch?.launcherMode)) allowed.launcherMode = patch.launcherMode;
    if (typeof patch?.closeToTray === 'boolean') allowed.closeToTray = patch.closeToTray;
    let languageChanged = false;
    if (['en', 'de'].includes(patch?.language) && patch.language !== i18n.getLanguage()) {
      allowed.language = patch.language;
      languageChanged = true;
    }
    if (typeof patch?.bnetAccountLibrary === 'boolean') allowed.bnetAccountLibrary = patch.bnetAccountLibrary;
    // Mit dem System starten (nur in der installierten App – im Entwicklungsmodus würde sonst electron.exe eingetragen)
    if (typeof patch?.autostart === 'boolean' && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: patch.autostart, openAsHidden: true, args: ['--hidden'] });
    }
    if (patch?.enabledLaunchers && typeof patch.enabledLaunchers === 'object') {
      const ids = new Set(providers.map((p) => p.id));
      allowed.enabledLaunchers = Object.fromEntries(
        Object.entries(patch.enabledLaunchers).filter(([k, v]) => ids.has(k) && typeof v === 'boolean')
      );
    }
    settings.set(allowed);
    // Neuer SteamGridDB-Key: bisher erfolglose Cover-Suchen sofort wiederholen
    if (allowed.steamGridDbKey && allowed.steamGridDbKey !== before) covers.clearMisses();
    if (languageChanged) {
      // Neue Sprache: alle Fenster neu laden, Tray-Menü neu bauen
      i18n.setLanguage(allowed.language);
      tray.refreshMenu();
      setTimeout(() => BrowserWindow.getAllWindows().forEach((w) => w.webContents.reload()), 150);
    }
    return { ok: true, languageChanged };
  });

  // Menü oben (TitleBar): Version, Entwicklerkonsole, Beenden, Datenordner
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform }));
  ipcMain.handle('app:devtools', (e) => { e.sender.toggleDevTools(); return true; });
  ipcMain.handle('app:quit', () => { app.quit(); return true; });
  ipcMain.handle('app:openData', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:openExternal', async (_e, url) => {
    // Nur feste, bekannte Seiten
    const ALLOWED = [
      'https://steamcommunity.com/dev/apikey',
      'https://steamcommunity.com/my/edit/settings',
      'https://www.steamgriddb.com/profile/preferences/api'
    ];
    if (ALLOWED.includes(url)) await shell.openExternal(url);
  });

  // Schnellstart: letzte Bibliothek sofort zeigen, die neue wird im Hintergrund eingelesen
  const libraryCacheFile = path.join(app.getPath('userData'), 'library-cache.json');
  ipcMain.handle('library:cached', async () => {
    try {
      const c = JSON.parse(await fs.promises.readFile(libraryCacheFile, 'utf8'));
      if (!Array.isArray(c?.games)) return null;
      if (!lastScan.games.length) lastScan = c; // Starten/Updaten geht dann schon vor dem neuen Scan
      return c;
    } catch { return null; }
  });
  let cacheTimer = null;
  const saveLibraryCache = () => {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      fs.promises.writeFile(libraryCacheFile, JSON.stringify({ games: lastScan.games, providers: lastScan.providers, scannedAt: lastScan.scannedAt }))
        .catch(() => {});
    }, 2000);
  };

  let coverRun = 0;
  ipcMain.handle('library:scan', async (e) => {
    lastScan = await scanAll(settings.get('enabledLaunchers', {}));
    urlCache.clear();
    iconCache.clear();
    for (const p of lastScan.providers) {
      if (p.hasClient) p.logo = `ghimg://launcher/${p.id}`;
    }
    covers.applyCached(lastScan.games);

    // Fehlende Cover im Hintergrund suchen und einzeln nachreichen
    const missing = covers.needsLookup(lastScan.games);
    const run = ++coverRun;
    const sender = e.sender;
    const push = (id, imgs) => {
      const g = lastScan.games.find((x) => x.id === id);
      if (g) Object.assign(g, imgs);
      saveLibraryCache();
      if (run === coverRun && !sender.isDestroyed()) sender.send('library:cover', { id, ...imgs });
    };
    // Installierte Spiele bekommen als letzte Reserve ihr Programm-Symbol
    for (const g of lastScan.games) {
      if (!g.iconUrl && g.status !== 'notInstalled' && g.installDir) {
        g.iconUrl = `ghimg://icon/${encodeURIComponent(g.id)}`;
      }
    }
    (async () => {
      if (missing.length) await covers.resolveMissing(missing, push);
      if (run !== coverRun) return;
      // Danach jedes Cover prüfen, Fehlschläge reparieren, Bericht schreiben
      const reportPaths = [path.join(app.getPath('userData'), 'cover-report.json')];
      if (process.env.VITE_DEV_SERVER_URL) reportPaths.push(path.join(process.cwd(), 'cover-report.json'));
      await coverCheck.run(lastScan.games, { urlOk: coverUrlOk, onUpdate: push, reportPaths });
    })().catch((err) => console.error('[covers]', err));
    saveLibraryCache();
    tray.refreshMenu();
    return lastScan;
  });

  // Bild-Zwischenspeicher
  ipcMain.handle('cache:info', async () => ({ bytes: await session.defaultSession.getCacheSize() }));
  ipcMain.handle('cache:clear', async () => {
    await session.defaultSession.clearCache();
    return { bytes: await session.defaultSession.getCacheSize() };
  });

  // Optionale Konto-Anmeldung (Login-Fenster mit der echten Anmeldeseite)
  ipcMain.handle('account:login', async (_e, id) => {
    if (!accounts.ACCOUNTS[id]) return { ok: false, error: t("Unbekanntes Konto") };
    if (id === 'battlenet' && !settings.get('bnetAccountLibrary', false)) return { ok: false, error: t("Erst in den Einstellungen unter „Erweitert“ einschalten.") };
    return accounts.login(id, win);
  });
  ipcMain.handle('account:logout', async (_e, id) => {
    if (!accounts.ACCOUNTS[id]) return { ok: false };
    await accounts.logout(id);
    return { ok: true };
  });

  // ---------- Shop ----------
  ipcMain.handle('shop:query', (_e, opts) => shop.query(opts || {}));
  ipcMain.handle('shop:more', (_e, titles) => shop.more(Array.isArray(titles) ? titles : []));
  // Spiel im Store öffnen: im Launcher, wenn er installiert ist, sonst im Browser
  ipcMain.handle('shop:open', async (_e, store) => {
    const url = String(store?.url || '');
    const uri = String(store?.uri || '');
    if (!shop.isAllowedUrl(url)) return { ok: false, error: t("Ungültiger Store-Link") };
    try {
      const info = (lastScan.providers || []).find((x) => x.id === store.launcher);
      const hasLauncher = !!info && info.enabled !== false && (info.count > 0 || info.installed > 0);
      // Linux: nur Steam kennt dort sein Protokoll (Epic & Co. laufen über Heroic/Lutris) -> sonst Browser
      const uriWorks = process.platform !== 'linux' || store.launcher === 'steam';
      if (uri && uriWorks && shop.isAllowedUri(uri) && hasLauncher) {
        hide.stop(store.launcher); // Shop soll sichtbar sein
        await runLaunch({ type: 'uri', target: uri });
        return { ok: true, via: 'launcher' };
      }
      await shell.openExternal(url);
      return { ok: true, via: 'browser' };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // Launcher oder Shop bewusst öffnen
  ipcMain.handle('launcher:open', async (_e, providerId, what) => {
    const p = providers.find((x) => x.id === providerId);
    if (!p) return { ok: false, error: t("Unbekannter Launcher") };
    if (what === 'download') {
      // Launcher herunterladen: nur Adressen aus der festen Liste (providers/index.js)
      const url = require('./providers').downloadUrl(p.id);
      if (!url) return { ok: false, error: t("Für {0} gibt es hier keinen Download.", [p.name]) };
      await shell.openExternal(url);
      return { ok: true };
    }
    try {
      hide.stop(p.id); // falls gerade noch versteckt wird
      const launch = what === 'store' ? p.store : await p.client?.();
      if (!launch) return { ok: false, error: t("{0} ist nicht installiert.", [p.name]) };
      await runLaunch(launch);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('game:launch', async (_e, id) => {
    const game = findGame(id);
    try {
      // Läuft das Spiel schon? Dann nur nach vorne holen statt ein zweites Mal starten
      const pid = runningCache.map.get(game.id);
      if (pid) { running.focus(pid); return { ok: true, focused: true }; }
      await launchGame(game);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---------- Steam-Freunde ----------
  steamFriends.onChange((st) => broadcast('friends:update', st));
  // Neue Nachricht (Steam, Riot, Epic) -> an alle Fenster + Benachrichtigung, wenn der Chat nicht vorne ist
  const onChatEvent = (ev) => {
    broadcast('chat:event', ev);
    if (ev.type === 'message' && !ev.fromMe && Notification.isSupported()) {
      const w = chatWindows.get(ev.steamid);
      if (!w || w.isDestroyed() || !w.isFocused()) {
        const n = new Notification({ title: chatName(ev.steamid) || t("Neue Nachricht"), body: String(ev.text).slice(0, 200), silent: false });
        n.on('click', () => openChatWindow(ev.steamid));
        n.show();
      }
    }
  };
  steamFriends.onChat(onChatEvent);
  ipcMain.handle('chat:open', (_e, id) => {
    if (!CHAT_ID.test(String(id))) return { ok: false };
    openChatWindow(String(id));
    return { ok: true };
  });
  ipcMain.handle('chat:history', async (_e, id) => {
    if (!CHAT_ID.test(String(id))) return { ok: false, messages: [] };
    const c = chatTarget(id);
    try {
      const messages = c.launcher === 'steam' ? await steamFriends.history(c.id) : await c.mod.chat.history(c.id);
      return { ok: true, messages };
    } catch (err) { return { ok: false, error: err.message, messages: [] }; }
  });
  ipcMain.handle('chat:send', async (_e, id, text) => {
    if (!CHAT_ID.test(String(id)) || !String(text || '').trim()) return { ok: false };
    const c = chatTarget(id);
    try {
      if (c.launcher === 'steam') await steamFriends.send(c.id, text);
      else await c.mod.chat.send(c.id, text);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('chat:typing', (_e, id) => (chatTarget(id).launcher === 'steam' ? steamFriends.typing(String(id)) : null));
  ipcMain.handle('chat:read', (_e, id) => (chatTarget(id).launcher === 'steam' ? steamFriends.markRead(String(id)) : null));
  steamFriends.init();
  ipcMain.handle('friends:get', () => steamFriends.getState());
  ipcMain.handle('friends:qr', async () => {
    try { return await steamFriends.startQr(); } catch (err) { return { ...steamFriends.getState(), error: err.message }; }
  });
  ipcMain.handle('friends:logout', () => { steamFriends.logout(); return { ok: true }; });
  ipcMain.handle('friends:fast', (_e, on) => { steamFriends.setFast(on); });
  // ---------- Weitere Freundeslisten (Riot, Epic, GOG) + Personen ----------
  const otherFriends = {
    riot: require('./lib/friends/riot'),
    epic: require('./lib/friends/epic'),
    gog: require('./lib/friends/gog')
  };
  const people = require('./lib/friends/people');
  // Chat für Riot und Epic
  require('./lib/friends/chatLog').init(app.getPath('userData'));
  for (const id of ['riot', 'epic']) {
    chatSources[id] = otherFriends[id];
    otherFriends[id].chat.onChat(onChatEvent);
  }
  otherFriends.riot.chat.start();
  for (const [id, m] of Object.entries(otherFriends)) {
    m.onChange((st) => broadcast('friends2:update', { id, state: st }));
    try { m.init(); } catch (err) { console.error('[friends]', id, err); }
  }
  ipcMain.handle('friends2:list', () => Object.fromEntries(Object.entries(otherFriends).map(([id, m]) => [id, m.getState()])));
  ipcMain.handle('friends2:login', async (_e, id) => {
    const m = otherFriends[id];
    if (!m?.login) return { ok: false, error: t("Nicht möglich") };
    return m.login(win);
  });
  ipcMain.handle('friends2:logout', async (_e, id) => { await otherFriends[id]?.logout?.(); return { ok: true }; });
  ipcMain.handle('friends2:refresh', (_e, id) => { otherFriends[id]?.refresh?.(); return { ok: true }; });
  ipcMain.handle('friends2:fast', (_e, on) => { for (const m of Object.values(otherFriends)) m.setFast?.(on); hub.setFast(on); });
  // Riot Client unsichtbar starten (die Riot-Freundesliste braucht den laufenden Client)
  ipcMain.handle('friends2:startRiot', async () => {
    const p = providers.find((x) => x.id === 'riot');
    const launch = await p?.client?.();
    if (!launch) return { ok: false, error: t("Riot Client nicht gefunden.") };
    hide.keepInBackground('riot', procNames(p), { seconds: 60, mode: 'hide' });
    await runLaunch(launch, { background: true });
    setTimeout(() => otherFriends.riot.refresh(), 8000);
    setTimeout(() => otherFriends.riot.refresh(), 20000);
    return { ok: true };
  });
  // Launcher öffnen, um einem Freund dort zu schreiben (Riot/Epic/GOG haben keinen Chat in Ludora)
  ipcMain.handle('friends2:open', async (_e, id) => {
    const p = providers.find((x) => x.id === id);
    const launch = p?.client ? await p.client() : null;
    if (!launch) return { ok: false, error: t("{0} nicht gefunden.", [p?.name || 'Launcher']) };
    hide.stop(id);
    await runLaunch(launch);
    return { ok: true, name: p.name };
  });
  // ---------- Ludora-Konto (Server) ----------
  const hub = require('./lib/hubAccount');
  hub.onChange((st) => broadcast('hub:update', st));
  // Anmeldung kam über das Ludora-Konto von einem anderen Gerät -> betreffende Freundesliste neu verbinden
  require('./lib/vault').onRestore((name) => {
    if (name === 'steamWebToken') steamFriends.restore();
    if (name === 'friendsEpic') otherFriends.epic.restore();
    if (name === 'friendsGog') otherFriends.gog.restore();
  });
  const linkSources = { steam: steamFriends, ...otherFriends };
  const linkedOnce = new Map(); // launcher -> Konto, das in dieser Sitzung schon verknüpft wurde
  async function autoLink(launcher) {
    if (!hub.isSignedIn()) return;
    const src = linkSources[launcher];
    try {
      const proof = await src?.getLinkProof?.();
      if (!proof?.accountId || linkedOnce.get(launcher) === proof.accountId) return;
      const r = await hub.link(launcher, proof.token, proof.claim);
      if (r.ok) { linkedOnce.set(launcher, proof.accountId); hub.setLinkError(launcher, null); }
      else { console.warn('[hub] Verknüpfen', launcher, r.error); hub.setLinkError(launcher, r.error); }
    } catch (err) { console.warn('[hub] Verknüpfen', launcher, err.message); hub.setLinkError(launcher, err.message); }
  }
  const linkAll = () => Object.keys(linkSources).forEach((l) => autoLink(l));
  steamFriends.onChange((st) => { if (st.status === 'connected') autoLink('steam'); });
  for (const [id, m] of Object.entries(otherFriends)) m.onChange((st) => { if (st.status === 'connected') autoLink(id); });
  hub.init().then(() => linkAll());

  ipcMain.handle('hub:get', () => hub.getState());
  ipcMain.handle('hub:register', async (_e, name, password) => { const r = await hub.register(name, password); if (r.ok) { linkedOnce.clear(); linkAll(); } return r; });
  ipcMain.handle('hub:login', async (_e, name, password) => { const r = await hub.login(name, password); if (r.ok) { linkedOnce.clear(); linkAll(); } return r; });
  ipcMain.handle('hub:logout', () => { linkedOnce.clear(); return hub.logout(); });
  ipcMain.handle('hub:deleteAccount', async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: [t("Abbrechen"), t("Konto endgültig löschen")], defaultId: 0, cancelId: 0,
      title: t("Ludora-Konto löschen"),
      message: t("Ludora-Konto endgültig löschen?"),
      detail: t(
        "Dein Ludora-Name, alle verknüpften Launcher-Konten und deine Ludora-Freundschaften werden vom Server gelöscht. Das lässt sich nicht rückgängig machen. Deine Spiele und Launcher bleiben unberührt."
      )
    });
    if (response !== 1) return { ok: false, cancelled: true };
    linkedOnce.clear();
    return hub.deleteAccount();
  });
  ipcMain.handle('hub:unlink', (_e, launcher, id) => hub.unlink(String(launcher), String(id)));
  ipcMain.handle('hub:relink', () => { linkedOnce.clear(); linkAll(); return { ok: true }; });
  ipcMain.handle('hub:friendRequest', (_e, name) => hub.friendRequest(String(name || '')));
  ipcMain.handle('hub:friendAccept', (_e, name) => hub.friendAccept(String(name || '')));
  ipcMain.handle('hub:friendRemove', (_e, name) => hub.friendRemove(String(name || '')));
  ipcMain.handle('hub:refreshFriends', () => hub.refreshFriends());
  // Steam: jemanden als Steam-Freund hinzufügen / Profil öffnen (für Konten aus Ludora-Freundschaften)
  ipcMain.handle('hub:steamAdd', async (_e, steamid) => {
    if (!/^\d{17}$/.test(String(steamid))) return { ok: false };
    hide.stop('steam');
    await shell.openExternal(`steam://friends/add/${steamid}`);
    return { ok: true };
  });
  // Freundesliste: welche Konten gehören zu Ludora-Nutzern?
  ipcMain.handle('hub:lookup', async (_e, items) => {
    try {
      const list = (Array.isArray(items) ? items : []).slice(0, 3000)
        .map((x) => ({ launcher: String(x.launcher), account_id: String(x.account_id) }))
        .filter((x) => ['steam', 'riot', 'epic', 'gog'].includes(x.launcher) && x.account_id);
      return { ok: true, items: await hub.lookup(list) };
    } catch (err) { return { ok: false, items: [], error: err.message }; }
  });

  ipcMain.handle('people:get', () => people.get());
  ipcMain.handle('people:save', (_e, list) => people.save(list));

  ipcMain.handle('friends:action', async (_e, steamid, action) => {
    if (!/^\d{17}$/.test(String(steamid))) return { ok: false };
    const f = steamFriends.findFriend(String(steamid));
    const urls = {
      chat: `steam://friends/message/${steamid}`,
      profile: `https://steamcommunity.com/profiles/${steamid}`,
      games: `https://steamcommunity.com/profiles/${steamid}/games/?tab=all`,
      join: steamFriends.joinUrl(f),
      store: f?.appid ? `steam://store/${Number(f.appid)}` : null,
      friendsWindow: 'steam://open/friends'
    };
    const url = urls[action];
    if (!url) return { ok: false, error: t("Nicht möglich") };
    hide.stop('steam');
    await shell.openExternal(url);
    return { ok: true };
  });

  // Download-/Update-Zustände aller Launcher (schnell, ohne kompletten Scan)
  ipcMain.handle('downloads:status', async () => {
    const enabled = settings.get('enabledLaunchers', {});
    const result = {};
    await Promise.all(providers.map(async (p) => {
      if (!p.updates || enabled[p.id] === false) return;
      try {
        const list = await p.updates();
        const downloading = list.filter((u) => u.update?.state === 'downloading');
        // Battle.net liefert Tempo/Restzeit selbst exakt -> keine eigene Messung
        const needLive = downloading.some((u) => u.update.source !== 'Battle.net');
        let live = null;
        if (needLive && process.platform === 'win32') {
          ioSampler.keepAlive();
          live = ioSampler.rate(p.id);
        }
        const needIo = !live && list.some((u) => u.update?.ioMeasure && u.update.state === 'downloading');
        const io = needIo ? await measureIo(p) : null;
        // Ein Launcher lädt meist nur ein Spiel gleichzeitig -> Live-Bytes dem ersten zuordnen
        const liveTarget = downloading.find((u) => u.update.source !== 'Battle.net');
        for (const u of list) {
          const id = `${p.id}:${u.nativeId}`;
          if (u.update?.state !== 'downloading') liveState.delete(id);
          if (live && u === liveTarget) result[id] = addSpeed(id, applyLive(id, u.update, live));
          else if (u.update?.ioMeasure && io) result[id] = applyIo(id, u.update, io);
          else result[id] = addSpeed(id, u.update);
        }
      } catch { /* einzelner Launcher egal */ }
    }));
    // Im letzten Scan mitführen, damit "Update"-Knöpfe stimmen
    for (const g of lastScan.games) if (g.update || result[g.id]) g.update = result[g.id] || null;
    return result;
  });

  // "Update": Launcher im Hintergrund starten – er lädt das Update selbst, Ludora zeigt den Fortschritt.
  // visible=true (Knopf "Öffnen" im Download-Fenster): Launcher sichtbar öffnen.
  ipcMain.handle('game:update', async (_e, id, visible = false) => {
    const game = findGame(id);
    const p = providers.find((x) => x.id === game.provider);
    // Seite im Launcher, auf der man das Update von Hand anstoßen kann
    const page = async () => (p?.updatePage ? p.updatePage(game) : null) || (await p?.client?.()) || game.launch;
    try {
      if (visible || p?.autoUpdate === false) {
        hide.stop(game.provider);
        await runLaunch(await page());
        return { ok: true, visible: true };
      }
      // 1. Launcher unsichtbar starten bzw. Update direkt beim Launcher-Dienst anstoßen.
      //    Das Verstecken läuft schon vorher, weil backgroundUpdate den Launcher evtl. selbst startet.
      const mode0 = settings.get('launcherMode', 'hide');
      hide.keepInBackground(p.id, procNames(p), { seconds: 90, mode: mode0 === 'off' ? 'hide' : mode0 });
      const launch = p?.backgroundUpdate ? await p.backgroundUpdate(game) : p?.client && (await p.client());
      if (!launch) {
        // Ging im Hintergrund nicht -> Launcher sichtbar beim Spiel öffnen
        hide.stop(game.provider);
        await runLaunch(await page());
        return { ok: true, visible: true, fallback: true };
      }
      const mode = settings.get('launcherMode', 'hide');
      hide.keepInBackground(p.id, procNames(p), { seconds: 40, mode: mode === 'off' ? 'hide' : mode });
      await runLaunch(launch, { background: true });
      // 2. Prüfen, ob der Download wirklich losgeht
      if (await waitForDownload(game, p, p.updateWaitMs || 25000)) return { ok: true, visible: false };
      // 3. Nein -> Launcher sichtbar beim Spiel öffnen, dort reicht ein Klick auf "Aktualisieren"
      hide.stop(game.provider);
      await runLaunch(await page());
      return { ok: true, visible: true, fallback: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // Pausieren/Fortsetzen geht bei keinem Launcher von außen -> dessen Download-Ansicht öffnen
  ipcMain.handle('download:manage', async (_e, id) => {
    const game = findGame(id);
    const p = providers.find((x) => x.id === game.provider);
    try {
      // Battle.net: direkt beim Dienst anhalten/fortsetzen, kein Fenster
      const paused = game.update?.state === 'paused';
      if (paused ? p?.resumeDownload : p?.pauseDownload) {
        const ok = await (paused ? p.resumeDownload(game) : p.pauseDownload(game)).catch(() => false);
        if (ok) return { ok: true, name: p.name, silent: true, action: paused ? 'resumed' : 'paused' };
      }
      hide.stop(game.provider);
      const launch = p?.downloadsPage ? p.downloadsPage(game) : await p?.client?.();
      if (!launch) throw new Error(t("{0} wurde nicht gefunden.", [p?.name || 'Launcher']));
      await runLaunch(launch);
      return { ok: true, name: p.name };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('game:setCover', async (_e, id) => {
    const game = findGame(id);
    const res = await dialog.showOpenDialog(win, {
      title: t("Cover für {0} wählen", [game.name]),
      properties: ['openFile'],
      filters: [{ name: t("Bilder"), extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'ico'] }]
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    const src = res.filePaths[0];
    const name = require('crypto').createHash('sha1').update(id).digest('hex').slice(0, 16) + path.extname(src).toLowerCase();
    fs.mkdirSync(customCoverDir(), { recursive: true });
    fs.copyFileSync(src, path.join(customCoverDir(), name));
    // Zeitstempel im Link, damit ein neues Bild nicht aus dem Zwischenspeicher kommt
    const imgs = covers.setCustom(id, `ghimg://custom/${name}?v=${Date.now()}`);
    Object.assign(game, imgs);
    return { ok: true, ...imgs };
  });

  // ---------- Laufende Spiele ----------
  ipcMain.handle('games:running', async () => {
    try { return [...(await runningGames()).keys()]; } catch { return []; }
  });
  ipcMain.handle('game:focus', async (_e, id) => {
    const pid = (await runningGames()).get(id);
    if (pid) running.focus(pid);
    return { ok: !!pid };
  });

  // ---------- Deinstallieren ----------
  ipcMain.handle('game:uninstall', async (_e, id) => {
    const game = findGame(id);
    const p = providers.find((x) => x.id === game.provider);
    try {
      if (runningCache.map.get(game.id)) throw new Error(t("{0} läuft gerade – bitte erst beenden.", [game.name]));
      const plan = await uninstallPlan(game, p);
      if (!plan) throw new Error(t("Für {0} kenne ich keinen Deinstallations-Weg.", [game.name]));
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: t("Deinstallieren"),
        message: `${game.name} deinstallieren?`,
        detail: plan.detail,
        buttons: [t("Deinstallieren"), t("Abbrechen")],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      });
      if (response !== 0) return { ok: false, canceled: true };
      if (plan.silent) {
        try {
          const r = await p.uninstallSilent(game);
          if (r) { reg.clearCache(); return { ok: true, via: r.via, silent: true, done: true }; }
        } catch (err) {
          // Lautlos ging nicht -> sagen warum, nichts halb machen
          return { ok: false, error: t("Deinstallieren im Hintergrund nicht möglich: {0}", [err.message]) };
        }
        // Battle.net-Dienst nicht erreichbar -> Battle.net beim Spiel öffnen
        const page = (p?.uninstallPage && (await p.uninstallPage(game))) || (p?.client && (await p.client()));
        if (!page) throw new Error(t("{0} ist nicht erreichbar.", [p?.name]));
        hide.stop(game.provider);
        await runLaunch(page);
        return { ok: true, via: p.name, page: true };
      }
      if (plan.quietCommand) {
        const code = await require('./lib/silentUninstall').runHidden(plan.quietCommand);
        reg.clearCache();
        if (code !== 0) return { ok: false, error: t("Das Deinstallationsprogramm meldet Fehler {0}.", [code]) };
        return { ok: true, via: plan.via, silent: true, done: true };
      }
      if (plan.launch) { hide.stop(game.provider); await runLaunch(plan.launch); }
      else if (plan.command) runUninstallCommand(plan.command);
      reg.clearCache();
      return { ok: true, via: plan.via, page: !!plan.page };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---------- Favoriten (launcherübergreifend, gespeichert in den Einstellungen) ----------
  ipcMain.handle('favorites:get', () => settings.get('favorites', []));
  ipcMain.handle('favorites:toggle', (_e, id) => {
    setTimeout(() => tray.refreshMenu(), 0);
    const key = String(id || '');
    if (!/^[a-z]+:.{1,200}$/.test(key)) return settings.get('favorites', []);
    const list = settings.get('favorites', []).filter((x) => x !== key);
    if (list.length === settings.get('favorites', []).length) list.push(key); // war noch kein Favorit
    settings.set({ favorites: list });
    return list;
  });

  ipcMain.handle('game:openFolder', async (_e, id) => {
    const game = findGame(id);
    if (!game.installDir) return { ok: false, error: t("Kein Installationsordner bekannt.") };
    const err = await shell.openPath(game.installDir);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle('manual:pickExe', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: t("Spiel auswählen"),
      properties: ['openFile'],
      filters: [
        isMac ? { name: 'Programme', extensions: ['app'] } : { name: 'Programme', extensions: ['exe', 'lnk', 'bat', 'url'] },
        { name: t("Alle Dateien"), extensions: ['*'] }
      ]
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('manual:add', async (_e, data) => {
    if (!data || !data.exe) return { ok: false, error: t("Keine Datei gewählt.") };
    manual.add(data);
    return { ok: true };
  });

  ipcMain.handle('manual:remove', async (_e, id) => {
    const game = findGame(id);
    if (game.provider !== 'manual') return { ok: false, error: t("Nur eigene Spiele können entfernt werden.") };
    manual.remove(game.nativeId);
    return { ok: true };
  });

  createWindow();
  app.on('activate', () => showWindow());

  tray.create({
    show: showWindow,
    toggle: () => (win && !win.isDestroyed() && win.isVisible() && win.isFocused() ? win.hide() : showWindow()),
    navigate,
    quit: quitApp,
    favorites: () => {
      const ids = settings.get('favorites', []);
      return ids.map((id) => lastScan.games.find((g) => g.id === id)).filter((g) => g && g.status !== 'notInstalled')
        .sort((a, b) => a.name.localeCompare(b.name, 'de'));
    },
    launch: async (id) => {
      const game = lastScan.games.find((g) => g.id === id);
      if (!game) return;
      try {
        const pid = runningCache.map.get(game.id);
        if (pid) running.focus(pid);
        else await launchGame(game);
      } catch (err) {
        console.error('[tray] Start fehlgeschlagen', err);
      }
    }
  });
});

let offlineSent = false;
app.on('before-quit', (e) => {
  isQuitting = true;
  hide.stopAll();
  tray.destroy();
  // Ludora-Freunden sofort "offline" melden (höchstens 1,5 s warten)
  const hubAcc = require('./lib/hubAccount');
  if (!offlineSent && hubAcc.isSignedIn()) {
    e.preventDefault();
    offlineSent = true;
    Promise.race([hubAcc.goOffline(), new Promise((r) => setTimeout(r, 1500))]).finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => ioSampler.stop());
