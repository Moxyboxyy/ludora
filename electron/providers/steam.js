// Steam
//
// Installierte Spiele: libraryfolders.vdf + appmanifest_*.acf
// Ganze Bibliothek (ohne API-Key): Steams lokaler Cache
//   - appcache/librarycache/<appid>   -> Bilder für alle Spiele in deiner Bibliothek
//   - userdata/<id>/config/localconfig.vdf -> Spielzeit + zuletzt gespielt
//   - appcache/appinfo.vdf            -> Name und Typ (nur echte Spiele, keine Tools/DLCs)
// Optional mit API-Key: offizielle Liste über die Steam Web API.
const { t } = require('../lib/i18n.js');
const path = require('path');
const reg = require('../lib/registry');
const settings = require('../lib/settings');
const { parseVdf, getCI } = require('../lib/vdf');
const { readAppInfo } = require('../lib/appinfo');
const { isWin, isMac, home, macSupport } = require('../lib/platform');
const { exists, readText, listDir, exeLaunch } = require('../lib/util');

// Werkzeuge, Redistributables, Proton usw. ausblenden
const IGNORED_APPIDS = new Set([
  '228980', // Steamworks Common Redistributables
  '1070560', '1391110', '1628350', // Steam Linux Runtime
  '250820', // SteamVR
  '1493710', '2180100', '2348590' // Proton
]);
const IGNORED_NAME = /^(Steamworks|Proton|Steam Linux Runtime|SteamVR)/i;
// Test-Server, Betas und Playtests sind eigene "Spiele" in Steam, aber keine echten
const TEST_APP = /(public test|test server|\bpts\b|playtest|\bbeta\b|unstable|experimental|dedicated server)/i;
const STEAMID64_BASE = 76561197960265728n;

