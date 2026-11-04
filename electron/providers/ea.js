// EA app (früher Origin)
// Installiert: "Programme & Features"-Einträge mit EA-Installer-Daten.
// Bibliothek:  Die EA app speichert ihre Bibliothek verschlüsselt, schreibt aber beim
//              Start jedes Spiel deines Kontos samt Status in ihr Protokoll
//              (%LocalAppData%\Electronic Arts\EA Desktop\Logs\EADesktop.log).
// Gestartet wird die Spiel-EXE direkt – der EA-Kopierschutz holt die EA app
// dabei automatisch im Hintergrund dazu.
const path = require('path');
const reg = require('../lib/registry');
const galaxy = require('../lib/galaxy');
const { exists, cleanExePath, firstExisting, exeLaunch, env, readText } = require('../lib/util');
const { normalize } = require('../lib/names');

const IGNORE = /^(EA app|Origin|EA Desktop)/i;

// Schönere Namen für Slugs, die man nicht automatisch richtig schreiben kann
const SLUG_NAMES = {
  'skate': 'skate.',
  'ea-sports-fc-26': 'EA SPORTS FC 26',
  'ea-sports-fc-25': 'EA SPORTS FC 25',
  'ea-sports-fc-24': 'EA SPORTS FC 24',
  'battlefield-5': 'Battlefield V',
  'battlefield-6': 'Battlefield 6',
  'star-wars-battlefront-2': 'Star Wars Battlefront II',
  'star-wars-battlefront': 'Star Wars Battlefront',
  'star-wars-jedi-fallen-order': 'Star Wars Jedi: Fallen Order',
  'star-wars-jedi-survivor': 'Star Wars Jedi: Survivor',
  'the-sims-4': 'The Sims 4',
  'jade-empire': 'Jade Empire: Special Edition',
  'battlefield-1942': 'Battlefield 1942',
  'dead-space-classic': 'Dead Space (2008)',
  'a-way-out': 'A Way Out',
  'it-takes-two': 'It Takes Two'
};

function slugToName(slug) {
  if (SLUG_NAMES[slug]) return SLUG_NAMES[slug];
  return slug.split('-').map((w) => (/^(ii|iii|iv|vi|fc|ea|nfs|ufc|nhl|nba|f1)$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
}

/** Alle Spiele aus den EA-app-Protokollen, jeweils mit dem letzten bekannten Status. */
async function libraryFromLogs() {
  const local = env('LOCALAPPDATA');
  if (!local) return [];
  const dir = path.join(local, 'Electronic Arts', 'EA Desktop', 'Logs');
  const status = new Map();
  // .bak ist älter, das aktuelle Log überschreibt
  for (const file of ['EADesktop.bak', 'EADesktop.log']) {
    const text = await readText(path.join(dir, file));
    if (!text) continue;
    const re = /baseSlug=\[([a-z0-9-]+)\] installedStatus=\[(\w+)\]/g;
    let m;
    while ((m = re.exec(text))) status.set(m[1], m[2]);
  }
  return [...status].map(([slug, st]) => ({ slug, name: slugToName(slug), installed: st !== 'NotInstalled' }));
}

async function detect() {
  const entries = await reg.getUninstallEntries();
  const games = [];

  for (const { name: key, values: v } of entries) {
    const publisher = v.Publisher || '';
    const dir = v.InstallLocation ? path.normalize(v.InstallLocation.replace(/"/g, '')) : null;
    if (!dir || !v.DisplayName || IGNORE.test(v.DisplayName)) continue;

    const isEaPublisher = /electronic arts|^ea\b/i.test(publisher);
    const hasEaInstaller = await exists(path.join(dir, '__Installer', 'installerdata.xml'));
    if (!hasEaInstaller && !isEaPublisher) continue;
    // Spiele aus anderen Launchern (z. B. Steam-Version) nicht doppelt zeigen
    if (/steamapps|epic games|ubisoft game launcher/i.test(dir)) continue;

    const exe = cleanExePath(v.DisplayIcon);
    if (!exe || !/\.exe$/i.test(exe) || /uninst|cleanup|touchup/i.test(exe)) continue;
    if (!(await exists(exe))) continue;

    games.push({
      nativeId: key,
      name: v.DisplayName,
      installDir: dir,
      status: 'installed',
      covers: [],
      launch: { type: 'exe', target: exe, args: [], cwd: path.dirname(exe) }
    });
  }

  // Bibliothek aus den EA-app-Protokollen
  const have = new Set(games.map((g) => normalize(g.name)));
  const eaApp = await findEaApp();
  for (const g of await libraryFromLogs().catch(() => [])) {
    const key = normalize(g.name);
    if (have.has(key) || have.has(normalize(g.slug.replace(/-/g, ' ')))) continue;
    if (g.installed) continue; // installiert, aber nicht über die Registry gefunden -> lieber nicht raten
    have.add(key);
    games.push({
      nativeId: `slug:${g.slug}`,
      name: g.name,
      status: 'notInstalled',
      covers: [],
      // EA app öffnen – dort in der Bibliothek auf Herunterladen klicken
      launch: eaApp ? exeLaunch(eaApp) : { type: 'uri', target: 'origin2://library/open' }
    });
  }

  // Bibliothek über GOG Galaxy (falls EA dort verknüpft ist).
  // origin2:// wird von der EA app verstanden und öffnet den Download.
  return galaxy.addOwned(games, ['origin', 'ea'], (o) => ({
    type: 'uri',
    target: `origin2://game/launch?offerIds=${encodeURIComponent(o.id)}&autoDownload=1`
  }));
}

async function findEaApp() {
  const fromReg = await reg.getFirstValue([
    ['HKLM\\SOFTWARE\\Electronic Arts\\EA Desktop', 'DesktopAppPath'],
    ['HKLM\\SOFTWARE\\Electronic Arts\\EA Desktop', 'LauncherAppPath']
  ]);
  const pf = env('ProgramFiles') || 'C:\\Program Files';
  return firstExisting([
    cleanExePath(fromReg),
    path.join(pf, 'Electronic Arts', 'EA Desktop', 'EA Desktop', 'EADesktop.exe')
  ]);
}

module.exports = {
  id: 'ea',
  processes: ['EADesktop'],
  client: async () => exeLaunch(await findEaApp()) || { type: 'uri', target: 'origin2://library/open' },
  store: { type: 'url', target: 'https://www.ea.com/de/games' },
  name: 'EA app',
  color: '#3a0d12',
  accent: '#ff4747',
  detect
};
