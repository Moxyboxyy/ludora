// Download-Fortschritt, Geschwindigkeit und Restzeit aus den Quellen der Launcher
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

test('Battle.net: Antwort des Agents (Format wie im Agent-Log)', () => {
  const { parseUpdate } = require('../electron/lib/bnetAgent');
  const u = parseUpdate({
    download_complete: false, download_current: [6117346, 0, 0], download_total: [153330449, 0, 0],
    download_rate: 611734, download_remaining: 147213103, estimated_time_in_sec: 241, progress: 0.0399
  });
  assert.strictEqual(u.state, 'downloading');
  assert.strictEqual(u.speed, 611734);
  assert.strictEqual(u.eta, 241);
  assert.strictEqual(u.bytesTotal, 153330449);
  assert.ok(Math.abs(u.progress - 0.0399) < 1e-9);
  assert.strictEqual(parseUpdate({ download_complete: true, patch_application_complete: true, progress: 1 }), null);
});

test('Battle.net: echter HTTP-Ablauf /agent -> /update/<uid> -> POST /update', async () => {
  const pd = fs.mkdtempSync(path.join(os.tmpdir(), 'bnet-'));
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization || '-'}`);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/agent') return res.end(JSON.stringify({ authorization: 'TOKEN', pid: 1 }));
      if (req.headers.authorization !== 'TOKEN') { res.statusCode = 401; return res.end('{}'); }
      if (req.url === '/update/wow') return res.end(JSON.stringify({ download_rate: 1000, estimated_time_in_sec: 9, progress: 0.5, download_total: [2000], download_current: [1000] }));
      if (req.method === 'POST' && req.url === '/update') { res.statusCode = JSON.parse(body).uid === 'wow' ? 200 : 400; return res.end('{}'); }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.mkdirSync(path.join(pd, 'Battle.net', 'Agent'), { recursive: true });
  fs.writeFileSync(path.join(pd, 'Battle.net', 'Agent', 'Agent.dat'), String(server.address().port));
  const old = process.env.PROGRAMDATA;
  process.env.PROGRAMDATA = pd;
  try {
    const agent = require('../electron/lib/bnetAgent');
    agent._reset();
    const u = await agent.updateStatus('wow');
    assert.strictEqual(u.speed, 1000);
    assert.strictEqual(u.eta, 9);
    assert.strictEqual(await agent.updateStatus('fenris'), null);
    assert.strictEqual(await agent.startUpdate('wow'), true);
    assert.ok(seen.includes('GET /agent -'));
    assert.ok(seen.includes('POST /update TOKEN'));
  } finally {
    process.env.PROGRAMDATA = old;
    server.close();
  }
});

test('Steam: Geschwindigkeit aus content_log.txt', () => {
  const { _parseContentLog } = require('../electron/providers/steam');
  const now = new Date(2026, 10, 3, 17, 32, 30).getTime();
  const log = [
    '[2026-11-03 17:29:52] AppID 439550 update started : download 0/1042127296, store 0/0',
    '[2026-11-03 17:32:05] Current download rate: 51.007 Mbps'
  ].join('\n');
  const r = _parseContentLog(log, now);
  assert.strictEqual(r.appid, '439550');
  assert.strictEqual(Math.round(r.speed), 6375875);
  // Alte Rate (über 2,5 Minuten) zählt nicht
  assert.strictEqual(_parseContentLog('[2026-11-03 17:00:00] Current download rate: 51 Mbps', now).speed, 0);
});

test('Riot: Fortschritt aus dem Riot-Client-Log', () => {
  const rc = require('../electron/lib/riotClient');
  const start = rc.startTimeFromName('2026-11-03T17-26-26_47884_Riot Client.log');
  assert.strictEqual(start, new Date(2026, 10, 3, 17, 26, 26).getTime());
  const log = [
    '000006.619|   OKAY| patch-proxy: HandleProductPatchlineStatusUpdate: productId: valorant, patchlineId: live, status: Updating, progress: 10.5',
    '000060.000|   OKAY| patch-proxy: HandleProductPatchlineStatusUpdate: productId: valorant, patchlineId: live, status: Updating, progress: 42.13',
    '000061.000|   OKAY| patch-proxy: HandleProductPatchlineStatusUpdate: productId: league_of_legends, patchlineId: live, status: UpToDate, progress: 100'
  ].join('\n');
  const m = rc.parseLog(log, start);
  assert.strictEqual(m.get('valorant.live').status, 'Updating');
  assert.ok(Math.abs(m.get('valorant.live').progress - 0.4213) < 1e-9);
  assert.strictEqual(m.get('valorant.live').t, start + 60000);
  assert.strictEqual(m.get('league_of_legends.live').status, 'UpToDate');
});

test('GOG: Fortschritt aus jobs.db (Bytes, Prozent oder Anteil)', () => {
  const { asFraction } = require('../electron/lib/galaxy');
  assert.strictEqual(asFraction(0.25, 1000), 0.25);
  assert.strictEqual(asFraction(250, 1000), 0.25);
  assert.strictEqual(asFraction(25, 0), 0.25);
});

test('Epic: Werte aus DownloadState.json', () => {
  const { _readDownloadStateJson } = require('../electron/providers/epic');
  const m = _readDownloadStateJson({ queue: [{ AppName: 'Fortnite', progress: 0.5, bytesDownloaded: 5, bytesTotal: 10 }] });
  assert.deepStrictEqual(m.get('Fortnite'), { progress: 0.5, bytesDone: 5, bytesTotal: 10, speed: undefined, eta: undefined });
});

test('GOG: laufendes Update aus nachgebauter jobs.db', async () => {
  const { execFileSync } = require('child_process');
  const pd = fs.mkdtempSync(path.join(os.tmpdir(), 'gogjobs-'));
  const file = path.join(pd, 'GOG.com', 'Galaxy', 'storage', 'jobs.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('python3', ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript('''
CREATE TABLE UpdateProductJobs(jobId INT, gameName TEXT, productId INT, languageCode TEXT, selectedBranch TEXT, buildId TEXT,
  downloadSize INT, patchingSize INT, verificationSize INT, downloadProgress INT, patchingProgress INT, verificationProgress INT,
  overallDownloadProgress REAL, isVerifying INT);
INSERT INTO UpdateProductJobs VALUES (1,'Cyberpunk 2077',1423049311,'de','','x',4000000000,0,0,1000000000,0,0,0.25,0);
'''); c.commit()`, file]);
  const old = process.env.PROGRAMDATA;
  process.env.PROGRAMDATA = pd;
  try {
    const jobs = await require('../electron/lib/galaxy').readJobs();
    const u = jobs.get('1423049311');
    assert.strictEqual(u.state, 'downloading');
    assert.strictEqual(u.progress, 0.25);
    assert.strictEqual(u.bytesDone, 1000000000);
    assert.strictEqual(u.bytesTotal, 4000000000);
  } finally { process.env.PROGRAMDATA = old; }
});

