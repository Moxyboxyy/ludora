// Epic Games
//
// Windows: %ProgramData%\Epic\EpicGamesLauncher\Data\...
// macOS:   ~/Library/Application Support/Epic/EpicGamesLauncher/Data/...
//
// Installiert: Data\Manifests\*.item
// Bibliothek:  %LocalAppData%\EpicGamesLauncher\Saved\Data\Catalog\catcache.bin
//              (Base64-JSON mit allen Spielen deines Kontos inkl. Bildern)
const { t } = require('../lib/i18n.js');
const path = require('path');
const { readJson, readText, listDir, env, firstExisting, exeLaunch } = require('../lib/util');
const { normalize } = require('../lib/names');
const { isMac, home, macSupport } = require('../lib/platform');

/** Datenordner des Launchers (Manifests, Catalog, ...) */
function epicDataDir() {
  if (isMac) return macSupport('Epic', 'EpicGamesLauncher', 'Data');
  return path.join(env('PROGRAMDATA') || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data');
}

// Der Katalog liegt je nach Launcher-Version unter ProgramData oder LocalAppData
function catalogPaths() {
  const local = env('LOCALAPPDATA');
  return [
    path.join(epicDataDir(), 'Catalog', 'catcache.bin'),
    local && path.join(local, 'EpicGamesLauncher', 'Saved', 'Data', 'Catalog', 'catcache.bin'),
    isMac && macSupport('Epic', 'EpicGamesLauncher', 'Saved', 'Data', 'Catalog', 'catcache.bin')
  ].filter(Boolean);
}

function imagesOf(item) {
  const imgs = item.keyImages || [];
  const pick = (...types) => types.map((t) => imgs.find((i) => i.type === t)?.url).find(Boolean);
  return {
    covers: [pick('DieselGameBoxTall', 'OfferImageTall', 'DieselStoreFrontTall')].filter(Boolean),
    wides: [pick('DieselGameBox', 'OfferImageWide', 'DieselStoreFrontWide', 'Thumbnail')].filter(Boolean)
  };
}

function isGame(item) {
  if (item.mainGameItem?.id) return false; // DLC / Zusatzinhalt (Hauptspiele haben hier eine leere id)
  const cats = (item.categories || []).map((c) => String(c.path || c).toLowerCase());
  if (cats.some((c) => c === 'addons' || c.startsWith('addons/') || c === 'digitalextras' || c === 'plugins')) return false;
  // Nur echte Spiele – Programme wie Twinmotion oder die Unreal Engine haben keine Kategorie "games"
  return cats.includes('games') && !cats.includes('software');
}

/** Alle Spiele aus dem lokalen Katalog-Cache. */
async function readCatalog() {
  let raw = null;
  for (const file of catalogPaths()) { raw = await readText(file); if (raw) break; }
  if (!raw) return [];
  let items;
  try {
    items = JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  // Epic speichert ™/® im Cache teils als "?" – vor Leerzeichen/Doppelpunkt/Ende entfernen
  const clean = (t) => String(t).replace(/\?(?=[\s:]|$)/g, '').trim();
  return items.filter((it) => it && it.id && it.title).map((it) => ({
    item: it,
    itemId: it.id,
    namespace: it.namespace,
    appName: (it.releaseInfo || []).map((r) => r.appId).find(Boolean),
    title: clean(it.title),
    game: isGame(it),
    images: imagesOf(it)
  }));
}

/** Plattformen aus dem Katalog ("Windows", "Win32", "Mac") – undefined, wenn Epic nichts angibt */
function platformsOf(item) {
  const list = (item?.releaseInfo || []).flatMap((r) => r.platform || []).map((x) => String(x).toLowerCase());
  if (!list.length) return undefined;
  return { windows: list.some((x) => x.startsWith('win')), mac: list.includes('mac'), linux: list.includes('linux') };
}

const launcherUri = (ns, item, app, action) =>
  `com.epicgames.launcher://apps/${ns}%3A${item}%3A${app}?action=${action}` + (action === 'launch' ? '&silent=true' : '');

// Größe je Update nur einmal berechnen (Manifest-Vergleich dauert ~0,3 s)
const sizeCache = new Map();

/** Gewählte Install-Tags je App aus dem Launcher-Protokoll ("CreateInstallRequest: ... tags=[...]") */
async function tagsFromLog() {
  const local = env('LOCALAPPDATA');
  const logs = isMac
    ? [path.join(home, 'Library', 'Logs', 'EpicGamesLauncher', 'EpicGamesLauncher.log'),
      macSupport('Epic', 'EpicGamesLauncher', 'Saved', 'Logs', 'EpicGamesLauncher.log')]
    : [local && path.join(local, 'EpicGamesLauncher', 'Saved', 'Logs', 'EpicGamesLauncher.log')];
  let text = null;
  for (const l of logs.filter(Boolean)) { text = await readText(l); if (text) break; }
  const out = new Map();
  if (!text) return out;
  for (const m of text.matchAll(/CreateInstallRequest: (\S+) components=\d+ tags=\d+ \[([^\]]*)\]/g)) {
    out.set(m[1], new Set(m[2].split(',')));
  }
  return out;
}

function downloadSize(m, tags) {
  const key = `${m.PendingManifestPath}|${m.AppVersionString}`;
  if (sizeCache.has(key)) return sizeCache.get(key);
  let size = null;
  try {
    const appId = `${m.CatalogNamespace}:${m.CatalogItemId}:${m.AppName}`;
    if (m.PendingManifestPath && require('fs').existsSync(m.PendingManifestPath)) {
      size = require('../lib/epicManifest').updateSize(m.CompleteManifestPath, m.PendingManifestPath, tags.get(appId) || null);
    }
  } catch { size = null; }
  sizeCache.set(key, size);
  return size;
}

/**
 * Wartende/laufende Downloads aus Manifests\Pending (Updates, Neuinstallationen, DLC-Inhalte).
 * Pro Hauptspiel zusammengefasst; Größe aus dem Manifest-Vergleich.
 * Epic speichert keinen Fortschritt – den misst Ludora über die Download-Rate (ioMeasure).
 */
async function pendingUpdates() {
  const dir = path.join(epicDataDir(), 'Manifests');
  const read = async (d) => {
    const out = [];
    for (const f of (await listDir(d)).filter((x) => x.toLowerCase().endsWith('.item'))) {
      const m = await readJson(path.join(d, f));
      if (m?.AppName) out.push(m);
    }
    return out;
  };
  const main = await read(dir);
  const pending = await read(path.join(dir, 'Pending'));
  if (!pending.length && !main.some((m) => m.bIsIncompleteInstall)) return new Map();
  const complete = new Set([
    ...main.filter((m) => !m.bIsIncompleteInstall || wasInstalled(m)),
    ...pending.filter(wasInstalled)
  ].map((m) => m.AppName));
  const tags = pending.length ? await tagsFromLog() : new Map();

  const out = new Map();
  const entries = [
    ...main.filter((m) => m.bIsIncompleteInstall && !pending.some((p) => p.AppName === m.AppName)),
    ...pending
  ];
  for (const m of entries) {
    const mainApp = m.MainGameAppName || m.AppName;
    const isDlc = mainApp !== m.AppName;
    const size = downloadSize(m, tags) || (complete.has(m.AppName) ? 0 : Number(m.InstallSize) || 0);
    const cur = out.get(mainApp) || { state: 'downloading', ioMeasure: true, bytesTotal: 0, parts: [] };
    cur.bytesTotal += size || 0;
    cur.parts.push(isDlc ? m.DisplayName : t("Spiel"));
    if (!isDlc && !complete.has(m.AppName)) cur.firstInstall = true;
    out.set(mainApp, cur);
  }
  for (const u of out.values()) {
    const dlc = u.parts.filter((x) => x !== 'Spiel');
    u.detail = dlc.length ? (u.parts.includes('Spiel') ? `inkl. ${dlc.length} Zusatzinhalt${dlc.length > 1 ? 'e' : ''}` : dlc.join(', ')) : undefined;
    if (!u.bytesTotal) delete u.bytesTotal;
    delete u.parts;
  }
  return out;
}

/**
 * Liegt ein Spiel nur unter Manifests\Pending, war es trotzdem schon installiert, wenn Epic
 * die bisherige Version vermerkt hat (CompleteVersion / CompleteManifestPath). So ist es
 * während eines Updates: Epic nimmt die .item-Datei solange aus dem normalen Ordner.
 */
function wasInstalled(m) {
  if (!m) return false;
  if (m.CompleteVersion && String(m.CompleteVersion).trim()) return true;
  try { return !!(m.CompleteManifestPath && require('fs').existsSync(m.CompleteManifestPath)); } catch { return false; }
}

/**
 * Epics Download-Manager legt seinen Zustand in Data\DownloadManager\DownloadState_<Konto>.json ab.
 * Das genaue Format ist nicht dokumentiert -> wir suchen pro Spiel nach bekannten Feldnamen
 * (Fortschritt, geladene/gesamte Bytes, Rate, Restzeit). Was fehlt, misst Ludora selbst.
 */
function readDownloadStateJson(data) {
  const out = new Map();
  const num = (o, re) => {
    for (const [k, v] of Object.entries(o)) if (re.test(k) && Number.isFinite(Number(v)) && typeof v !== 'boolean') return Number(v);
    return undefined;
  };
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1)); return; }
    const app = o.AppName || o.appName || o.ArtifactId || o.artifactId
      || (typeof o.AppId === 'string' ? o.AppId.split(':').pop() : undefined)
      || (typeof o.appId === 'string' ? o.appId.split(':').pop() : undefined);
    if (app) {
      let progress = num(o, /^(progress|percent(age)?|downloadProgress|totalProgress)$/i);
      if (progress !== undefined && progress > 1) progress /= 100;
      const done = num(o, /^(bytesDownloaded|downloadedBytes|bytesDone|currentBytes|downloaded)$/i);
      const total = num(o, /^(bytesTotal|totalBytes|downloadSize|totalDownloadSize|bytesToDownload)$/i);
      const speed = num(o, /^(downloadSpeed|downloadRate|bytesPerSecond|speed|rate)$/i);
      const eta = num(o, /^(eta|etaSeconds|timeRemaining|remainingTime|secondsRemaining)$/i);
      if ([progress, done, speed, eta].some((x) => x !== undefined)) {
        out.set(String(app), {
          progress: progress !== undefined ? Math.max(0, Math.min(1, progress)) : total && done !== undefined ? done / total : undefined,
          bytesDone: done, bytesTotal: total, speed, eta
        });
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(data);
  return out;
}

async function downloadState() {
  const dir = path.join(epicDataDir(), 'DownloadManager');
  const out = new Map();
  for (const f of (await listDir(dir)).filter((x) => /^DownloadState.*\.json$/i.test(x))) {
    for (const [k, v] of readDownloadStateJson(await readJson(path.join(dir, f)))) out.set(k, v);
  }
  return out;
}

async function updates() {
  const pending = await pendingUpdates();
  const live = pending.size ? await downloadState().catch(() => new Map()) : new Map();
  return [...pending].map(([nativeId, update]) => {
    const l = live.get(nativeId);
    if (!l) return { nativeId, update };
    // Werte direkt von Epic -> keine eigene Messung nötig
    const merged = { ...update, ...Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined)), source: 'Epic' };
    if (l.progress !== undefined || l.bytesDone !== undefined) delete merged.ioMeasure;
    return { nativeId, update: merged };
  });
}

