// Zentrale Liste aller Launcher-Module.
// Neuen Launcher hinzufügen = neue Datei mit { id, name, color, accent, detect() } + hier eintragen.
const reg = require('../lib/registry');
const { t } = require('../lib/i18n');
const galaxy = require('../lib/galaxy');
const { normalize } = require('../lib/names');

// Alle Launcher – welche davon auf diesem System verfügbar sind, steht in "platforms"
// (Standard: nur Windows). Unter macOS gibt es z. B. kein Ubisoft Connect und keine EA app.
const allProviders = [
  require('./steam'),
  require('./epic'),
  require('./gog'),
  require('./ea'),
  require('./ubisoft'),
  require('./battlenet'),
  require('./amazon'),
  require('./riot'),
  require('./rockstar'),
  require('./manual')
];

const providers = allProviders.filter((p) => (p.platforms || ['win32']).includes(process.platform));

/** Ist ein Launcher eingeschaltet? (Standard: ja) */
function isEnabled(id, enabledMap) {
  return !enabledMap || enabledMap[id] !== false;
}

/**
 * Durchsucht alle eingeschalteten Launcher parallel.
 * Ausgeschaltete werden gar nicht gelesen (und laden damit auch keine Cover).
 * Fällt einer aus, laufen die anderen trotzdem weiter.
 */
async function scanAll(enabledMap) {
  reg.clearCache();
  galaxy.clearCache();
  const started = Date.now();

  const results = await Promise.all(
    providers.map(async (p) => {
      const t = Date.now();
      if (!isEnabled(p.id, enabledMap)) return { provider: p, games: [], error: null, ms: 0, disabled: true };
      try {
        const games = await p.detect();
        return { provider: p, games, error: games.warning || null, ms: Date.now() - t };
      } catch (err) {
        console.error(`[${p.id}]`, err);
        return { provider: p, games: [], error: String(err.message || err), ms: Date.now() - t };
      }
    })
  );

  const games = [];
  const providerInfo = [];
  for (const { provider: p, games: list, error, ms, disabled } of results) {
    const installed = list.filter((g) => g.status !== 'notInstalled').length;
    providerInfo.push({
      id: p.id, name: t(p.name), color: p.color, accent: p.accent,
      hasClient: !!p.client, hasStore: !!p.store,
      count: list.length, installed, error, ms, enabled: !disabled
    });
    for (const g of list) {
      games.push({ ...g, id: `${p.id}:${g.nativeId}`, provider: p.id });
    }
  }

  // Ein Spiel, das über irgendeinen Launcher installiert ist, nicht zusätzlich
  // bei einem anderen als "nicht installiert" zeigen (z. B. skate. über Steam und EA).
  const installedNames = new Set(games.filter((g) => g.status !== 'notInstalled').map((g) => normalize(g.name)));
  for (let i = games.length - 1; i >= 0; i--) {
    if (games[i].status === 'notInstalled' && installedNames.has(normalize(games[i].name))) games.splice(i, 1);
  }
  // Nicht installierte Doppelte (z. B. GTA V bei Steam und Rockstar): den ersten Launcher
  // in der Reihenfolge oben behalten.
  const seenNotInstalled = new Set();
  for (let i = 0; i < games.length; i++) {
    if (games[i].status !== 'notInstalled') continue;
    const key = normalize(games[i].name);
    if (seenNotInstalled.has(key)) { games.splice(i, 1); i--; } else seenNotInstalled.add(key);
  }

  games.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
  return { games, providers: providerInfo, scannedAt: new Date().toISOString(), totalMs: Date.now() - started };
}

module.exports = { providers, allProviders, scanAll };