test('Steam: Fortschritt aus den Minuten-Raten hochgerechnet, nie rückwärts', () => {
  const { _parseContentLog } = require('../electron/providers/steam');
  const log = [
    '[2026-11-03 18:00:00] AppID 77 update started : download 0/1000000000, store 0/0',
    '[2026-11-03 18:01:00] Current download rate: 40.000 Mbps' // 5 MB/s -> 300 MB nach 60 s
  ];
  const t = (s) => new Date(2026, 10, 3, 18, 0, s).getTime();
  const a = _parseContentLog(log.join('\n'), t(60));
  assert.strictEqual(a.appid, '77');
  assert.strictEqual(Math.round(a.bytesDone / 1e6), 300);
  assert.strictEqual(a.bytesTotal, 1000000000);
  // 30 s später, noch keine neue Meldung: mit 5 MB/s weitergezählt
  assert.strictEqual(Math.round(_parseContentLog(log.join('\n'), t(90)).bytesDone / 1e6), 450);
  // Niedrigere Rate gemeldet -> Hochrechnung kleiner, Anzeige bleibt trotzdem stehen statt zu sinken
  log.push('[2026-11-03 18:02:00] Current download rate: 1.000 Mbps');
  assert.ok(_parseContentLog(log.join('\n'), t(120)).bytesDone >= 450e6);
});

