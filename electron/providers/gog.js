// GOG
// Installiert: Registry GOG.com\Games
// Bibliothek:  GOG-Galaxy-Datenbank (falls Galaxy installiert ist)
const path = require('path');
const reg = require('../lib/registry');
const galaxy = require('../lib/galaxy');
const { exists, exeLaunch, firstExisting } = require('../lib/util');
const { isMac, home, appBundle } = require('../lib/platform');
const { normalize } = require('../lib/names');

const GAMES_KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games';

async function findGalaxy() {
  if (isMac) return firstExisting(['/Applications/GOG Galaxy.app', path.join(home, 'Applications', 'GOG Galaxy.app')]);
  const dir = await reg.getFirstValue([
    ['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient\\paths', 'client'],
    ['HKLM\\SOFTWARE\\GOG.com\\GalaxyClient\\paths', 'client']
  ]);
  if (!dir) return null;
  const exe = path.join(dir, 'GalaxyClient.exe');
  return (await exists(exe)) ? exe : null;
}

async function detect() {
  const entries = await reg.getSubKeys(GAMES_KEY);
  const galaxyExe = await findGalaxy();
  const owned = await galaxy.ownedFor('gog');
  const ownedById = new Map(owned.map((o) => [o.id, o]));

  const games = [];
  const installedIds = new Set();
  const installedNames = new Set();

  // macOS: installierte Spiele aus der Galaxy-Datenbank
  if (isMac) {
    for (const inst of await galaxy.readInstalled()) {
      const o = ownedById.get(inst.id);
      const app = appBundle(inst.path) || (inst.path && /\.app$/i.test(inst.path) ? inst.path : null);
      installedIds.add(inst.id);
      if (o) installedNames.add(normalize(o.name));
      games.push({
        nativeId: inst.id,
        name: o?.name || `GOG ${inst.id}`,
        installDir: inst.path || undefined,
        status: 'installed',
        covers: o?.covers || [],
        wides: o?.wides || [],
        // DRM-frei: .app direkt starten, sonst über Galaxy
        launch: app ? { type: 'exe', target: app, args: [] }
          : { type: 'uri', target: `goggalaxy://openGameView/gog_${inst.id}` }
      });
    }
  }

  for (const { name: id, values: v } of entries) {
    const gameId = String(v.gameID || id);
    const dir = v.path;
    const exe = v.exe || v.launchCommand;
    // DLCs haben einen dependsOn-Eintrag auf das Hauptspiel
    if (v.dependsOn) continue;

    let launch;
    if (exe && (await exists(exe))) {
      // GOG-Spiele sind DRM-frei: direkt starten, Galaxy bleibt komplett zu
      launch = { type: 'exe', target: exe, args: v.launchParam ? v.launchParam.split(' ') : [], cwd: v.workingDir || dir };
    } else if (galaxyExe) {
      launch = {
        type: 'exe',
        target: galaxyExe,
        args: ['/command=runGame', `/gameId=${gameId}`, `/path=${dir}`],
        cwd: path.dirname(galaxyExe)
      };
    } else {
      continue;
    }

    const name = v.gameName || v.GAMENAME || ownedById.get(gameId)?.name || `GOG ${gameId}`;
    installedIds.add(gameId);
    installedNames.add(normalize(name));
    const imgs = ownedById.get(gameId);

    games.push({
      nativeId: gameId,
      name,
      installDir: dir,
      status: 'installed',
      covers: imgs?.covers || [],
      wides: imgs?.wides || [],
      launch
    });
  }

  // Besessen, aber nicht installiert -> öffnet die Spielseite in Galaxy
  for (const o of owned) {
    if (installedIds.has(o.id) || installedNames.has(normalize(o.name))) continue;
    games.push({
      nativeId: o.id,
      name: o.name,
      status: 'notInstalled',
      covers: o.covers,
      wides: o.wides,
      launch: { type: 'uri', target: `goggalaxy://openGameView/${o.releaseKey}` }
    });
  }

  return games;
}

/** Downloads/Updates, die GOG Galaxy gerade ausführt */
async function updates() {
  return [...(await galaxy.readJobs())].map(([nativeId, update]) => ({ nativeId, update }));
}

module.exports = {
  id: 'gog',
  updates,
  downloadsPage: async () => exeLaunch(await findGalaxy()),
  platforms: ['win32', 'darwin'],
  processes: ['GalaxyClient', 'GalaxyClient Helper'],
  processesMac: ['GOG Galaxy'],
  client: async () => exeLaunch(await findGalaxy()) || { type: 'url', target: 'https://www.gog.com/de/galaxy' },
  store: { type: 'url', target: 'https://www.gog.com/de/games' },
  name: 'GOG',
  color: '#3b1f4f',
  accent: '#c79bff',
  detect
};
