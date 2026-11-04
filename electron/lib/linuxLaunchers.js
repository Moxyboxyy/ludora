// Linux: Spiele aus Heroic Games Launcher und Lutris lesen.
//
// Unter Linux gibt es Epic, GOG, Amazon, Battle.net, EA, Ubisoft und Rockstar nicht als eigene Launcher.
// Linux-Spieler nutzen dafür:
//   Heroic  (Epic über "legendary", GOG über "gogdl", Amazon über "nile")
//   Lutris  (Battle.net, EA app, Ubisoft Connect, Rockstar & Co. per Wine)
// Beide legen ihre Bibliothek als lesbare Dateien ab – normal oder als Flatpak installiert.
// Gestartet wird über deren Protokolle: heroic://launch?… bzw. lutris:rungameid/<id>.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('./sqlite');

const home = () => process.env.LUDORA_TEST_HOME || os.homedir();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

// ---------- Heroic ----------
function heroicDirs() {
  const h = home();
  return [
    path.join(process.env.XDG_CONFIG_HOME || path.join(h, '.config'), 'heroic'),
    path.join(h, '.var', 'app', 'com.heroicgameslauncher.hgl', 'config', 'heroic')
  ].filter(exists);
}

/** Heroic: welche Variante ist installiert (für "Heroic öffnen")? */
function heroicCommand() {
  const h = home();
  if (exists(path.join(h, '.var', 'app', 'com.heroicgameslauncher.hgl'))) {
    return { cmd: 'flatpak', args: ['run', 'com.heroicgameslauncher.hgl'] };
  }
  for (const p of ['/usr/bin/heroic', '/opt/Heroic/heroic', '/usr/local/bin/heroic']) if (exists(p)) return { cmd: p, args: [] };
  return heroicDirs().length ? { cmd: 'heroic', args: [] } : null;
}

const RUNNER = { epic: 'legendary', gog: 'gog', amazon: 'nile' };

/** Einträge aus den Heroic-Bibliotheks-Caches (Felder sind bei allen drei Runnern gleich) */
function libraryEntries(dir, store) {
  const file = {
    epic: ['store_cache/legendary_library.json', 'lib-cache/library.json'],
    gog: ['store_cache/gog_library.json', 'gog_store/library.json'],
    amazon: ['store_cache/nile_library.json', 'nile_store/library.json']
  }[store];
  for (const f of file) {
    const j = readJson(path.join(dir, f));
    const list = j && (j.library || j.games || (Array.isArray(j) ? j : null));
    if (Array.isArray(list) && list.length) return list;
  }
  return [];
}

/** Installierte Spiele laut Runner-Konfiguration: appName -> Installationsordner */
function installedMap(dir, store) {
  const out = new Map();
  if (store === 'epic') {
    const j = readJson(path.join(dir, 'legendaryConfig', 'legendary', 'installed.json'));
    for (const [k, v] of Object.entries(j || {})) if (v && !v.is_dlc) out.set(k, v.install_path || '');
  } else if (store === 'gog') {
    const j = readJson(path.join(dir, 'gog_store', 'installed.json'));
    for (const v of j?.installed || []) if (v?.appName) out.set(String(v.appName), v.install_path || '');
  } else if (store === 'amazon') {
    const j = readJson(path.join(dir, 'nile_config', 'nile', 'installed.json'));
    for (const v of Array.isArray(j) ? j : []) if (v?.id) out.set(String(v.id), v.path || '');
  }
  return out;
}