test('Steam: abgebrochener Download verschwindet, fortgesetzter startet beim alten Stand', () => {
  const { _parseContentLog } = require('../electron/providers/steam');
  const t = (s) => new Date(2026, 10, 3, 18, 0, s).getTime();
  const resumed = _parseContentLog('[2026-11-03 18:00:00] AppID 9 update started : download 250000000/1000000000, store 0/0', t(1));
  assert.strictEqual(resumed.bytesDone, 250000000);
  const canceled = _parseContentLog([
    '[2026-11-03 18:00:00] AppID 9 update started : download 250000000/1000000000, store 0/0',
    '[2026-11-03 18:00:01] AppID 9 update canceled : Uninstall (Canceled)',
    '[2026-11-03 18:00:01] AppID 9 state changed : Update Required,Update Paused,',
    '[2026-11-03 18:00:01] AppID 9 state changed : Uninstalled,'
  ].join('\n'), t(5));
  assert.strictEqual(canceled.finished, true);
  assert.strictEqual(canceled.states.get('9'), 'Uninstalled,');
});

test('Live-Messung: Zählerzeile -> Bytes je Launcher -> Tempo pro Sekunde', () => {
  const io = require('../electron/lib/ioSampler');
  io._history.clear();
  const ticks = (ms) => String((ms + 62135596800000) * 10000);
  const t0 = Date.UTC(2026, 10, 3, 18, 0, 0);
  // steam.exe liest 6 MB/s, Epic steht still
  for (let s = 0; s <= 4; s++) {
    io._record(io.parseLine(`${ticks(t0 + s * 1000)}|steam=${1e9 + s * 6e6};epicgameslauncher=5000`));
  }
  const r = io.rate('steam');
  assert.strictEqual(Math.round(r.speed), 6e6);
  assert.strictEqual(r.total, 1e9 + 24e6);
  assert.strictEqual(io.rate('epic').speed, 0);
  // Steam neu gestartet (Zähler wieder klein) -> Messung beginnt neu, kein negatives Tempo
  io._record(io.parseLine(`${ticks(t0 + 5000)}|steam=1000`));
  assert.strictEqual(io.rate('steam'), null);
});

test('Battle.net: pausiertes Update wird freigegeben, Datei bleibt im Battle.net-Format', async () => {
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), 'bnetcfg-'));
  const pf = fs.mkdtempSync(path.join(os.tmpdir(), 'bnetpf-'));
  const cfgFile = path.join(appdata, 'Battle.net', 'Battle.net.config');
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  const original = JSON.stringify({ Client: { AutoLogin: 'true' }, Games: { wow: { ServerUid: 'wow', Resumable: 'true', UserPausedUpdate: 'true' }, fenris: { UserPausedUpdate: 'true' } } }, null, 4).replace(/\n/g, '\r\n');
  fs.writeFileSync(cfgFile, original);
  // Battle.net.exe "finden", aber nicht wirklich starten (Testdatei)
  fs.mkdirSync(path.join(pf, 'Battle.net'), { recursive: true });
  fs.writeFileSync(path.join(pf, 'Battle.net', 'Battle.net.exe'), '');
  const old = { a: process.env.APPDATA, p: process.env['ProgramFiles(x86)'] };
  process.env.APPDATA = appdata;
  process.env['ProgramFiles(x86)'] = pf;
  try {
    const bnet = require('../electron/providers/battlenet');
    if (process.platform === 'darwin') return; // Pfade sind auf dem Mac andere
    const r = await bnet.backgroundUpdate({ nativeId: 'wow' });
    assert.deepStrictEqual(r, { type: 'none' });
    const txt = fs.readFileSync(cfgFile, 'utf8');
    const j = JSON.parse(txt);
    assert.strictEqual(j.Games.wow.UserPausedUpdate, 'false');
    assert.strictEqual(j.Games.fenris.UserPausedUpdate, 'true', 'andere Spiele unverändert');
    assert.strictEqual(txt, original.replace('"UserPausedUpdate": "true",\r\n', '"UserPausedUpdate": "false",\r\n').replace(/("Resumable": "true",\r\n\s+"UserPausedUpdate": )"true"/, '$1"false"'));
  } finally {
    process.env.APPDATA = old.a;
    process.env['ProgramFiles(x86)'] = old.p;
  }
});

