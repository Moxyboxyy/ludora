// "Läuft"-Erkennung: Prozess aus dem Installationsordner eines Spiels
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const running = require('../electron/lib/running');

test('Laufendes Spiel wird über seinen Installationsordner erkannt', async () => {
  const base = path.join(path.sep, 'spiele');
  const games = [
    { id: 'steam:1', provider: 'steam', status: 'installed', installDir: path.join(base, 'steamapps', 'common', 'Skate') },
    { id: 'epic:Fortnite', provider: 'epic', status: 'installed', installDir: path.join(base, 'Fortnite') },
    { id: 'epic:x', provider: 'epic', status: 'notInstalled' },
    { id: 'manual:1', provider: 'manual', status: 'installed', installDir: base, launch: { type: 'exe', target: path.join(base, 'Tool', 'tool.exe') } }
  ];
  const procs = [
    { pid: 11, exe: path.join(base, 'steamapps', 'common', 'Skate', 'bin', 'skate.exe') },
    { pid: 12, exe: path.join(base, 'Fortnite2', 'other.exe') }, // ähnlicher Name, anderer Ordner
    { pid: 13, exe: path.join(base, 'Tool', 'helper.exe') }       // eigenes Spiel: nur exakt die Datei
  ];
  const m = await running.detect(games, [], procs);
  assert.deepStrictEqual([...m.entries()], [['steam:1', 11]]);
});

test('Zu flache Ordner werden ignoriert', () => {
  assert.strictEqual(running.usableDir(path.sep), false);
  assert.strictEqual(running.usableDir(path.join(path.sep, 'a')), false);
  assert.strictEqual(running.usableDir(path.join(path.sep, 'a', 'b')), true);
});
