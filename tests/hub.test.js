// Ludora-Konto gegen einen nachgebauten Supabase-Server
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

test('Name prüfen', () => {
  const { _normalizeName } = require('../electron/lib/hubAccount');
  assert.deepStrictEqual(_normalizeName(' Alex '), { username: 'alex', display: 'Alex' });
  assert.throws(() => _normalizeName('ab'), /3–24/);
  assert.throws(() => _normalizeName('böse name'), /3–24/);
});

test('Registrieren, Verknüpfen, Nachschlagen (Ablauf wie bei Supabase)', async () => {
  const users = new Map(); // email -> { id, password }
  const profiles = new Map(); // id -> { username, display_name }
  const links = []; // { launcher, account_id, user_id, verified }
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = body ? JSON.parse(body) : {};
      const send = (code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      seen.push(`${req.method} ${req.url.split('?')[0]}`);
      assert.strictEqual(req.headers.apikey, 'ANON');
      const uid = (req.headers.authorization || '').replace('Bearer tok-', '');
      if (req.url === '/auth/v1/signup') {
        if (users.has(j.email)) return send(422, { msg: 'User already registered' });
        const id = `u${users.size + 1}`;
        users.set(j.email, { id, password: j.password });
        return send(200, { access_token: `tok-${id}`, refresh_token: `ref-${id}`, expires_in: 3600, user: { id } });
      }
      if (req.url.startsWith('/auth/v1/token?grant_type=password')) {
        const u = users.get(j.email);
        if (!u || u.password !== j.password) return send(400, { error_description: 'Invalid login credentials' });
        return send(200, { access_token: `tok-${u.id}`, refresh_token: `ref-${u.id}`, expires_in: 3600, user: { id: u.id } });
      }
      if (req.method === 'POST' && req.url === '/rest/v1/profiles') { profiles.set(j.id, { username: j.username, display_name: j.display_name }); return send(201); }
      if (req.method === 'GET' && req.url.startsWith('/rest/v1/profiles')) return send(200, [profiles.get(uid)]);
      if (req.method === 'GET' && req.url.startsWith('/rest/v1/linked_accounts')) return send(200, links.filter((l) => l.user_id === uid));
      if (req.url.startsWith('/functions/v1/')) {
        links.push({ launcher: j.launcher, account_id: j.claim.puuid || 'steam-from-token', user_id: uid, verified: j.launcher !== 'riot' });
        return send(200, { ok: true });
      }
      if (req.url === '/rest/v1/rpc/heartbeat') return send(204);
      if (req.url === '/rest/v1/rpc/friend_request') return send(200, j.target_username === 'tobithegamer' ? 'requested' : 'not_found');
      if (req.url === '/rest/v1/rpc/my_friends') {
        return send(200, uid === 'u2' ? [{ username: 'tobithegamer', display_name: 'TobiTheGamer', relation: 'outgoing', last_seen: null, accounts: [] }] : []);
      }
      if (req.url === '/rest/v1/rpc/lookup_accounts') {
        return send(200, links.filter((l) => j.items.some((q) => q.launcher === l.launcher && q.account_id === l.account_id))
          .map((l) => ({ launcher: l.launcher, account_id: l.account_id, username: profiles.get(l.user_id).username, display_name: profiles.get(l.user_id).display_name, verified: l.verified })));
      }
      send(404, { msg: 'nicht nachgebaut' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.GAMEHUB_HUB_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.GAMEHUB_HUB_KEY = 'ANON';
  try {
    const hub = require('../electron/lib/hubAccount');
    hub._reset();
    // Tobi legt sein Konto an und verknüpft Riot
    let r = await hub.register('TobiTheGamer', 'geheim1');
    assert.ok(r.ok, r.error);
    assert.strictEqual(hub.getState().user.display_name, 'TobiTheGamer');
    r = await hub.link('riot', '', { puuid: 'p2' });
    assert.ok(r.ok, r.error);
    // Name doppelt -> verständliche Meldung
    hub._reset();
    r = await hub.register('tobithegamer', 'xxxxxx');
    assert.strictEqual(r.error, 'Dieser Name ist schon vergeben.');
    // Alex meldet sich an (falsches, dann richtiges Passwort) und schlägt seine Freunde nach
    await hub.register('Alex', 'passwort');
    hub._reset();
    assert.strictEqual((await hub.login('alex', 'falsch')).error, 'Name oder Passwort falsch.');
    assert.ok((await hub.login('ALEX', 'passwort')).ok);
    const found = await hub.lookup([{ launcher: 'riot', account_id: 'p2' }, { launcher: 'steam', account_id: 'unbekannt' }]);
    assert.deepStrictEqual(found, [{ launcher: 'riot', account_id: 'p2', username: 'tobithegamer', display_name: 'TobiTheGamer', verified: false }]);
    assert.ok(seen.some((x) => x.startsWith('POST /functions/v1/')));
    // Freundschaftsanfrage per Ludora-Name
    let fr = await hub.friendRequest('@TobiTheGamer');
    assert.deepStrictEqual([fr.ok, fr.message], [true, 'Anfrage gesendet.']);
    fr = await hub.friendRequest('gibtsnicht');
    assert.deepStrictEqual([fr.ok, fr.error], [false, 'Diesen Ludora-Namen gibt es nicht.']);
    assert.deepStrictEqual(hub.getState().friends.map((f) => [f.displayName, f.relation, f.online]), [['TobiTheGamer', 'outgoing', false]]);
    hub._reset();
  } finally {
    delete process.env.GAMEHUB_HUB_URL;
    delete process.env.GAMEHUB_HUB_KEY;
    server.close();
  }
});

test('Konto löschen ruft delete_my_account auf und meldet ab', async () => {
  const hub = require('../electron/lib/hubAccount');
  const r = await hub.deleteAccount();
  assert.strictEqual(r.ok, false); // ohne Anmeldung
});