async function detect() {
  const dir = path.join(epicDataDir(), 'Manifests');
  const files = (await listDir(dir)).filter((f) => f.toLowerCase().endsWith('.item'));

  const catalog = await readCatalog();
  const byItem = new Map(catalog.map((c) => [c.itemId, c]));
  const byApp = new Map(catalog.filter((c) => c.appName).map((c) => [c.appName, c]));

  const pending = await pendingUpdates();
  const games = [];
  const installedApps = new Set();
  const installedNames = new Set();

  // Normale Einträge + Spiele, die gerade ein Update bekommen (liegen dann nur unter Pending)
  const items = [];
  for (const file of files) items.push(await readJson(path.join(dir, file)));
  const have = new Set(items.filter(Boolean).map((m) => m.AppName));
  for (const file of (await listDir(path.join(dir, 'Pending'))).filter((f) => f.toLowerCase().endsWith('.item'))) {
    const m = await readJson(path.join(dir, 'Pending', file));
    if (m?.AppName && !have.has(m.AppName) && wasInstalled(m)) { items.push(m); have.add(m.AppName); }
  }

  for (const m of items) {
    if (!m || !m.AppName) continue;

    // DLCs und Zusatzinhalte ausblenden
    if (m.MainGameAppName && m.MainGameAppName !== m.AppName) continue;
    const cats = (m.AppCategories || []).map((c) => String(c).toLowerCase());
    if (cats.length && !cats.includes('games') && !cats.includes('applications')) continue;
    if (cats.includes('addons') || cats.includes('plugins')) continue;

    const ns = m.CatalogNamespace || m.MainGameCatalogNamespace;
    const item = m.CatalogItemId || m.MainGameCatalogItemId;
    const cat = byItem.get(item) || byApp.get(m.AppName);
    installedApps.add(m.AppName);
    if (item) installedApps.add(item);
    installedNames.add(normalize(m.DisplayName || ''));

    games.push({
      nativeId: m.AppName,
      epicItem: item,
      name: m.DisplayName || m.AppName,
      installDir: m.InstallLocation,
      sizeBytes: Number(m.InstallSize) || undefined,
      status: 'installed',
      update: pending.get(m.AppName) || null,
      ...(cat ? cat.images : { covers: [] }),
      // silent=true: Epic startet im Hintergrund, ohne sein Fenster nach vorne zu holen
      launch: {
        type: 'uri',
        target: ns && item ? launcherUri(ns, item, m.AppName, 'launch')
          : `com.epicgames.launcher://apps/${m.AppName}?action=launch&silent=true`
      }
    });
  }

  // Besessen, aber nicht installiert
  const seen = new Set();
  for (const c of catalog) {
    if (!c.game || !c.appName || !c.namespace) continue;
    if (/(\bbeta\b|experimental|playtest|public test|test server)/i.test(c.title)) continue;
    if (installedApps.has(c.appName) || installedApps.has(c.itemId)) continue;
    const key = normalize(c.title);
    if (installedNames.has(key) || seen.has(key)) continue;
    seen.add(key);
    games.push({
      nativeId: c.appName,
      epicItem: c.itemId,
      name: c.title,
      status: 'notInstalled',
      platforms: platformsOf(c.item),
      ...c.images,
      launch: { type: 'uri', target: launcherUri(c.namespace, c.itemId, c.appName, 'install') }
    });
  }

  return games;
}