test('Battle.net: "Initialisieren" zählt schon als Download (Aufbau wie echte product.db)', async () => {
  // Mini-Protobuf-Schreiber
  const varint = (n) => { const b = []; n = BigInt(n); do { let c = Number(n & 0x7fn); n >>= 7n; if (n) c |= 0x80; b.push(c); } while (n); return Buffer.from(b); };
  const fld = (f, w, v) => Buffer.concat([varint((f << 3) | w), w === 2 ? Buffer.concat([varint(v.length), v]) : w === 1 ? v : varint(v)]);
  const msg = (...parts) => Buffer.concat(parts);
  const str = (s) => Buffer.from(s);
  const dbl = (d) => { const b = Buffer.alloc(8); b.writeDoubleLE(d); return b; };
  const product = (uid, { installed, playable, done, target, started = 0, total = 0, remaining = 0 }) => fld(1, 2, msg(
    fld(1, 2, str(uid)),
    fld(3, 2, fld(1, 2, str(`E:/Spiele/${uid}`))),
    fld(4, 2, msg(
      fld(1, 2, msg(fld(1, 0, installed), fld(2, 0, playable), fld(3, 0, done), fld(4, 0, 0), fld(5, 0, started))),
      fld(2, 2, msg(fld(1, 1, dbl(0)), fld(2, 0, started))),
      fld(4, 2, msg(fld(2, 1, dbl(0)), fld(4, 0, total), fld(5, 0, remaining), ...(target ? [fld(6, 2, fld(1, 2, str('0149337d')))] : [])))
    ))
  ));
  const pd = fs.mkdtempSync(path.join(os.tmpdir(), 'bnetdb-'));
  const ad = fs.mkdtempSync(path.join(os.tmpdir(), 'bnetad-'));
  fs.mkdirSync(path.join(pd, 'Battle.net', 'Agent'), { recursive: true });
  fs.writeFileSync(path.join(pd, 'Battle.net', 'Agent', 'product.db'), msg(
    product('wow', { installed: 1, playable: 0, done: 0, target: true, started: 1 }),   // initialisiert gerade
    product('fenris', { installed: 1, playable: 0, done: 0, target: true, started: 1 }),// pausiert
    product('wow_classic_era', { installed: 1, playable: 0, done: 0, target: true }),   // Update nur fällig
    product('wow_classic_anniversary', { installed: 1, playable: 1, done: 1 })         // aktuell
  ));
  fs.mkdirSync(path.join(ad, 'Battle.net'), { recursive: true });
  fs.writeFileSync(path.join(ad, 'Battle.net', 'Battle.net.config'), JSON.stringify({ Games: { fenris: { UserPausedUpdate: 'true' } } }));
  const old = { p: process.env.PROGRAMDATA, a: process.env.APPDATA };
  process.env.PROGRAMDATA = pd;
  process.env.APPDATA = ad;
  try {
    if (process.platform === 'darwin') return;
    const list = await require('../electron/providers/battlenet').updates();
    const by = Object.fromEntries(list.map((u) => [u.nativeId, u.update]));
    assert.strictEqual(by.wow.state, 'downloading');
    assert.strictEqual(by.wow.detail, 'Initialisieren …');
    assert.strictEqual(by.fenris.state, 'paused');
    assert.strictEqual(by.wow_classic_era.state, 'available', 'fällig, aber nicht angefangen -> kein Initialisieren');
    assert.strictEqual(by.wow_classic_anniversary, undefined);
  } finally {
    process.env.PROGRAMDATA = old.p;
    process.env.APPDATA = old.a;
  }
});