let steamPathCache;
async function findSteamPath() {
  if (steamPathCache !== undefined) return steamPathCache;
  if (!isWin) {
    // macOS: ~/Library/Application Support/Steam, Linux: ~/.steam/steam bzw. ~/.local/share/Steam
    const candidates = isMac
      ? [macSupport('Steam')]
      : [path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam'),
        path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')];
    for (const c of candidates) if (await exists(path.join(c, 'steamapps'))) return (steamPathCache = c);
    return (steamPathCache = null);
  }
  const p = await reg.getFirstValue([
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath']
  ]);
  if (p) return (steamPathCache = path.normalize(p));
  const fallback = 'C:\\Program Files (x86)\\Steam';
  return (steamPathCache = (await exists(fallback)) ? fallback : null);
}

async function getLibraryFolders(steamPath) {
  const folders = new Set([path.join(steamPath, 'steamapps')]);
  const vdfText = await readText(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'));
  if (vdfText) {
    const root = getCI(parseVdf(vdfText), 'libraryfolders') || {};
    for (const entry of Object.values(root)) {
      // Neues Format: { path: "..." }, altes Format: direkt der Pfad
      const p = typeof entry === 'string' ? entry : getCI(entry, 'path');
      if (p && /[\\/]/.test(p)) folders.add(path.join(path.normalize(p), 'steamapps'));
    }
  }
  return [...folders];
}

/** SteamID64 des zuletzt angemeldeten Kontos aus loginusers.vdf */
async function findSteamId(steamPath) {
  const text = await readText(path.join(steamPath, 'config', 'loginusers.vdf'));
  if (!text) return null;
  const users = getCI(parseVdf(text), 'users') || {};
  const ids = Object.keys(users);
  return ids.find((id) => getCI(users[id], 'MostRecent') === '1') || ids[0] || null;
}

// ---------- Bilder aus Steams lokalem Cache ----------

const IMAGE_FILES = {
  tall: ['library_600x900_2x.jpg', 'library_600x900.jpg', 'library_capsule.jpg'],
  wide: ['header.jpg', 'library_header.jpg', 'library_hero.jpg']
};

/**
 * Pfad zu einem gecachten Bild, oder null.
 * Steam nutzt je nach Version librarycache/<id>_library_600x900.jpg
 * oder librarycache/<id>/[<hash>/]library_600x900.jpg.
 */
async function findCachedImage(appid, kind) {
  const steamPath = await findSteamPath();
  if (!steamPath || !/^\d+$/.test(appid) || !IMAGE_FILES[kind]) return null;
  const cache = path.join(steamPath, 'appcache', 'librarycache');
  const dir = path.join(cache, appid);

  for (const name of IMAGE_FILES[kind]) {
    const flat = path.join(cache, `${appid}_${name}`);
    if (await exists(flat)) return flat;
    const direct = path.join(dir, name);
    if (await exists(direct)) return direct;
  }
  // Unterordner mit Hash-Namen
  for (const sub of await listDir(dir)) {
    for (const name of IMAGE_FILES[kind]) {
      const p = path.join(dir, sub, name);
      if (await exists(p)) return p;
    }
  }
  return null;
}

function steamCovers(appid) {
  return {
    covers: [
      `ghimg://steam/${appid}/tall`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`
    ],
    wides: [
      `ghimg://steam/${appid}/wide`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`
    ]
  };
}

// ---------- Bibliothek ohne API-Key ----------

async function readLocalConfig(steamPath, steamId) {
  if (!steamId) return {};
  const accountId = String(BigInt(steamId) - STEAMID64_BASE);
  const text = await readText(path.join(steamPath, 'userdata', accountId, 'config', 'localconfig.vdf'));
  if (!text) return {};
  const root = getCI(parseVdf(text), 'UserLocalConfigStore');
  const steam = getCI(getCI(getCI(root, 'Software'), 'Valve'), 'Steam');
  return getCI(steam, 'apps') || {};
}

async function libraryCacheIds(steamPath) {
  const ids = new Set();
  for (const entry of await listDir(path.join(steamPath, 'appcache', 'librarycache'))) {
    const m = entry.match(/^(\d+)(?:_|$)/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

async function ownedFromLocalCache(steamPath, localApps) {
  const candidates = await libraryCacheIds(steamPath);
  for (const id of Object.keys(localApps)) candidates.add(id);
  if (!candidates.size) return [];

  const info = await readAppInfo(path.join(steamPath, 'appcache', 'appinfo.vdf'), candidates);
  const out = [];
  for (const [appid, { name, type }] of info) {
    if (type !== 'game' || !name) continue;
    out.push({ appid, name });
  }
  return out;
}

// ---------- Bibliothek mit API-Key (optional) ----------

async function ownedFromApi(apiKey, steamId) {
  const url = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/' +
    `?key=${encodeURIComponent(apiKey)}&steamid=${encodeURIComponent(steamId)}` +
    '&include_appinfo=1&include_played_free_games=1&format=json';
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new Error(t("Steam-API nicht erreichbar ({0})", [err.name === 'TimeoutError' ? t("Zeitüberschreitung") : err.message]));
  }
  if (res.status === 401 || res.status === 403) throw new Error(t("Steam-API-Key ungültig"));
  if (!res.ok) throw new Error(t("Steam-API antwortet mit Fehler {0}", [res.status]));
  const list = (await res.json())?.response?.games;
  if (!list) throw new Error(t("Keine Spiele von Steam erhalten – Spieldetails im Profil auf privat?"));
  return list.map((g) => ({
    appid: String(g.appid),
    name: g.name,
    playtimeMin: g.playtime_forever,
    lastPlayed: g.rtime_last_played || undefined
  }));
}

// ---------- Updates & Downloads ----------

// Bits aus appmanifest "StateFlags"
const F = { UpdateRequired: 2, FullyInstalled: 4, UpdateRunning: 256, UpdatePaused: 512, UpdateStarted: 1024 };

/** Update-Zustand aus einem appmanifest: null = aktuell */
function updateState(state) {
  const flags = parseInt(getCI(state, 'StateFlags') || '0', 10);
  const total = Number(getCI(state, 'BytesToDownload')) || 0;
  const done = Number(getCI(state, 'BytesDownloaded')) || 0;
  const progress = total > 0 ? Math.min(1, done / total) : undefined;
  const installing = !(flags & F.FullyInstalled);
  if (flags & (F.UpdateRunning | F.UpdateStarted)) {
    return { state: 'downloading', progress, bytesDone: done, bytesTotal: total, firstInstall: installing };
  }
  if (flags & F.UpdatePaused) return { state: 'paused', progress, bytesDone: done, bytesTotal: total, firstInstall: installing };
  if (flags & F.UpdateRequired || (total > 0 && done < total)) {
    return { state: installing ? 'queued' : 'available', progress, bytesDone: done, bytesTotal: total, firstInstall: installing };
  }
  return null;
}

/** Alle appmanifests lesen (schnell, wird auch für die Download-Ansicht alle paar Sekunden genutzt). */
async function readManifests(steamPath) {
  const out = [];
  for (const lib of await getLibraryFolders(steamPath)) {
    const files = (await listDir(lib)).filter((f) => /^appmanifest_\d+\.acf$/i.test(f));
    for (const file of files) {
      const text = await readText(path.join(lib, file));
      if (!text) continue;
      const state = getCI(parseVdf(text), 'AppState');
      if (state) out.push({ lib, state });
    }
  }
  return out;
}

/**
 * Steams eigene Download-Geschwindigkeit aus logs/content_log.txt.
 * Steam schreibt dort etwa jede Minute "Current download rate: 51.137 Mbps" und beim Start
 * jedes Downloads "AppID 123 update started : download 0/1042127296, ...".
 */
const progressMemo = new Map(); // Download -> höchster angezeigter Stand

function parseContentLog(text, now = Date.now()) {
  const lines = String(text).split(/\r?\n/);
  const ts = (l) => {
    const m = l.match(/^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\]/);
    return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
  };

  // Letzter gestarteter Download: "AppID 123 update started : download 0/1042127296, ..."
  let startIdx = -1;
  let appid = null;
  let total = 0;
  let initial = 0; // beim Fortsetzen: schon vorher geladen
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/AppID (\d+) update started : download (\d+)\/(\d+)/);
    if (m) { startIdx = i; appid = m[1]; initial = Number(m[2]) || 0; total = Number(m[3]) || 0; break; }
  }

  // Letzter gemeldeter Zustand je Spiel ("AppID 123 state changed : Update Required,Update Paused,")
  // und ob ein Download abgebrochen wurde – das Log ist aktueller als die appmanifest-Dateien.
  const states = new Map();
  for (const l of lines) {
    const m = l.match(/AppID (\d+) state changed : (.*)$/);
    if (m) states.set(m[1], m[2]);
  }

  // Seitdem geladene Bytes: Steam meldet alle ~30 s pro Download-Server
  // "stats: (SteamCache, 237) host: 20570512 Bytes, 30 sec (5.53 Mbps)"
  let done = initial;
  const batches = new Map(); // Zeitstempel -> { bytes, sec }
  let finished = false;
  for (let i = Math.max(0, startIdx); i < lines.length; i++) {
    const l = lines[i];
    if (startIdx >= 0 && appid && new RegExp(`AppID ${appid} (finished update|scheduler finished|update canceled|finished uninstall)`).test(l)) finished = true;
    const m = l.match(/stats: \(.*?\) .*?: (\d+) Bytes, (\d+) sec/);
    if (!m) continue;
    const bytes = Number(m[1]) || 0;
    if (startIdx >= 0) done += bytes;
    const t = ts(l);
    if (t) {
      const b = batches.get(t) || { bytes: 0, sec: 0 };
      b.bytes += bytes;
      b.sec = Math.max(b.sec, Number(m[2]) || 0);
      batches.set(t, b);
    }
  }

  // Geladene Bytes zusätzlich aus den Minuten-Raten hochrechnen ("Current download rate: 51.1 Mbps"
  // gilt jeweils für die Zeit seit der vorigen Meldung) – die Statistik-Zeilen schreibt Steam nicht immer.
  let integrated = 0;
  let lastRate = 0;
  let prevT = startIdx >= 0 ? ts(lines[startIdx]) : null;
  if (prevT) {
    for (let i = startIdx + 1; i < lines.length; i++) {
      const m = lines[i].match(/Current download rate: ([\d.]+) Mbps/);
      if (!m) continue;
      const t = ts(lines[i]);
      if (!t || t < prevT) continue;
      lastRate = (parseFloat(m[1]) * 1e6) / 8;
      integrated += lastRate * ((t - prevT) / 1000);
      prevT = t;
    }
    // Seit der letzten Meldung mit der letzten Rate weiterzählen (höchstens 70 s)
    if (!finished) integrated += lastRate * (Math.min(70000, Math.max(0, now - prevT)) / 1000);
  }
  done = Math.max(done, initial + integrated);
  if (!finished && total) done = Math.min(done, total * 0.99);

  // Geschwindigkeit: jüngste Statistik-Runde (genauer als die Minuten-Rate), sonst "Current download rate"
  let speed = null;
  const lastT = Math.max(0, ...batches.keys());
  if (lastT && now - lastT < 90000) {
    const b = batches.get(lastT);
    speed = b.sec > 0 ? b.bytes / b.sec : null;
  }
  if (speed === null) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/Current download rate: ([\d.]+) Mbps/);
      if (!m) continue;
      const t = ts(lines[i]);
      speed = t && now - t < 150000 ? (parseFloat(m[1]) * 1e6) / 8 : 0;
      break;
    }
  }
  // Nie rückwärts: bereits angezeigter Fortschritt bleibt (Hochrechnung kann leicht überschießen)
  const key = startIdx >= 0 ? `${appid}@${lines[startIdx].slice(0, 21)}` : null;
  if (key) {
    done = Math.max(done, progressMemo.get(key) || 0);
    progressMemo.set(key, done);
    if (progressMemo.size > 20) progressMemo.delete(progressMemo.keys().next().value);
  }
  return {
    speed,
    appid,
    bytesDone: startIdx >= 0 && total ? Math.min(done, total) : undefined,
    bytesTotal: total || undefined,
    finished,
    states
  };
}

