// Freundeslisten von Riot, Epic, GOG + Personen
const test = require('node:test');
const assert = require('node:assert');

test('Riot: Freunde + Presences (Valorant-Details als Base64-JSON)', () => {
  const { _merge } = require('../electron/lib/friends/riot');
  const priv = Buffer.from(JSON.stringify({ sessionLoopState: 'PREGAME' })).toString('base64');
  const list = _merge(
    [{ puuid: 'a', game_name: 'Sam', game_tag: 'EUW' }, { puuid: 'b', game_name: 'Pät', game_tag: '1337' }, { puuid: 'c', game_name: 'Lol', game_tag: 'EUW' }],
    [
      { puuid: 'a', state: 'chat', product: 'valorant', private: priv },
      { puuid: 'c', state: 'dnd', product: 'league_of_legends', private: JSON.stringify({ gameStatus: 'championSelect' }) }
    ]
  );
  assert.deepStrictEqual(list.map((f) => [f.name, f.tag, f.state, f.gameName, f.richText]), [
    ['Sam', 'EUW', 'online', 'VALORANT', 'Agenten-Auswahl'],
    ['Pät', '1337', 'offline', null, null],
    ['Lol', 'EUW', 'busy', 'League of Legends', 'Champion-Auswahl']
  ]);
});

test('GOG: Freunde + Online-Liste', () => {
  const { _merge } = require('../electron/lib/friends/gog');
  const list = _merge(
    [{ user_id: '1', username: 'adalia', images: { medium: 'm.jpg', medium_2x: 'm2.jpg' } }, { user_id: '2', username: 'vids' }],
    [{ user_id: '1', data: {} }]
  );
  assert.deepStrictEqual(list.map((f) => [f.name, f.state, f.avatar]), [['adalia', 'online', 'm2.jpg'], ['vids', 'offline', null]]);
});

test('Epic: XMPP-Presence -> Status, Spiel, Text', () => {
  const epic = require('../electron/lib/friends/epic');
  epic._test.setAuth({ account_id: 'me' });
  epic._test.setFriends(['f1', 'f2', 'f3']);
  epic._test.names.set('f1', 'Ninja').set('f2', 'Bob').set('f3', 'Eve');
  const status = JSON.stringify({ Status: 'Battle Royale – Lobby', bIsPlaying: true }).replace(/"/g, '&quot;');
  epic._handlePresence(`<presence from="f1@prod.ol.epicgames.com/V2:Fortnite:WIN::ABC" to="me@prod.ol.epicgames.com"><status>${status}</status></presence>`);
  epic._handlePresence('<presence from="f2@prod.ol.epicgames.com/V2:launcher:WIN::X"><show>away</show><status>{}</status></presence>');
  epic._handlePresence('<presence from="f3@prod.ol.epicgames.com/V2:launcher:WIN::Y"><status>{}</status></presence>');
  epic._handlePresence('<presence from="f3@prod.ol.epicgames.com/V2:launcher:WIN::Y" type="unavailable"/>');
  const by = Object.fromEntries(epic._buildList().map((f) => [f.name, f]));
  assert.strictEqual(by.Ninja.state, 'online');
  assert.strictEqual(by.Ninja.gameName, 'Fortnite');
  assert.strictEqual(by.Ninja.richText, 'Battle Royale – Lobby');
  assert.strictEqual(by.Bob.state, 'away');
  assert.strictEqual(by.Bob.gameName, null);
  assert.strictEqual(by.Eve.state, 'offline');
});

test('Personen: ungültige Einträge raus, ein Konto nur einmal', () => {
  const { clean } = require('../electron/lib/friends/people');
  const out = clean([
    { name: 'Sam', members: [{ launcher: 'steam', id: '1' }, { launcher: 'riot', id: 'x' }, { launcher: 'hacker', id: 'y' }] },
    { name: 'Doppelt', members: [{ launcher: 'steam', id: '1' }, { launcher: 'gog', id: '5' }] },
    { name: '   ', members: [] }
  ]);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[0].members, [{ launcher: 'steam', id: '1' }, { launcher: 'riot', id: 'x' }]);
  assert.deepStrictEqual(out[1].members, [{ launcher: 'gog', id: '5' }]);
  assert.match(out[0].id, /^[a-f0-9]{16}$/);
});