/** Heroic-Spiele eines Stores ('epic' | 'gog' | 'amazon') */
function heroicGames(store) {
  const games = new Map();
  for (const dir of heroicDirs()) {
    const installed = installedMap(dir, store);
    for (const e of libraryEntries(dir, store)) {
      const appName = String(e.app_name || e.appName || e.id || '');
      if (!appName || e.is_dlc || e.install?.is_dlc) continue;
      if (games.has(appName)) continue;
      const installDir = installed.get(appName) ?? (e.is_installed ? e.install?.install_path || '' : null);
      games.set(appName, {
        nativeId: appName,
        name: e.title || appName,
        installDir: installDir || undefined,
        status: installDir !== null && installDir !== undefined ? 'installed' : 'notInstalled',
        covers: [e.art_square, e.art_cover].filter((u) => /^https:\/\//.test(u || '')),
        wides: [e.art_cover].filter((u) => /^https:\/\//.test(u || '')),
        launch: { type: 'uri', target: `heroic://launch?appName=${encodeURIComponent(appName)}&runner=${RUNNER[store]}` }
      });
    }
    // Installiert, aber (noch) nicht im Bibliotheks-Cache
    for (const [appName, dirPath] of installed) {
      if (games.has(appName)) continue;
      games.set(appName, {
        nativeId: appName,
        name: path.basename(dirPath || appName),
        installDir: dirPath || undefined,
        status: 'installed',
        covers: [],
        launch: { type: 'uri', target: `heroic://launch?appName=${encodeURIComponent(appName)}&runner=${RUNNER[store]}` }
      });
    }
  }
  // Nicht installierte Spiele öffnen Heroic selbst (dort installieren)
  for (const g of games.values()) if (g.status === 'notInstalled') g.launch = { type: 'heroic' };
  return [...games.values()];
}

// ---------- Lutris ----------
function lutrisDirs() {
  const h = home();
  const data = process.env.XDG_DATA_HOME || path.join(h, '.local', 'share');
  return [
    { data: path.join(data, 'lutris'), cache: path.join(h, '.cache', 'lutris') },
    { data: path.join(h, '.var', 'app', 'net.lutris.Lutris', 'data', 'lutris'), cache: path.join(h, '.var', 'app', 'net.lutris.Lutris', 'cache', 'lutris') }
  ].filter((d) => exists(path.join(d.data, 'pga.db')));
}

function lutrisCommand() {
  const h = home();
  if (exists(path.join(h, '.var', 'app', 'net.lutris.Lutris'))) return { cmd: 'flatpak', args: ['run', 'net.lutris.Lutris'] };
  for (const p of ['/usr/bin/lutris', '/usr/local/bin/lutris']) if (exists(p)) return { cmd: p, args: [] };
  return lutrisDirs().length ? { cmd: 'lutris', args: [] } : null;
}

// Lutris-Spiel -> Launcher, zu dem es gehört
const SERVICE = {
  battlenet: 'battlenet', ea_app: 'ea', origin: 'ea', ubisoft: 'ubisoft', ubisoftconnect: 'ubisoft',
  egs: 'epic', gog: 'gog', amazon: 'amazon', steam: 'steam'
};
// Die Launcher selbst (in Lutris als "Spiel" installiert)
const LAUNCHER_APPS = [
  ['battlenet', /^battle\.?net$/i],
  ['ea', /^(ea app|ea desktop|origin)$/i],
  ['ubisoft', /^(ubisoft connect|uplay)$/i],
  ['rockstar', /^rockstar games launcher$/i],
  ['epic', /^epic games( store| launcher)?$/i],
  ['gog', /^gog galaxy$/i],
  ['amazon', /^amazon games$/i]
];

function launcherOf(row) {
  const svc = SERVICE[String(row.service || '').toLowerCase()];
  if (svc) return svc;
  const s = `${row.installer_slug || ''} ${row.slug || ''} ${row.configpath || ''}`.toLowerCase();
  if (/battle-?net|blizzard/.test(s)) return 'battlenet';
  if (/ea-app|origin|ea-desktop/.test(s)) return 'ea';
  if (/ubisoft|uplay/.test(s)) return 'ubisoft';
  if (/rockstar/.test(s)) return 'rockstar';
  if (/epic-games|\begs\b/.test(s)) return 'epic';
  return 'lutris';
}

let lutrisCache = null; // pro Scan einmal lesen
async function lutrisRows() {
  if (lutrisCache && Date.now() - lutrisCache.t < 5000) return lutrisCache.rows;
  const rows = [];
  for (const d of lutrisDirs()) {
    const db = await openDb(path.join(d.data, 'pga.db'));
    if (!db) continue;
    try {
      if (!db.tables().has('games')) continue;
      const cols = db.columns('games');
      const pick = ['id', 'name', 'slug', 'installer_slug', 'runner', 'directory', 'installed', 'lastplayed', 'playtime', 'service', 'service_id', 'configpath', 'hidden']
        .filter((c) => cols.has(c));
      for (const r of db.all(`SELECT ${pick.map((c) => `"${c}"`).join(', ')} FROM games`)) rows.push({ ...r, _dir: d });
    } finally {
      db.close();
    }
  }
  lutrisCache = { t: Date.now(), rows };
  return rows;
}

/** Bild eines Lutris-Spiels: kind 'cover' (hochkant) oder 'banner' (breit) */
function lutrisImage(slug, kind) {
  if (!/^[a-z0-9._-]+$/i.test(slug || '')) return null;
  const sub = kind === 'banner' ? 'banners' : 'coverart';
  for (const d of [...lutrisDirs(), { data: path.join(home(), '.local', 'share', 'lutris'), cache: path.join(home(), '.cache', 'lutris') }]) {
    for (const base of [d.data, d.cache]) {
      for (const ext of ['jpg', 'png']) {
        const f = path.join(base, sub, `${slug}.${ext}`);
        if (exists(f)) return f;
      }
    }
  }
  return null;
}

/** Lutris-Spiele, die zu einem Launcher gehören ('lutris' = alle übrigen) */
async function lutrisGames(launcher) {
  const out = [];
  for (const r of await lutrisRows()) {
    if (Number(r.installed) !== 1 || Number(r.hidden) === 1) continue;
    if (LAUNCHER_APPS.some(([, re]) => re.test(r.name || ''))) continue; // die Launcher selbst nicht als Spiel
    if (launcherOf(r) !== launcher) continue;
    out.push({
      nativeId: `lutris-${r.id}`,
      name: r.name,
      installDir: r.directory || undefined,
      status: 'installed',
      covers: r.slug ? [`ghimg://lutris/${encodeURIComponent(r.slug)}/cover`] : [],
      wides: r.slug ? [`ghimg://lutris/${encodeURIComponent(r.slug)}/banner`] : [],
      playtimeMin: Number(r.playtime) > 0 ? Math.round(Number(r.playtime) * 60) : undefined, // Lutris: Stunden
      lastPlayed: Number(r.lastplayed) > 0 ? Number(r.lastplayed) : undefined,
      launch: { type: 'uri', target: `lutris:rungameid/${r.id}` }
    });
  }
  return out;
}

/** Ist der Launcher selbst in Lutris installiert? -> dessen Lutris-Starteintrag */
async function lutrisLauncherApp(launcher) {
  const re = LAUNCHER_APPS.find(([id]) => id === launcher)?.[1];
  if (!re) return null;
  const r = (await lutrisRows()).find((x) => Number(x.installed) === 1 && re.test(x.name || ''));
  return r ? { type: 'uri', target: `lutris:rungameid/${r.id}` } : null;
}

module.exports = {
  heroicGames, heroicCommand, heroicDirs, lutrisGames, lutrisCommand, lutrisDirs, lutrisImage, lutrisLauncherApp,
  _launcherOf: launcherOf, _clearCache: () => { lutrisCache = null; }
};