async function steamLogInfo(steamPath) {
  const file = path.join(steamPath, 'logs', 'content_log.txt');
  try {
    const fh = await require('fs').promises.open(file, 'r');
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      return parseContentLog(buf.toString('utf8'));
    } finally { await fh.close(); }
  } catch { return { speed: null, appid: null, states: new Map() }; }
}

/** Nur Update-Zustände (für die Download-Ansicht) */
async function updates() {
  const steamPath = await findSteamPath();
  if (!steamPath) return [];
  const raw = (await readManifests(steamPath))
    .map(({ state }) => ({ nativeId: String(getCI(state, 'appid')), update: updateState(state) }))
    .filter((u) => u.update);
  if (!raw.length) return [];
  const log = await steamLogInfo(steamPath);
  const list = [];
  for (const u of raw) {
    const st = log.states?.get(u.nativeId);
    if (st !== undefined) {
      // Abgebrochen und entfernt -> gar nicht mehr anzeigen
      if (/\bUninstalled\b|\bUninstalling\b/.test(st) && !/Fully Installed/.test(st)) continue;
      // Steam lädt laut Log nicht (mehr) -> nicht als "lädt" zeigen, egal was in appmanifest steht
      if (u.update.state === 'downloading' && !/Update Running/.test(st)) {
        u.update = { ...u.update, state: /Update Paused|Suspended|Canceled/.test(st) ? 'paused' : /Update Queued/.test(st) ? 'queued' : 'available' };
      }
      // Ganz aktuell (z. B. Update fertig), appmanifest aber noch alt
      if (/^Fully Installed,?\s*$/.test(st.trim())) continue;
    }
    list.push(u);
  }
  const running = list.filter((u) => u.update.state === 'downloading');
  if (running.length) {
    // Steam lädt immer nur ein Spiel gleichzeitig -> die Rate gehört zum zuletzt gestarteten
    const target = running.find((u) => u.nativeId === log.appid) || running[0];
    const u = { ...target.update };
    // Fortschritt aus dem Log, wenn er zu diesem Download gehört (die appmanifest-Werte hinken oft hinterher)
    if (log.appid === target.nativeId && log.bytesTotal && !log.finished) {
      u.bytesTotal = log.bytesTotal;
      u.bytesDone = Math.max(log.bytesDone || 0, u.bytesTotal === target.update.bytesTotal ? target.update.bytesDone || 0 : 0);
      u.progress = Math.min(1, u.bytesDone / u.bytesTotal);
    }
    if (log.speed !== null) {
      const remaining = u.bytesTotal ? Math.max(0, u.bytesTotal - (u.bytesDone || 0)) : null;
      u.speed = log.speed;
      u.eta = log.speed > 0 && remaining !== null ? remaining / log.speed : null;
      u.source = 'Steam';
    }
    target.update = u;
  }
  return list;
}

