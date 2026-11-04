// Cover für Spiele, die kein Bild vom Launcher mitbringen.
//
// Reihenfolge:
//   1. Cache (covers.json im App-Ordner)
//   2. GOG-API (Epic und Galaxy liefern ihre Bilder schon beim Scan mit)
//   3. SteamGridDB (nur mit API-Key, findet fast alles)
//   4. Steam-Shop-Suche nach dem Namen (ohne Key, viele Spiele sind auch auf Steam)
//
// Ergebnis pro Spiel: { covers: [hochkant…], wides: [breit…] }
// hochkant für das Raster, breit für die Listenansicht.
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const { normalize, similarity } = require('./names');

const NEGATIVE_TTL = 3 * 24 * 60 * 60 * 1000; // nichts gefunden -> 3 Tage später nochmal versuchen
let cacheFile = null;
let cache = null;

function init(userDataDir) {
  cacheFile = path.join(userDataDir, 'covers.json');
}

function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { cache = {}; }
  return cache;
}

function saveCache() {
  try { fs.writeFileSync(cacheFile, JSON.stringify(cache), 'utf8'); } catch { /* egal */ }
}

/** Gecachte Cover direkt beim Scan eintragen (synchron, ohne Netz). */
function applyCached(games) {
  const c = loadCache();
  for (const g of games) {
    const entry = c[g.id];
    // Reparierte Einträge (die Original-Bilder luden nicht) haben immer Vorrang
    if (entry?.repaired) {
      const hit = toImages(entry);
      if (hit) { g.covers = [...hit.covers, ...(g.covers || [])]; g.wides = [...hit.wides, ...(g.wides || [])]; }
      continue;
    }
    if (g.covers?.length || g.wides?.length) continue;
    const hit = toImages(entry);
    if (hit) Object.assign(g, hit);
  }
}

/** Spiele, für die noch gesucht werden muss. */
function needsLookup(games) {
  const c = loadCache();
  const now = Date.now();
  return games.filter((g) => {
    if (g.covers?.length || g.wides?.length) return false;
    const hit = c[g.id];
    return !hit || (!toImages(hit) && now - (hit.at || 0) > NEGATIVE_TTL);
  });
}

function clearMisses() {
  const c = loadCache();
  for (const k of Object.keys(c)) if (!toImages(c[k])) delete c[k];
  saveCache();
}

// ---------- Hilfen ----------

