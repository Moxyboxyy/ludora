// Testet die macOS-Erkennung mit nachgebauten Mac-Ordnern (das Betriebssystem wird vorgetäuscht).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-home-'));
const SHARED = '/Users/Shared';
const canUseShared = (() => { try { fs.mkdirSync(SHARED, { recursive: true }); return true; } catch { return false; } })();

Object.defineProperty(process, 'platform', { value: 'darwin' });
os.homedir = () => HOME;
const sup = (...p) => path.join(HOME, 'Library', 'Application Support', ...p);
const w = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };

// Steam
w(sup('Steam', 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "0" { "path" "${sup('Steam')}" } }`);
w(sup('Steam', 'steamapps', 'appmanifest_413150.acf'),
  '"AppState" { "appid" "413150" "name" "Stardew Valley" "StateFlags" "4" "installdir" "Stardew Valley" }');

// Epic
w(sup('Epic', 'EpicGamesLauncher', 'Data', 'Manifests', 'a.item'), JSON.stringify({
  AppName: 'Fortnite', DisplayName: 'Fortnite', CatalogNamespace: 'fn', CatalogItemId: 'x',
  AppCategories: ['games'], InstallLocation: '/Users/Shared/Epic Games/Fortnite'
}));

test('macOS: nur passende Launcher werden angeboten', () => {
  const { providers } = require('../electron/providers');
  assert.deepStrictEqual(providers.map((p) => p.id).sort(), ['battlenet', 'epic', 'gog', 'manual', 'riot', 'steam']);
});

test('macOS: Steam aus ~/Library/Application Support/Steam, Start über steam://', async () => {
  const games = await require('../electron/providers/steam').detect();
  const g = games.find((x) => x.name === 'Stardew Valley');
  assert.ok(g);
  assert.strictEqual(g.status, 'installed');
  assert.strictEqual(g.launch.type, 'uri');
  assert.strictEqual(g.launch.target, 'steam://rungameid/413150');
});

test('macOS: Epic aus ~/Library/Application Support/Epic', async () => {
  const games = await require('../electron/providers/epic').detect();
  assert.strictEqual(games[0].name, 'Fortnite');
  assert.match(games[0].launch.target, /^com\.epicgames\.launcher:\/\/apps\/fn%3Ax%3AFortnite\?action=launch/);
});

test('macOS: Riot aus /Users/Shared/Riot Games', { skip: !canUseShared }, async () => {
  const base = path.join(SHARED, 'Riot Games');
  const client = path.join(base, 'Riot Client.app');
  fs.mkdirSync(client, { recursive: true });
  const lol = path.join(SHARED, 'Riot Games', 'League of Legends.app');
  fs.mkdirSync(lol, { recursive: true });
  w(path.join(base, 'RiotClientInstalls.json'), JSON.stringify({ rc_default: client }));
  w(path.join(base, 'Metadata', 'league_of_legends.live', 'league_of_legends.live.product_settings.yaml'),
    `product_install_full_path: "${lol}"\n`);
  const games = await require('../electron/providers/riot').detect();
  const g = games.find((x) => x.name === 'League of Legends');
  assert.strictEqual(g.status, 'installed');
  assert.strictEqual(g.launch.target, client);
  assert.deepStrictEqual(g.launch.args, ['--launch-product=league_of_legends', '--launch-patchline=live']);
});

test('macOS: GOG installiert laut Galaxy-Datenbank', { skip: !canUseShared }, async () => {
  const db = path.join(SHARED, 'GOG.com', 'Galaxy', 'Storage', 'galaxy-2.0.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.rmSync(db, { force: true });
  execFileSync('python3', ['-c', `import sqlite3; c=sqlite3.connect(${JSON.stringify(db)}); c.executescript('''
CREATE TABLE GamePieceTypes(id INTEGER PRIMARY KEY, type TEXT);
INSERT INTO GamePieceTypes VALUES (1,'title');
CREATE TABLE GamePieces(releaseKey TEXT, gamePieceTypeId INT, userId INT, value TEXT);
INSERT INTO GamePieces VALUES ('gog_1','1',1,'{"title":"Celeste"}');
CREATE TABLE ProductPurchaseDates(gameReleaseKey TEXT, purchaseDate TEXT);
INSERT INTO ProductPurchaseDates VALUES ('gog_1','');
CREATE TABLE InstalledBaseProducts(productId INT, installationPath TEXT);
INSERT INTO InstalledBaseProducts VALUES (1,'/Applications/Celeste.app');
'''); c.commit()`]);
  require('../electron/lib/galaxy').clearCache();
  const games = await require('../electron/providers/gog').detect();
  const g = games.find((x) => x.name === 'Celeste');
  assert.strictEqual(g.status, 'installed');
  assert.strictEqual(g.launch.target, '/Applications/Celeste.app');
});

test('macOS: .app-Pfade erkennen', () => {
  const { appBundle } = require('../electron/lib/platform');
  assert.strictEqual(appBundle('/Applications/Battle.net.app/Contents/MacOS/Battle.net'), '/Applications/Battle.net.app');
  assert.strictEqual(appBundle('/usr/bin/foo'), null);
});

test('macOS: Programm-Symbol wird aus dem .app-Paket gefunden', async () => {
  const { findIcns } = require('../electron/lib/macIcon');
  const app = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gh-app-')) + '/Test.app';
  const res = path.join(app, 'Contents', 'Resources');
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, 'other.icns'), 'x');
  fs.writeFileSync(path.join(res, 'AppIcon.icns'), 'x');
  assert.equal(await findIcns(app), path.join(res, 'AppIcon.icns'));
});