// ---------- Hauptfunktion ----------

async function detect() {
  steamPathCache = undefined;
  const steamPath = await findSteamPath();
  if (!steamPath) return [];

  const steamExe = await findSteamExe();
  const games = new Map();
  for (const { lib, state } of await readManifests(steamPath)) {
    {
      const appid = String(getCI(state, 'appid'));
      const name = getCI(state, 'name') || `App ${appid}`;
      if (IGNORED_APPIDS.has(appid) || IGNORED_NAME.test(name)) continue;

      games.set(appid, {
        nativeId: appid,
        name,
        installDir: path.join(lib, 'common', getCI(state, 'installdir') || ''),
        sizeBytes: Number(getCI(state, 'SizeOnDisk')) || undefined,
        status: 'installed',
        update: updateState(state),
        ...steamCovers(appid),
        // -silent: Steam startet nur im Tray, -applaunch: direkt das Spiel
        // Mac/Linux: über steam:// (Ludora startet es dort mit "open -g" im Hintergrund)
        launch: isWin && steamExe
          ? exeLaunch(steamExe, ['-silent', '-applaunch', appid])
          : { type: 'uri', target: `steam://rungameid/${appid}` }
      });
    }
  }

  const steamId = (settings.get('steamId') || '').trim() || (await findSteamId(steamPath));
  const localApps = await readLocalConfig(steamPath, steamId).catch(() => ({}));

  // Spielzeit + zuletzt gespielt aus localconfig.vdf
  const stats = (appid) => {
    const a = localApps[appid];
    if (!a) return {};
    const min = parseInt(getCI(a, 'Playtime') || getCI(a, 'playtime') || '0', 10);
    const last = parseInt(getCI(a, 'LastPlayed') || '0', 10);
    return { playtimeMin: min || undefined, lastPlayed: last || undefined };
  };

  let warning = null;
  let owned = [];
  const apiKey = (settings.get('steamApiKey') || '').trim();
  try {
    owned = apiKey && steamId
      ? await ownedFromApi(apiKey, steamId)
      : await ownedFromLocalCache(steamPath, localApps);
  } catch (err) {
    warning = err.message;
    if (apiKey) owned = await ownedFromLocalCache(steamPath, localApps).catch(() => []);
  }

  for (const g of games.values()) Object.assign(g, stats(g.nativeId));

  for (const o of owned) {
    const existing = games.get(o.appid);
    if (existing) {
      if (o.playtimeMin) existing.playtimeMin = o.playtimeMin;
      if (o.lastPlayed) existing.lastPlayed = o.lastPlayed;
      continue;
    }
    if (IGNORED_APPIDS.has(o.appid) || IGNORED_NAME.test(o.name || '') || TEST_APP.test(o.name || '')) continue;
    games.set(o.appid, {
      nativeId: o.appid,
      name: o.name || `App ${o.appid}`,
      status: 'notInstalled',
      ...stats(o.appid),
      ...(o.playtimeMin ? { playtimeMin: o.playtimeMin } : {}),
      ...(o.lastPlayed ? { lastPlayed: o.lastPlayed } : {}),
      ...steamCovers(o.appid),
      // Öffnet den Steam-Installationsdialog
      launch: { type: 'uri', target: `steam://install/${o.appid}` }
    });
  }

  const result = [...games.values()];
  result.warning = warning;
  return result;
}

