const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const coverCheck = require('../electron/lib/coverCheck');
const covers = require('../electron/lib/covers');

test('Cover-Prüfung: ok, Symbol, ohne Bild + Bericht', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
  coverCheck.init(dir); covers.init(dir);
  covers.repair = async () => null; // kein Netz im Test
  const games = [
    { id: 'steam:1', provider: 'steam', name: 'A', status: 'installed', covers: ['good'] },
    { id: 'riot:x', provider: 'riot', name: 'VALORANT', status: 'installed', covers: ['bad'], iconUrl: 'ghimg://icon/riot%3Ax' },
    { id: 'ea:y', provider: 'ea', name: 'Peggle', status: 'notInstalled', covers: [] }
  ];
  const report = path.join(dir, 'r.json');
  await coverCheck.run(games, { urlOk: async (u) => u === 'good', onUpdate: () => {}, reportPaths: [report] });
  const r = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.strictEqual(r.launcher.steam.mitCover, 1);
  assert.deepStrictEqual(r.launcher.riot.nurSymbol, ['VALORANT']);
  assert.deepStrictEqual(r.launcher.ea.ohneBild, ['Peggle (nicht installiert)']);
});
