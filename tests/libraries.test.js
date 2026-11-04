// Testet die Bibliotheks-Erkennung mit nachgebauten Launcher-Dateien.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamehub-'));
process.env.PROGRAMDATA = path.join(root, 'ProgramData');
process.env.LOCALAPPDATA = path.join(root, 'Local');

function sqlite(file, sql) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.commit()', file, sql]);
}

// --- GOG Galaxy ---
sqlite(path.join(process.env.PROGRAMDATA, 'GOG.com', 'Galaxy', 'storage', 'galaxy-2.0.db'), `
CREATE TABLE GamePieceTypes(id INTEGER PRIMARY KEY, type TEXT);
INSERT INTO GamePieceTypes VALUES (1,'title'),(2,'originalImages'),(3,'meta');
CREATE TABLE GamePieces(releaseKey TEXT, gamePieceTypeId INT, userId INT, value TEXT);
INSERT INTO GamePieces VALUES
 ('gog_1207664663',1,1,'{"title":"The Witcher 3: Wild Hunt"}'),
 ('gog_1207664663',2,1,'{"verticalCover":"https://img/w3.jpg","background":"//img/w3bg.jpg"}'),
 ('gog_1423049311',1,1,'{"title":"Cyberpunk 2077"}'),
 ('gog_999',1,1,'{"title":"Ein DLC"}'),
 ('uplay_635',1,1,'{"title":"Assassin''s Creed Shadows"}'),
 ('battlenet_fen',1,1,'{"title":"Diablo IV"}'),
 ('steam_413150',1,1,'{"title":"Stardew Valley"}');
CREATE TABLE ProductPurchaseDates(gameReleaseKey TEXT, purchaseDate TEXT);
INSERT INTO ProductPurchaseDates VALUES ('gog_1207664663',''),('gog_1423049311',''),('gog_999',''),('uplay_635',''),('battlenet_fen',''),('steam_413150','');
CREATE TABLE ReleaseProperties(releaseKey TEXT, isDlc INT, isVisibleInLibrary INT);
INSERT INTO ReleaseProperties VALUES ('gog_999',1,1);
`);

// --- Amazon ---
sqlite(path.join(process.env.LOCALAPPDATA, 'Amazon Games', 'Data', 'Games', 'Sql', 'GameProductInfo.sqlite'), `
CREATE TABLE DbSet(Id TEXT, ProductIdStr TEXT, ProductTitle TEXT, ProductIconUrl TEXT);
INSERT INTO DbSet VALUES ('a','amzn1.adg.product.1','Fallout 3: Game of the Year Edition','x'),('b','amzn1.adg.product.2','Star Wars: Knights of the Old Republic','y');
`);