async function findEpicExe() {
  if (isMac) return firstExisting(['/Applications/Epic Games Launcher.app', path.join(home, 'Applications', 'Epic Games Launcher.app')]);
  const pf86 = env('ProgramFiles(x86)') || 'C:\\Program Files (x86)';
  const pf = env('ProgramFiles') || 'C:\\Program Files';
  const rel = ['Epic Games', 'Launcher', 'Portal', 'Binaries'];
  return firstExisting([
    path.join(pf86, ...rel, 'Win64', 'EpicGamesLauncher.exe'),
    path.join(pf86, ...rel, 'Win32', 'EpicGamesLauncher.exe'),
    path.join(pf, ...rel, 'Win64', 'EpicGamesLauncher.exe')
  ]);
}

module.exports = {
  _platformsOf: platformsOf,
  _readDownloadStateJson: readDownloadStateJson,
  _wasInstalled: wasInstalled,
  id: 'epic',
  platforms: ['win32', 'darwin'],
  processes: ['EpicGamesLauncher', 'EpicWebHelper'],
  processesMac: ['EpicGamesLauncher', 'Epic Games Launcher', 'EpicWebHelper'],
  updates,
  // Hintergrund-Update: Launcher mit -silent (nur Tray) – er lädt anstehende Updates selbst
  backgroundUpdate: async () => exeLaunch(await findEpicExe(), isMac ? [] : ['-silent']),
  // Ohne silent=true, damit Epic sichtbar aktualisiert
  updatePage: (game) => ({ type: 'uri', target: game.launch.target.replace('&silent=true', '') }),
  client: async () => exeLaunch(await findEpicExe()) || { type: 'uri', target: 'com.epicgames.launcher://store' },
  store: { type: 'uri', target: 'com.epicgames.launcher://store' },
  name: 'Epic Games',
  color: '#2a2a2a',
  accent: '#f5f5f5',
  detect,
  readCatalog,
  epicDataDir,
  findEpicExe,
  uninstallSilent: (game) => require('../lib/silentUninstall').epicUninstall(game, module.exports)
};
