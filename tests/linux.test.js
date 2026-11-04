// Linux: Heroic- und Lutris-Bibliotheken lesen (mit nachgebauten Ordnern)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ludora-linux-'));
process.env.LUDORA_TEST_HOME = home;
delete process.env.XDG_CONFIG_HOME;
delete process.env.XDG_DATA_HOME;
const w = (rel, data) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data)); };

// Heroic: Epic (legendary), GOG, Amazon (nile)
w('.config/heroic/store_cache/legendary_library.json', { library: [
  { app_name: 'Fortnite', title: 'Fortnite', art_square: 'https://cdn1.epicgames.com/f-tall.jpg', art_cover: 'https://cdn1.epicgames.com/f-wide.jpg' },
  { app_name: 'Sugar', title: 'Celeste', art_square: 'https://cdn1.epicgames.com/c.jpg' },
  { app_name: 'DLC1', title: 'Ein DLC', is_dlc: true }
] });
w('.config/heroic/legendaryConfig/legendary/installed.json', { Fortnite: { app_name: 'Fortnite', install_path: '/games/Fortnite', is_dlc: false } });
w('.config/heroic/store_cache/gog_library.json', { games: [{ app_name: '1207658924', title: 'The Witcher 3', is_installed: false }] });
w('.config/heroic/gog_store/installed.json', { installed: [{ appName: '1207658924', install_path: '/games/Witcher3' }] });
w('.config/heroic/store_cache/nile_library.json', { library: [{ app_name: 'amzn1.adg.product.1', title: 'Amazon-Spiel' }] });

const ll = require('../electron/lib/linuxLaunchers');

test('Heroic: Epic-Spiele mit Status, Covern und Start-Link (ohne DLCs)', () => {
  const g = ll.heroicGames('epic');
  assert.deepStrictEqual(g.map((x) => [x.name, x.status]).sort(), [['Celeste', 'notInstalled'], ['Fortnite', 'installed']]);
  const f = g.find((x) => x.name === 'Fortnite');
  assert.strictEqual(f.installDir, '/games/Fortnite');
  assert.strictEqual(f.launch.target, 'heroic://launch?appName=Fortnite&runner=legendary');
  assert.deepStrictEqual(f.covers, ['https://cdn1.epicgames.com/f-tall.jpg', 'https://cdn1.epicgames.com/f-wide.jpg']);
  assert.strictEqual(g.find((x) => x.name === 'Celeste').launch.type, 'heroic');
});

test('Heroic: GOG installiert laut gog_store, Amazon über nile', () => {
  const gog = ll.heroicGames('gog');
  assert.strictEqual(gog[0].status, 'installed');
  assert.strictEqual(gog[0].launch.target, 'heroic://launch?appName=1207658924&runner=gog');
  assert.strictEqual(ll.heroicGames('amazon')[0].name, 'Amazon-Spiel');
});

test('Lutris: Spiele dem richtigen Launcher zuordnen, Launcher selbst ausblenden', async () => {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE games (id INTEGER, name TEXT, slug TEXT, installer_slug TEXT, runner TEXT, directory TEXT,
    installed INTEGER, lastplayed INTEGER, playtime REAL, service TEXT, service_id TEXT, configpath TEXT, hidden INTEGER)`);
  const rows = [
    [1, 'Battle.net', 'battlenet', 'battlenet-standard', 'wine', '/g/bnet', 1, 0, 0, null, null, 'battlenet-1', 0],
    [2, 'Overwatch 2', 'overwatch-2', 'overwatch-2-battlenet', 'wine', '/g/bnet', 1, 1700000000, 12.5, null, null, 'overwatch-2-2', 0],
    [3, 'FC 26', 'ea-sports-fc-26', 'fc-26', 'wine', '/g/ea', 1, 0, 0, 'ea_app', 'x', 'fc-26-3', 0],
    [4, 'Anno 1800', 'anno-1800', 'anno-1800-ubisoft-connect', 'wine', '/g/ubi', 1, 0, 0, null, null, 'anno-4', 0],
    [5, 'Doom (GZDoom)', 'doom', 'doom-gzdoom', 'linux', '/g/doom', 1, 0, 2, null, null, 'doom-5', 0],
    [6, 'Nicht installiert', 'x', 'x', 'wine', '', 0, 0, 0, null, null, 'x-6', 0]
  ];
  for (const r of rows) db.run('INSERT INTO games VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', r);
  w('.local/share/lutris/pga.db', Buffer.from(db.export()));
  fs.writeFileSync(path.join(home, '.local/share/lutris/pga.db'), Buffer.from(db.export()));
  w('.local/share/lutris/coverart/overwatch-2.jpg', 'x');
  ll._clearCache();

  const bnet = await ll.lutrisGames('battlenet');
  assert.deepStrictEqual(bnet.map((g) => g.name), ['Overwatch 2']);
  assert.strictEqual(bnet[0].launch.target, 'lutris:rungameid/2');
  assert.strictEqual(bnet[0].playtimeMin, 750);
  assert.deepStrictEqual((await ll.lutrisGames('ea')).map((g) => g.name), ['FC 26']);
  assert.deepStrictEqual((await ll.lutrisGames('ubisoft')).map((g) => g.name), ['Anno 1800']);
  assert.deepStrictEqual((await ll.lutrisGames('lutris')).map((g) => g.name), ['Doom (GZDoom)']);
  assert.deepStrictEqual(await ll.lutrisLauncherApp('battlenet'), { type: 'uri', target: 'lutris:rungameid/1' });
  assert.ok(ll.lutrisImage('overwatch-2', 'cover').endsWith('overwatch-2.jpg'));
  assert.strictEqual(ll.lutrisImage('../../etc/passwd', 'cover'), null);
});
