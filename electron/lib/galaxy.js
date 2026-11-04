// GOG Galaxy 2.0 Datenbank: %ProgramData%\GOG.com\Galaxy\storage\galaxy-2.0.db
//
// Galaxy speichert dort alle Spiele, die du besitzt – nicht nur GOG, sondern auch
// die von verknüpften Plattformen (EA, Ubisoft, Battle.net, Rockstar, ...).
// Schlüssel sind "releaseKeys" wie gog_1207664663, uplay_635, battlenet_fen.
const { t } = require('./i18n.js');
const path = require('path');
const { openDb } = require('./sqlite');
const { env } = require('./util');
const { isMac, macShared } = require('./platform');

let cache = null; // pro Scan einmal lesen

function dbPath() {
  // macOS: /Users/Shared/GOG.com/Galaxy/Storage/galaxy-2.0.db
  if (isMac) return macShared('GOG.com', 'Galaxy', 'Storage', 'galaxy-2.0.db');
  const pd = env('PROGRAMDATA') || 'C:\\ProgramData';
  return path.join(pd, 'GOG.com', 'Galaxy', 'storage', 'galaxy-2.0.db');
}

/**
 * Installierte GOG-Spiele aus der Galaxy-Datenbank (für macOS, wo es keine Registry gibt).
 * [{ id, path }] – path kann fehlen, je nach Galaxy-Version.
 */