// --- Epic ---
const cat = [
  { id: 'item1', namespace: 'ns1', title: 'Rocket League', categories: [{ path: 'games' }], releaseInfo: [{ appId: 'Sugar' }],
    keyImages: [{ type: 'DieselGameBoxTall', url: 'https://epic/rl-tall.jpg' }, { type: 'DieselGameBox', url: 'https://epic/rl.jpg' }] },
  { id: 'item2', namespace: 'ns2', title: 'Rocket League - Pack', categories: [{ path: 'addons' }], mainGameItem: { id: 'item1' }, releaseInfo: [{ appId: 'SugarDlc' }] },
  { id: 'item3', namespace: 'ns3', title: 'Control', categories: [{ path: 'games' }, { path: 'applications' }], releaseInfo: [{ appId: 'Calluna' }], keyImages: [] }
];
const catFile = path.join(process.env.LOCALAPPDATA, 'EpicGamesLauncher', 'Saved', 'Data', 'Catalog', 'catcache.bin');
fs.mkdirSync(path.dirname(catFile), { recursive: true });
fs.writeFileSync(catFile, Buffer.from(JSON.stringify(cat)).toString('base64'));
const manDir = path.join(process.env.PROGRAMDATA, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
fs.mkdirSync(manDir, { recursive: true });
fs.writeFileSync(path.join(manDir, 'x.item'), JSON.stringify({
  AppName: 'Sugar', DisplayName: 'Rocket League®', CatalogNamespace: 'ns1', CatalogItemId: 'item1',
  AppCategories: ['public', 'games', 'applications'], InstallLocation: 'C:\\Games\\RL'
}));

test('GOG: Bibliothek aus Galaxy, ohne DLC', async () => {
  const games = await require('../electron/providers/gog').detect();
  const names = games.map((g) => g.name).sort();
  assert.deepStrictEqual(names, ['Cyberpunk 2077', 'The Witcher 3: Wild Hunt']);
  const w3 = games.find((g) => g.name.startsWith('The Witcher'));
  assert.strictEqual(w3.status, 'notInstalled');
  assert.deepStrictEqual(w3.covers, ['https://img/w3.jpg']);
  assert.deepStrictEqual(w3.wides, ['https://img/w3bg.jpg']);
  assert.strictEqual(w3.launch.target, 'goggalaxy://openGameView/gog_1207664663');
});

test('Galaxy: verknüpfte Plattformen landen beim richtigen Launcher', async () => {
  require('../electron/lib/galaxy').clearCache();
  const ubi = await require('../electron/providers/ubisoft').detect();
  assert.strictEqual(ubi.length, 1);
  assert.strictEqual(ubi[0].launch.target, 'uplay://launch/635/0');
  const bnet = await require('../electron/providers/battlenet').detect();
  assert.strictEqual(bnet[0].name, 'Diablo IV');
  assert.strictEqual(bnet[0].status, 'notInstalled');
});

test('Amazon: Bibliothek aus GameProductInfo.sqlite', async () => {
  const games = await require('../electron/providers/amazon').detect();
  assert.strictEqual(games.length, 2);
  assert.ok(games.every((g) => g.status === 'notInstalled'));
  assert.strictEqual(games[0].launch.target, 'amazon-games://play/amzn1.adg.product.1');
});

test('Epic: installiert + Bibliothek, ohne DLC, ohne Duplikat', async () => {
  const games = await require('../electron/providers/epic').detect();
  assert.deepStrictEqual(games.map((g) => [g.name, g.status]), [
    ['Rocket League®', 'installed'],
    ['Control', 'notInstalled']
  ]);
  assert.deepStrictEqual(games[0].covers, ['https://epic/rl-tall.jpg']);
  assert.strictEqual(games[1].launch.target, 'com.epicgames.launcher://apps/ns3%3Aitem3%3ACalluna?action=install');
});

test('Epic: Spiel mit laufendem Update (nur unter Pending) bleibt installiert', async () => {
  const pend = path.join(manDir, 'Pending');
  fs.mkdirSync(pend, { recursive: true });
  // Update: bisherige Version vermerkt -> installiert, mit Update
  fs.writeFileSync(path.join(pend, 'c.item'), JSON.stringify({
    AppName: 'Calluna', DisplayName: 'Control', CatalogNamespace: 'ns3', CatalogItemId: 'item3', MainGameAppName: 'Calluna',
    AppCategories: ['games', 'applications'], InstallLocation: 'E:\\Spiele\\Control', bIsIncompleteInstall: true,
    CompleteVersion: '1.0', AppVersionString: '1.1', InstallSize: 1000
  }));
  // Erstinstallation: keine bisherige Version -> bleibt "nicht installiert"
  fs.writeFileSync(path.join(pend, 'n.item'), JSON.stringify({
    AppName: 'NeuesSpiel', DisplayName: 'Neues Spiel', CatalogNamespace: 'ns9', CatalogItemId: 'item9',
    AppCategories: ['games', 'applications'], bIsIncompleteInstall: true, CompleteVersion: ''
  }));
  const games = await require('../electron/providers/epic').detect();
  const control = games.find((g) => g.name === 'Control');
  assert.strictEqual(control.status, 'installed');
  assert.ok(control.update, 'Update wird angezeigt');
  assert.ok(!control.update.firstInstall, 'kein Erstinstall');
  assert.ok(!games.some((g) => g.name === 'Neues Spiel' && g.status === 'installed'));
  fs.rmSync(pend, { recursive: true, force: true });
});
