// Rockstar Games Launcher (GTA V, RDR2, ...)
const path = require('path');
const reg = require('../lib/registry');
const galaxy = require('../lib/galaxy');
const { exists, cleanExePath, exeLaunch, listDir, env } = require('../lib/util');
const { normalize } = require('../lib/names');

async function findLauncher() {
  const dir = await reg.getFirstValue([
    ['HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\Launcher', 'InstallFolder']
  ]);
  if (!dir) return null;
  const exe = path.join(dir, 'Launcher.exe');
  return (await exists(exe)) ? exe : null;
}

// Rockstar-Spiele legen beim ersten Start einen eigenen Ordner an
// (%LocalAppData%\Rockstar Games bzw. Dokumente\Rockstar Games).
// Daraus erkennen wir ohne Login, welche Spiele du schon mal gespielt hast.
const FOLDER_TITLES = {
  'gta v': 'Grand Theft Auto V Legacy',
  'gtav': 'Grand Theft Auto V Legacy',
  'gtav enhanced': 'Grand Theft Auto V Enhanced',
  'gta iii definitive edition': 'Grand Theft Auto III – The Definitive Edition',
  'gta vice city definitive edition': 'Grand Theft Auto: Vice City – The Definitive Edition',
  'gta san andreas definitive edition': 'Grand Theft Auto: San Andreas – The Definitive Edition',
  'red dead redemption 2': 'Red Dead Redemption 2',
  'red dead redemption': 'Red Dead Redemption',
  'l.a. noire': 'L.A. Noire',
  'max payne 3': 'Max Payne 3',
  'bully': 'Bully: Scholarship Edition',
  'gta iv': 'Grand Theft Auto IV'
};

async function playedTitles() {
  const roots = [
    env('LOCALAPPDATA') && path.join(env('LOCALAPPDATA'), 'Rockstar Games'),
    env('USERPROFILE') && path.join(env('USERPROFILE'), 'Documents', 'Rockstar Games')
  ].filter(Boolean);
  const titles = new Set();
  for (const root of roots) {
    for (const dir of await listDir(root)) {
      const t = FOLDER_TITLES[dir.toLowerCase()];
      if (t) titles.add(t);
    }
  }
  return [...titles];
}

async function detect() {
  const entries = await reg.getUninstallEntries();
  const launcher = await findLauncher();
  const games = [];

  for (const { name: key, values: v } of entries) {
    if (!/Rockstar Games/i.test(v.Publisher || '')) continue;
    if (/Launcher|Social Club/i.test(v.DisplayName || '')) continue;
    const dir = v.InstallLocation && path.normalize(v.InstallLocation.replace(/"/g, ''));
    if (!dir || /steamapps|epic games/i.test(dir)) continue;

    let launch;
    if (launcher) {
      launch = { type: 'exe', target: launcher, args: ['-launchTitleInFolder', dir], cwd: path.dirname(launcher) };
    } else {
      const exe = cleanExePath(v.DisplayIcon);
      if (!exe) continue;
      launch = { type: 'exe', target: exe, args: [], cwd: dir };
    }

    games.push({
      nativeId: key,
      name: v.DisplayName,
      installDir: dir,
      status: 'installed',
      covers: [],
      launch
    });
  }

  // Schon mal gespielte, aber nicht installierte Spiele -> Rockstar Launcher öffnen
  const have = new Set(games.map((g) => normalize(g.name)));
  for (const title of await playedTitles().catch(() => [])) {
    if (have.has(normalize(title))) continue;
    have.add(normalize(title));
    games.push({
      nativeId: `played:${normalize(title)}`,
      name: title,
      status: 'notInstalled',
      covers: [],
      launch: launcher ? { type: 'exe', target: launcher, args: [], cwd: path.dirname(launcher) }
        : { type: 'url', target: 'https://www.rockstargames.com/de/downloads' }
    });
  }

  // Bibliothek über GOG Galaxy (falls Rockstar dort verknüpft ist) -> öffnet den Launcher
  return galaxy.addOwned(games, ['rockstar'], () =>
    launcher ? { type: 'exe', target: launcher, args: [], cwd: path.dirname(launcher) } : null);
}

module.exports = {
  id: 'rockstar',
  processes: ['Launcher', 'LauncherPatcher'],
  client: async () => exeLaunch(await findLauncher()),
  store: { type: 'url', target: 'https://store.rockstargames.com/de' },
  name: 'Rockstar',
  color: '#2a2306',
  accent: '#fcaf17',
  detect
};