async function readInstalled() {
  const db = await openDb(dbPath());
  if (!db) return [];
  try {
    const tables = db.tables();
    if (!tables.has('InstalledBaseProducts')) return [];
    const cols = [...db.columns('InstalledBaseProducts')];
    const pathCol = cols.find((c) => /path|location|directory/i.test(c));
    return db.all(`SELECT productId AS id${pathCol ? `, "${pathCol}" AS path` : ''} FROM InstalledBaseProducts`)
      .map((r) => ({ id: String(r.id), path: r.path || null }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function parseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Liste aller besessenen Spiele:
 * [{ releaseKey, platform, id, name, covers, wides }]
 */
async function readOwned() {
  if (cache) return cache;
  cache = (async () => {
    const db = await openDb(dbPath());
    if (!db) return [];
    try {
      const tables = db.tables();
      if (!tables.has('GamePieces') || !tables.has('GamePieceTypes')) return [];

      // Welche Spiele gehören dem Nutzer?
      let keys = [];
      if (tables.has('ProductPurchaseDates')) {
        keys = db.all('SELECT DISTINCT gameReleaseKey AS k FROM ProductPurchaseDates').map((r) => r.k);
      }
      if (tables.has('LibraryReleases')) {
        keys.push(...db.all('SELECT DISTINCT releaseKey AS k FROM LibraryReleases').map((r) => r.k));
      }
      keys = [...new Set(keys.filter(Boolean))];
      if (!keys.length) return [];

      // DLCs und versteckte Einträge erkennen
      const hidden = new Set();
      if (tables.has('ReleaseProperties')) {
        const cols = db.columns('ReleaseProperties');
        const conds = [];
        if (cols.has('isDlc')) conds.push('isDlc = 1');
        if (cols.has('isVisibleInLibrary')) conds.push('isVisibleInLibrary = 0');
        if (conds.length) {
          for (const r of db.all(`SELECT releaseKey FROM ReleaseProperties WHERE ${conds.join(' OR ')}`)) {
            hidden.add(r.releaseKey);
          }
        }
      }

      // Titel und Bilder
      const pieces = new Map();
      const rows = db.all(`
        SELECT gp.releaseKey AS k, t.type AS type, gp.value AS value
        FROM GamePieces gp JOIN GamePieceTypes t ON t.id = gp.gamePieceTypeId
        WHERE t.type IN ('title', 'originalTitle', 'originalImages', 'images')`);
      for (const r of rows) {
        const p = pieces.get(r.k) || {};
        p[r.type] = parseJson(r.value);
        pieces.set(r.k, p);
      }

      const out = [];
      for (const releaseKey of keys) {
        if (hidden.has(releaseKey)) continue;
        const p = pieces.get(releaseKey) || {};
        const name = p.title?.title || p.originalTitle?.title;
        if (!name) continue;
        const img = p.images || p.originalImages || {};
        const fix = (u) => (u && u.startsWith('//') ? 'https:' + u : u);
        const i = releaseKey.indexOf('_');
        out.push({
          releaseKey,
          platform: i > 0 ? releaseKey.slice(0, i) : releaseKey,
          id: i > 0 ? releaseKey.slice(i + 1) : releaseKey,
          name,
          covers: [fix(img.verticalCover)].filter(Boolean),
          wides: [fix(img.background)].filter(Boolean)
        });
      }
      return out;
    } finally {
      db.close();
    }
  })().catch((err) => {
    console.error('[galaxy]', err);
    return [];
  });
  return cache;
}

/** Besessene Spiele einer Plattform (z. B. 'gog', 'uplay', 'battlenet'). */
async function ownedFor(...platforms) {
  return (await readOwned()).filter((g) => platforms.includes(g.platform));
}

function clearCache() { cache = null; }

/**
 * Fügt einer Launcher-Liste die besessenen, nicht installierten Spiele aus Galaxy hinzu.
 * makeLaunch(owned) -> launch-Objekt oder null (dann wird das Spiel übersprungen).
 */
async function addOwned(games, platforms, makeLaunch) {
  const { normalize } = require('./names');
  const have = new Set(games.map((g) => normalize(g.name)));
  for (const o of await ownedFor(...platforms)) {
    const key = normalize(o.name);
    if (!key || have.has(key)) continue;
    const launch = makeLaunch(o);
    if (!launch) continue;
    have.add(key);
    games.push({
      nativeId: `galaxy:${o.releaseKey}`,
      name: o.name,
      status: 'notInstalled',
      covers: o.covers,
      wides: o.wides,
      launch
    });
  }
  return games;
}

/** Zahl als Anteil 0..1 deuten – GOG speichert je nach Version Bytes, Prozent oder Anteil */
function asFraction(value, size) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return undefined;
  if (v <= 1) return v;
  if (size > 100 && v <= size) return v / size;
  if (v <= 100) return v / 100;
  return undefined;
}

/**
 * Laufende Installationen/Updates aus Galaxys Auftrags-Datenbank (storage\jobs.db).
 * Ergebnis: Map productId -> update-Objekt (Fortschritt; Geschwindigkeit misst Ludora über die Bytes)
 */
async function readJobs() {
  const file = path.join(path.dirname(dbPath()), 'jobs.db');
  const db = await openDb(file);
  const out = new Map();
  if (!db) return out;
  try {
    const tables = db.tables();
    for (const [table, kind] of [['InstallProductJobs', 'install'], ['UpdateProductJobs', 'update']]) {
      if (!tables.has(table)) continue;
      for (const r of db.all(`SELECT * FROM "${table}"`)) {
        const size = Number(r.downloadSize) || 0;
        const progress = asFraction(r.overallDownloadProgress ?? r.downloadProgress, size);
        const dl = asFraction(r.downloadProgress, size);
        const u = {
          state: 'downloading',
          progress,
          bytesTotal: size || undefined,
          bytesDone: size && dl !== undefined ? Math.round(dl * size) : undefined,
          firstInstall: kind === 'install',
          detail: r.isVerifying ? t("Überprüfen") : undefined,
          source: 'GOG Galaxy'
        };
        if (r.productId !== undefined && r.productId !== null) out.set(String(r.productId), u);
      }
    }
  } catch { /* Format geändert */ } finally {
    db.close();
  }
  return out;
}

module.exports = { readOwned, readInstalled, readJobs, asFraction, ownedFor, addOwned, clearCache, dbPath };
