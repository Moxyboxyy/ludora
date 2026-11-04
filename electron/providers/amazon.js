// Amazon Games (Prime Gaming)
// Installiert: Uninstall-Einträge (Amazon Game Remover)
// Bibliothek:  %LocalAppData%\Amazon Games\Data\Games\Sql\GameProductInfo.sqlite
const path = require('path');
const reg = require('../lib/registry');
const { openDb } = require('../lib/sqlite');
const { getArg, env, firstExisting, exeLaunch } = require('../lib/util');
const { normalize } = require('../lib/names');

async function readLibrary() {
  const local = env('LOCALAPPDATA');
  if (!local) return [];
  const db = await openDb(path.join(local, 'Amazon Games', 'Data', 'Games', 'Sql', 'GameProductInfo.sqlite'));
  if (!db) return [];
  try {
    if (!db.tables().has('DbSet')) return [];
    const cols = db.columns('DbSet');
    const idCol = ['ProductIdStr', 'Id'].find((c) => cols.has(c));
    if (!idCol || !cols.has('ProductTitle')) return [];
    const img = ['ProductIconUrl', 'ProductLogoUrl'].find((c) => cols.has(c));
    return db.all(`SELECT "${idCol}" AS id, ProductTitle AS name${img ? `, "${img}" AS icon` : ''} FROM DbSet`)
      .filter((r) => r.id && r.name);
  } finally {
    db.close();
  }
}

async function detect() {
  const entries = await reg.getUninstallEntries();
  const games = [];
  const installed = new Set();

  for (const { values: v } of entries) {
    const un = v.UninstallString || '';
    if (!/Amazon Game Remover/i.test(un)) continue;
    const id = getArg(un, 'p');
    if (!id) continue;
    installed.add(id);
    installed.add(normalize(v.DisplayName));
    games.push({
      nativeId: id,
      name: v.DisplayName,
      installDir: v.InstallLocation,
      status: 'installed',
      covers: [],
      launch: { type: 'uri', target: `amazon-games://play/${id}` }
    });
  }

  for (const g of await readLibrary().catch(() => [])) {
    if (installed.has(g.id) || installed.has(normalize(g.name))) continue;
    installed.add(g.id);
    games.push({
      nativeId: g.id,
      name: g.name,
      status: 'notInstalled',
      covers: [], // Cover sucht covers.js über den Namen
      launch: { type: 'uri', target: `amazon-games://play/${g.id}` }
    });
  }
  return games;
}

async function findAmazonExe() {
  const local = env('LOCALAPPDATA');
  return local ? firstExisting([path.join(local, 'Amazon Games', 'App', 'Amazon Games.exe')]) : null;
}

module.exports = {
  id: 'amazon',
  processes: ['Amazon Games'],
  client: async () => exeLaunch(await findAmazonExe()),
  store: { type: 'url', target: 'https://gaming.amazon.com/home' },
  name: 'Amazon Games',
  color: '#1a2330',
  accent: '#ff9900',
  detect
};
