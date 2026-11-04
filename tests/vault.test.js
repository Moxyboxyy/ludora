// Anmeldungen merken (secrets.js) und über das Ludora-Konto auf andere Geräte mitnehmen (vault.js)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Ersatz für Electrons safeStorage (in Tests gibt es kein Electron)
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => { const s = b.toString(); if (!s.startsWith('enc:')) throw new Error('kaputt'); return s.slice(4); }
};
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true, exports: { safeStorage: fakeSafe } };

const secrets = require('../electron/lib/secrets');
const vault = require('../electron/lib/vault');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ludora-'));

/** Nachgebauter Ludora-Server: eine Tabelle vaults */
function fakeServer() {
  const rows = new Map();
  const req = async (pathname, opts = {}) => {
    if (!opts.method || opts.method === 'GET') {
      const id = decodeURIComponent(/user_id=eq\.([^&]+)/.exec(pathname)[1]);
      return rows.has(id) ? [rows.get(id)] : [];
    }
    rows.set(opts.body.user_id, { data: opts.body.data, updated_at: opts.body.updated_at });
    return null;
  };
  return { rows, req };
}

test('secrets: verschlüsselt speichern, Zeitstempel, alte Speicherstelle übernehmen', () => {
  const dir = tmp();
  const legacy = { data: { friendsGog: fakeSafe.encryptString(JSON.stringify({ refresh_token: 'alt' })).toString('base64') },
    get(k) { return this.data[k]; }, set(p) { Object.assign(this.data, p); } };
  secrets.init({ dir, settings: legacy });
  // Altes Token aus settings.json wird übernommen und dort gelöscht
  assert.deepStrictEqual(secrets.get('friendsGog'), { refresh_token: 'alt' });
  assert.strictEqual(legacy.data.friendsGog, null);
  secrets.set('friendsEpic', { refresh_token: 'r1' }, { at: 1000 });
  assert.strictEqual(secrets.changedAt('friendsEpic'), 1000);
  const raw = fs.readFileSync(path.join(dir, 'logins.json'), 'utf8');
  assert.ok(!raw.includes('r1'), 'nie im Klartext');
  // Eine andere Instanz (installiert + Entwicklung) liest denselben Stand
  secrets._reset();
  assert.deepStrictEqual(secrets.get('friendsEpic'), { refresh_token: 'r1' });
  secrets.set('friendsEpic', null, { at: 2000 });
  assert.strictEqual(secrets.get('friendsEpic'), null);
  assert.strictEqual(secrets.changedAt('friendsEpic'), 2000);
});

test('vault: Anmeldung auf zweitem Gerät übernehmen, neuere gewinnt, Server sieht nichts', async () => {
  const server = fakeServer();
  // Gerät A: bei Epic + Steam angemeldet, dann Ludora-Anmeldung
  const dirA = tmp();
  secrets.init({ dir: dirA });
  secrets.set('friendsEpic', { refresh_token: 'epic-A', account_id: 'e1' }, { at: 100 });
  secrets.set('steamWebToken', 'steam-A', { at: 100 });
  await vault.unlock('geheim123', 'Alex');
  vault.attach(server.req, 'u1');
  assert.deepStrictEqual(await vault.sync(), []);
  const stored = server.rows.get('u1').data;
  assert.ok(!/epic-A|steam-A/.test(stored), 'Server bekommt nur Verschlüsseltes');
  vault.detach();

  // Gerät B: frisch, gleiche Ludora-Anmeldung -> gleich bei Epic und Steam angemeldet
  const dirB = tmp();
  secrets.init({ dir: dirB });
  const restoredNames = [];
  const off = vault.onRestore((n) => restoredNames.push(n));
  await vault.unlock('geheim123', 'alex');
  vault.attach(server.req, 'u1');
  assert.deepStrictEqual(await vault.sync(), ['friendsEpic']);
  assert.deepStrictEqual(secrets.get('friendsEpic'), { refresh_token: 'epic-A', account_id: 'e1' });
  // Steam bleibt lokal (Steam tauscht das Token bei jeder Erneuerung aus)
  assert.strictEqual(secrets.get('steamWebToken'), null);
  assert.deepStrictEqual(restoredNames, ['friendsEpic']);

  // B erneuert das Epic-Token -> A bekommt beim nächsten Abgleich das neue
  secrets.set('friendsEpic', { refresh_token: 'epic-B', account_id: 'e1' }, { at: 200, silent: true });
  await vault.sync();
  vault.detach();
  secrets.init({ dir: dirA });
  vault.attach(server.req, 'u1');
  assert.deepStrictEqual(await vault.sync(), ['friendsEpic']);
  assert.strictEqual(secrets.get('friendsEpic').refresh_token, 'epic-B');

  // Älterer Stand vom Server überschreibt nichts Neueres
  secrets.set('friendsEpic', { refresh_token: 'epic-neu', account_id: 'e1' }, { at: 500, silent: true });
  assert.deepStrictEqual(await vault.sync(), []);
  assert.strictEqual(secrets.get('friendsEpic').refresh_token, 'epic-neu');
  off();
  vault.detach();
});

test('vault: falsches Passwort kann nichts lesen, Abmelden vergisst den Schlüssel', async () => {
  const server = fakeServer();
  secrets.init({ dir: tmp() });
  secrets.set('friendsGog', { refresh_token: 'gog-1', user_id: '7' }, { at: 100, silent: true });
  await vault.unlock('richtig', 'sam');
  vault.attach(server.req, 'u2');
  await vault.sync();
  vault.detach();

  secrets.init({ dir: tmp() });
  await vault.unlock('falsch', 'sam');
  vault.attach(server.req, 'u2');
  assert.deepStrictEqual(await vault.sync(), []);
  assert.strictEqual(secrets.get('friendsGog'), null);
  vault.detach({ forget: true });
  assert.strictEqual(vault.hasKey(), false);

  const k = await vault._deriveKey('pw', 'x');
  assert.deepStrictEqual(vault._decrypt(vault._encrypt({ a: 1 }, k), k), { a: 1 });
  const k2 = await vault._deriveKey('pw2', 'x');
  assert.throws(() => vault._decrypt(vault._encrypt({ a: 1 }, k), k2));
  // Was an den Server geht, ist unabhängig vom Tresor-Schlüssel
  assert.notDeepStrictEqual(await vault._deriveKey('pw', 'x', 'auth'), k);
});
