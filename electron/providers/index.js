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
  ...require('./linux'), // Linux: Heroic + Lutris
  require('./manual')
];

const providers = allProviders.filter((p) => (p.platforms || ['win32']).includes(process.platform));

// Download für nicht installierte Launcher (offizielle Quellen): direkter Installer, wo es einen festen
// Link gibt, sonst die offizielle Download-Seite. Feste Liste – die App öffnet nie eine Adresse von außen.
const DOWNLOADS = {
  win32: {
    steam: 'https://cdn.akamai.steamstatic.com/client/installer/SteamSetup.exe',
    epic: 'https://store.epicgames.com/download',
    gog: 'https://webinstallers.gog-statics.com/download/GOG_Galaxy_2.0.exe',
    ea: 'https://origin-a.akamaihd.net/EA-Desktop-Client-Download/installer-releases/EAappInstaller.exe',
    ubisoft: 'https://ubisoftconnect.com/',
    battlenet: 'https://www.battle.net/download/getInstallerForGame?os=win&gameProgram=BATTLENET_APP&version=Live',
    amazon: 'https://download.amazongames.com/AmazonGamesSetup.exe',
    riot: 'https://www.riotgames.com/',
    rockstar: 'https://www.rockstargames.com/downloads'
  },
  darwin: {
    steam: 'https://store.steampowered.com/about/',
    epic: 'https://store.epicgames.com/download',
    gog: 'https://www.gog.com/galaxy',
    battlenet: 'https://www.battle.net/download/getInstallerForGame?os=mac&gameProgram=BATTLENET_APP&version=Live',
    riot: 'https://www.riotgames.com/'
  },
  linux: {
    steam: 'https://store.steampowered.com/about/',
    epic: 'https://heroicgameslauncher.com/downloads',
    gog: 'https://heroicgameslauncher.com/downloads',
    amazon: 'https://heroicgameslauncher.com/downloads',
    battlenet: 'https://lutris.net/downloads',
    ea: 'https://lutris.net/downloads',
    ubisoft: 'https://lutris.net/downloads',
    rockstar: 'https://lutris.net/downloads',
    lutris: 'https://lutris.net/downloads'
  }
};
const downloadUrl = (id) => DOWNLOADS[process.platform]?.[id] || null;

/** Ist das Programm des Launchers installiert? (Sein Start zeigt auf eine Programmdatei, nicht nur auf eine Webseite) */
async function clientInstalled(p) {
  try { const l = await p.client?.(); return !!l && l.type !== 'url' && l.type !== 'uri'; } catch { return false; }
}

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
        // Nur bei leeren Launchern nachsehen, ob das Programm fehlt (für den Download-Knopf)
        const client = games.length ? true : await clientInstalled(p);
        return { provider: p, games, client, error: games.warning || null, ms: Date.now() - t };
      } catch (err) {
        console.error(`[${p.id}]`, err);
        return { provider: p, games: [], client: await clientInstalled(p), error: String(err.message || err), ms: Date.now() - t };
      }
    })
  );

  const games = [];
  const providerInfo = [];
  for (const { provider: p, games: list, client, error, ms, disabled } of results) {
    const installed = list.filter((g) => g.status !== 'notInstalled').length;
    providerInfo.push({
      id: p.id, name: t(p.name), color: p.color, accent: p.accent,
      hasClient: !!p.client, hasStore: !!p.store,
      clientInstalled: client !== false, download: client === false ? downloadUrl(p.id) : null,
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

module.exports = { providers, allProviders, scanAll, downloadUrl, DOWNLOADS };