/** Aus [hochkant, breit] bzw. Cache-Eintrag ein { covers, wides } machen (oder null). */
function toImages(x) {
  if (!x) return null;
  if (Array.isArray(x.urls)) { // altes Cache-Format
    if (!x.urls.length) return null;
    return { covers: [x.urls[0]], wides: [x.urls[1] || x.urls[0]] };
  }
  const covers = (x.covers || []).filter(Boolean);
  const wides = (x.wides || []).filter(Boolean);
  if (!covers.length && !wides.length) return null;
  return { covers: covers.length ? covers : [], wides: wides.length ? wides : covers };
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const steamCdn = (id) => ({
  covers: [`https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_600x900.jpg`],
  wides: [`https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`]
});

/**
 * Bilder direkt aus dem Steam-Store (ohne Key). Liefert auch bei neuen Spielen die
 * richtigen Links – Steam hängt dort inzwischen eine Prüfsumme in den Pfad.
 */
async function steamAssets(appid) {
  const input = {
    ids: [{ appid: Number(appid) }],
    context: { language: 'german', country_code: 'DE', steam_realm: 1 },
    data_request: { include_assets: true }
  };
  const data = await getJson('https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=' +
    encodeURIComponent(JSON.stringify(input)));
  const a = data?.response?.store_items?.[0]?.assets;
  if (!a?.asset_url_format) return null;
  const url = (file) => file && 'https://shared.akamai.steamstatic.com/store_item_assets/' +
    a.asset_url_format.replace('${FILENAME}', file);
  return toImages({
    covers: [url(a.library_capsule_2x), url(a.library_capsule)],
    wides: [url(a.header), url(a.main_capsule)]
  });
}

// ---------- Quellen ----------

async function fromSteamApp(game) {
  if (game.provider !== 'steam' || !/^\d+$/.test(game.nativeId)) return null;
  return steamAssets(game.nativeId);
}

async function fromGog(game) {
  if (game.provider !== 'gog') return null;
  const covers = [], wides = [];
  try {
    const v2 = await getJson(`https://api.gog.com/v2/games/${game.nativeId}?locale=de-DE`);
    const box = v2?._links?.boxArtImage?.href;
    if (box) covers.push(box);
  } catch { /* weiter */ }
  try {
    const p = await getJson(`https://api.gog.com/products/${game.nativeId}`);
    const wide = p?.images?.logo2x || p?.images?.background;
    if (wide) wides.push(wide.startsWith('//') ? 'https:' + wide : wide);
  } catch { /* weiter */ }
  return toImages({ covers, wides });
}

async function fromSteamGridDb(game) {
  const key = (settings.get('steamGridDbKey') || '').trim();
  if (!key) return null;
  const h = { Authorization: `Bearer ${key}` };
  const base = 'https://www.steamgriddb.com/api/v2';
  const search = await getJson(`${base}/search/autocomplete/${encodeURIComponent(game.name)}`, h);
  const best = (search?.data || [])
    .map((d) => ({ d, s: similarity(d.name, game.name) }))
    .sort((a, b) => b.s - a.s)[0];
  if (!best || best.s < 0.75) return null;
  const id = best.d.id;
  const [tall, wide] = await Promise.all([
    getJson(`${base}/grids/game/${id}?dimensions=600x900&types=static&nsfw=false`, h).catch(() => null),
    getJson(`${base}/grids/game/${id}?dimensions=460x215,920x430&types=static&nsfw=false`, h).catch(() => null)
  ]);
  return toImages({ covers: [tall?.data?.[0]?.url], wides: [wide?.data?.[0]?.url] });
}

async function fromSteamStore(game) {
  const term = game.name.replace(/[™®©]/g, '');
  const data = await getJson(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=de&l=german`
  );
  const best = (data?.items || [])
    .filter((i) => i.type === 'app')
    .map((i) => ({ i, s: similarity(i.name, game.name) }))
    .sort((a, b) => b.s - a.s)[0];
  // Lieber kein Bild als ein falsches
  if (!best || best.s < 0.8) return null;
  return (await steamAssets(best.i.id).catch(() => null)) || steamCdn(best.i.id);
}

/**
 * Microsoft Store / Xbox-Katalog (ohne Key). Hilft bei Spielen, die es nicht auf Steam
 * gibt (z. B. VALORANT, einige Blizzard- und Ubisoft-Titel).
 */
async function fromMsStore(game) {
  const q = encodeURIComponent(game.name.replace(/[™®©]/g, ''));
  const sug = await getJson(`https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest?market=DE&languages=de-DE&query=${q}&productFamilyNames=Games&platformdependencyname=windows.desktop`);
  const items = (sug?.ResultSets || []).flatMap((r) => r.Suggests || []);
  const best = items
    .map((i) => ({ i, s: similarity(i.Title || '', game.name) }))
    .sort((a, b) => b.s - a.s)[0];
  if (!best || best.s < 0.8) return null;
  const id = (best.i.Metas || []).find((m) => m.Key === 'BigCatalogId')?.Value;
  const fix = (u) => (u && u.startsWith('//') ? 'https:' + u : u);
  if (id) {
    const p = await getJson(`https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${id}&market=DE&languages=de-DE`).catch(() => null);
    const imgs = p?.Products?.[0]?.LocalizedProperties?.[0]?.Images || [];
    const pick = (...kinds) => kinds.map((k) => imgs.find((i) => i.ImagePurpose === k)?.Uri).find(Boolean);
    const res = toImages({
      covers: [fix(pick('Poster', 'BoxArt'))],
      wides: [fix(pick('SuperHeroArt', 'TitledHeroArt', 'Hero', 'BrandedKeyArt'))]
    });
    if (res) return res;
  }
  return toImages({ covers: [fix(best.i.ImageUrl)] });
}

// Reserve: Ubisofts eigenes Kachelbild (breit), falls der Steam-Shop nichts findet
async function fromUbisoft(game) {
  if (!game.ubisoftThumb) return null;
  const res = await fetch(game.ubisoftThumb, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
  return res.ok ? { covers: [], wides: [game.ubisoftThumb] } : null;
}

const SOURCES = [fromSteamApp, fromGog, fromSteamGridDb, fromSteamStore, fromMsStore, fromUbisoft];

async function lookup(game) {
  for (const src of SOURCES) {
    try {
      const imgs = toImages(await src(game));
      if (imgs) return imgs;
    } catch { /* nächste Quelle */ }
  }
  return null;
}

/**
 * Sucht Cover für alle übergebenen Spiele, max. 4 gleichzeitig.
 * onFound(id, { covers, wides }) wird für jeden Treffer sofort aufgerufen.
 */
async function resolveMissing(games, onFound) {
  const c = loadCache();
  const queue = [...games];
  let dirty = 0;

  async function worker() {
    while (queue.length) {
      const g = queue.shift();
      const imgs = await lookup(g);
      c[g.id] = { ...(imgs || {}), at: Date.now() };
      if (++dirty % 10 === 0) saveCache();
      if (imgs) onFound(g.id, imgs);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  saveCache();
}

/**
 * Reparatur: Für dieses Spiel hat in der Oberfläche kein einziges Bild geladen.
 * Alle Quellen nochmal durchgehen und nur Bilder nehmen, die wirklich erreichbar sind.
 */
async function repair(game) {
  const tried = new Set([...(game.covers || []), ...(game.wides || [])]);
  for (const src of SOURCES) {
    let imgs;
    try { imgs = toImages(await src(game)); } catch { continue; }
    if (!imgs) continue;
    const ok = async (u) => {
      if (tried.has(u)) return false;
      try { return (await fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(8000) })).ok; } catch { return false; }
    };
    const covers = [], wides = [];
    for (const u of imgs.covers) if (await ok(u)) covers.push(u);
    for (const u of imgs.wides) if (await ok(u)) wides.push(u);
    const good = toImages({ covers, wides });
    if (good) {
      const c = loadCache();
      c[game.id] = { ...good, repaired: true, at: Date.now() };
      saveCache();
      return good;
    }
  }
  const c = loadCache();
  c[game.id] = { covers: [], wides: [], repaired: true, at: Date.now() };
  saveCache();
  return null;
}

/** Eigenes Cover (vom Nutzer gewählt) – hat immer Vorrang. */
function setCustom(id, url) {
  const c = loadCache();
  c[id] = { covers: [url], wides: [url], repaired: true, custom: true, at: Date.now() };
  saveCache();
  return { covers: [url], wides: [url] };
}

module.exports = { init, setCustom, applyCached, needsLookup, resolveMissing, clearMisses, repair, normalize, similarity };
