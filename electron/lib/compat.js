// Läuft ein Spiel auf diesem Betriebssystem?
//
// Installierte Spiele laufen hier natürlich. Für besessene, aber nicht installierte Spiele fragt Ludora
// die Plattformen ab und merkt sie sich (compat-cache.json, 30 Tage):
//   Steam  – Store-API (Windows / macOS / Linux + Steam-Deck-Einstufung für Proton)
//   GOG    – api.gog.com (Windows / macOS / Linux)
//   Epic   – steht schon im lokalen Katalog des Launchers (releaseInfo.platform)
// Unter Linux laufen Windows-Spiele über Proton (Steam) bzw. Wine (Heroic/Lutris). Ausgeblendet wird dort
// nur, was Steam als "nicht unterstützt" einstuft (meist Anti-Cheat). Unbekannt = wird angezeigt.
const fs = require('fs');
const path = require('path');

const TTL = 30 * 24 * 3600 * 1000;
let file = null;
let cache = null;
let fetchImpl = (...a) => fetch(...a);

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { cache = {}; }
  return cache;
}
let saveTimer = null;
function save() {
  if (!file) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.promises.writeFile(file, JSON.stringify(cache)).catch(() => {}), 1000);
  saveTimer.unref?.();
}

/** { windows, mac, linux, deck } -> läuft auf os? (true / false / null = unbekannt) */
function runsOn(platforms, os, provider) {
  if (!platforms) return null;
  const { windows, mac, linux, deck } = platforms;
  if (os === 'win32') return windows === false ? false : windows ? true : null;
  if (os === 'darwin') return mac === true ? true : (mac === false ? false : null);
  if (os === 'linux') {
    if (linux) return true;
    if (provider !== 'steam') return windows !== false ? true : null; // Heroic/Lutris: über Wine
    if (deck === 1) return false;  // Steam: "nicht unterstützt" (Proton)
    if (deck === 2 || deck === 3) return true;
    return windows ? null : (linux === false ? false : null);
  }
  return null;
}

/** Spiel für dieses System bewerten -> g.runsHere: true / false / undefined (unbekannt) */
function rate(g, os = process.platform) {
  if (g.status !== 'notInstalled') { g.runsHere = true; return; }
  const r = runsOn(g.platforms, os, g.provider);
  if (r === null) delete g.runsHere; else g.runsHere = r;
}

async function steamPlatforms(appids) {
  const out = {};
  for (let i = 0; i < appids.length; i += 100) {
    const input = {
      ids: appids.slice(i, i + 100).map((a) => ({ appid: Number(a) })),
      context: { language: 'english', country_code: 'US', steam_realm: 1 },
      data_request: { include_platforms: true }
    };
    const r = await fetchImpl(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`,
      { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Steam ${r.status}`);
    const data = await r.json();
    for (const it of data?.response?.store_items || []) {
      const p = it.platforms;
      if (!it.appid || !p) continue;
      out[String(it.appid)] = { windows: !!p.windows, mac: !!p.mac, linux: !!p.steamos_linux, deck: Number(p.steam_deck_compat_category) || 0 };
    }
  }
  return out;
}

async function gogPlatforms(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const r = await fetchImpl(`https://api.gog.com/products?ids=${ids.slice(i, i + 50).join(',')}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`GOG ${r.status}`);
    for (const it of (await r.json()) || []) {
      const c = it.content_system_compatibility;
      if (it.id && c) out[String(it.id)] = { windows: !!c.windows, mac: !!c.osx, linux: !!c.linux };
    }
  }
  return out;
}

const FETCHERS = { steam: steamPlatforms, gog: gogPlatforms };

/**
 * Bekannte Plattformen sofort eintragen (aus dem Zwischenspeicher).
 * Gibt die Spiele zurück, für die noch nachgefragt werden muss.
 */
function applyCached(games, os = process.platform) {
  const c = load();
  const missing = [];
  for (const g of games) {
    if (g.status === 'notInstalled' && !g.platforms && FETCHERS[g.provider]) {
      const hit = c[`${g.provider}:${g.nativeId}`];
      if (hit && Date.now() - hit.at < TTL) g.platforms = hit.p;
      else missing.push(g);
    }
    rate(g, os);
  }
  return missing;
}

/** Fehlende Plattformen abfragen; onUpdate(game) für jedes Spiel, das sich geändert hat */
async function fetchMissing(missing, onUpdate, os = process.platform) {
  const c = load();
  for (const [provider, fetcher] of Object.entries(FETCHERS)) {
    const list = missing.filter((g) => g.provider === provider);
    if (!list.length) continue;
    let found = {};
    try { found = await fetcher(list.map((g) => g.nativeId)); } catch (err) { console.warn('[compat]', provider, err.message); continue; }
    for (const g of list) {
      const p = found[String(g.nativeId)] || null;
      c[`${provider}:${g.nativeId}`] = { p, at: Date.now() }; // auch "unbekannt" merken (nicht ständig neu fragen)
      if (!p) continue;
      g.platforms = p;
      rate(g, os);
      onUpdate?.(g);
    }
  }
  save();
}

module.exports = {
  init(dir) { file = path.join(dir, 'compat-cache.json'); cache = null; },
  applyCached, fetchMissing, runsOn, rate,
  _setFetch(f) { fetchImpl = f; }, _reset() { cache = {}; }
};
