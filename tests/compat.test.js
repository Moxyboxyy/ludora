// Läuft ein Spiel auf diesem System? (Filter "Läuft auf …") und Geräte-Erkennung fürs Streamen
const test = require('node:test');
const assert = require('node:assert');
const compat = require('../electron/lib/compat');

const win = { windows: true, mac: false, linux: false };

test('Plattformen je Betriebssystem bewerten', () => {
  const { runsOn } = compat;
  assert.strictEqual(runsOn(win, 'win32', 'steam'), true);
  assert.strictEqual(runsOn(win, 'darwin', 'steam'), false);
  assert.strictEqual(runsOn({ windows: true, mac: true }, 'darwin', 'epic'), true);
  assert.strictEqual(runsOn({ windows: false, mac: true, linux: true }, 'win32', 'steam'), false);
  // Linux: nativ, Proton laut Steam-Deck-Einstufung, Anti-Cheat ("nicht unterstützt") raus
  assert.strictEqual(runsOn({ ...win, linux: true }, 'linux', 'steam'), true);
  assert.strictEqual(runsOn({ ...win, deck: 3 }, 'linux', 'steam'), true);
  assert.strictEqual(runsOn({ ...win, deck: 1 }, 'linux', 'steam'), false);
  assert.strictEqual(runsOn({ ...win, deck: 0 }, 'linux', 'steam'), null); // unbekannt -> wird gezeigt
  assert.strictEqual(runsOn(win, 'linux', 'gog'), true); // Heroic: über Wine
  assert.strictEqual(runsOn(undefined, 'darwin', 'steam'), null);
});

test('Installierte laufen immer, Unbekanntes wird nicht ausgeblendet', () => {
  const games = [
    { id: 'steam:1', provider: 'steam', nativeId: '1', status: 'installed' },
    { id: 'steam:2', provider: 'steam', nativeId: '2', status: 'notInstalled', platforms: win },
    { id: 'riot:x', provider: 'riot', nativeId: 'x', status: 'notInstalled' }
  ];
  compat._reset();
  compat.applyCached(games, 'darwin');
  assert.deepStrictEqual(games.map((g) => g.runsHere), [true, false, undefined]);
});

test('Plattformen von Steam und GOG nachfragen und merken', async () => {
  compat._reset();
  const calls = [];
  compat._setFetch(async (url) => {
    calls.push(url);
    if (url.includes('steampowered')) {
      return { ok: true, json: async () => ({ response: { store_items: [
        { appid: 10, platforms: { windows: true, mac: true, steamos_linux: false, steam_deck_compat_category: 2 } },
        { appid: 11, platforms: { windows: true } }
      ] } }) };
    }
    return { ok: true, json: async () => [{ id: 7, content_system_compatibility: { windows: true, osx: false, linux: true } }] };
  });
  const games = [
    { id: 'steam:10', provider: 'steam', nativeId: '10', status: 'notInstalled' },
    { id: 'steam:11', provider: 'steam', nativeId: '11', status: 'notInstalled' },
    { id: 'gog:7', provider: 'gog', nativeId: '7', status: 'notInstalled' }
  ];
  const missing = compat.applyCached(games, 'darwin');
  assert.strictEqual(missing.length, 3);
  const updated = [];
  await compat.fetchMissing(missing, (g) => updated.push(g.id), 'darwin');
  assert.deepStrictEqual(games.map((g) => g.runsHere), [true, false, false]);
  assert.strictEqual(updated.length, 3);
  assert.ok(JSON.parse(decodeURIComponent(calls[0].split('input_json=')[1])).data_request.include_platforms);
  // Beim nächsten Scan kommt alles aus dem Zwischenspeicher
  const again = games.map((g) => ({ ...g, platforms: undefined, runsHere: undefined }));
  assert.strictEqual(compat.applyCached(again, 'darwin').length, 0);
  assert.strictEqual(again[0].runsHere, true);
});

test('Epic: Plattformen aus dem Katalog', () => {
  const { _platformsOf } = require('../electron/providers/epic');
  assert.deepStrictEqual(_platformsOf({ releaseInfo: [{ platform: ['Windows', 'Mac'] }] }), { windows: true, mac: true, linux: false });
  assert.strictEqual(_platformsOf({ releaseInfo: [{}] }), undefined);
});

test('Streamen: eigener Rechner wird nicht mitgezählt', () => {
  const { sameMachine } = require('../electron/lib/steamFriends')._test;
  assert.ok(sameMachine('DESKTOP-PC', 'desktop-pc.fritz.box'));
  assert.ok(!sameMachine('DESKTOP-PC', 'LAPTOP'));
});