async function findSteamExe() {
  if (isMac) return (await exists('/Applications/Steam.app')) ? '/Applications/Steam.app' : null;
  if (!isWin) return null;
  const steamPath = await findSteamPath();
  if (!steamPath) return null;
  const exe = path.join(steamPath, 'steam.exe');
  return (await exists(exe)) ? exe : null;
}

module.exports = {
  _parseContentLog: parseContentLog,
  id: 'steam',
  platforms: ['win32', 'darwin', 'linux'],
  processes: ['steam', 'steamwebhelper'],
  processesMac: ['Steam', 'steam_osx', 'Steam Helper'],
  updates,
  // Hintergrund-Update: Steam nur im Tray starten – es arbeitet die Update-Warteschlange selbst ab
  downloadsPage: () => ({ type: 'uri', target: 'steam://open/downloads' }),
  backgroundUpdate: async () => {
    const exe = await findSteamExe();
    return isWin ? exeLaunch(exe, ['-silent']) : exe ? exeLaunch(exe) : { type: 'uri', target: 'steam://open/downloads' };
  },
  // Sichtbar (über "Öffnen" im Download-Fenster): Spielseite in Steam
  uninstall: (game) => ({ type: 'uri', target: `steam://uninstall/${game.nativeId}` }),
  updatePage: (game) => ({ type: 'uri', target: `steam://nav/games/details/${game.nativeId}` }),
  client: async () => exeLaunch(await findSteamExe()) || { type: 'uri', target: 'steam://open/main' },
  store: { type: 'uri', target: 'steam://store' },
  name: 'Steam',
  color: '#1b2838',
  accent: '#66c0f4',
  detect,
  findSteamPath,
  findSteamId,
  findCachedImage,
  getLibraryFolders,
  findSteamExe,
  uninstallSilent: (game) => require('../lib/silentUninstall').steamUninstall(game, module.exports)
};
