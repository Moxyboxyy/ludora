// Riot Client: Download-Fortschritt + Update anstoßen
//
// Fortschritt: Der Riot Client schreibt beim Patchen laufend Zeilen wie
//   "patch-proxy: HandleProductPatchlineStatusUpdate: productId: valorant, patchlineId: live,
//    status: Updating, progress: 42.13"
// in %LOCALAPPDATA%\Riot Games\Riot Client\Logs\Riot Client Logs\<Startzeit>_<pid>_Riot Client.log.
// Die Zeitstempel sind Sekunden seit dem Start (Startzeit steht im Dateinamen).
//
// Update anstoßen: Der Riot Client hat eine lokale Schnittstelle (Port + Passwort in Config\lockfile).
// Sein eigener "Aktualisieren"-Knopf ruft PUT /patch-proxy/v2/queue-patch/products/<id>/patchlines/<pl> auf.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { isMac, home } = require('./platform');

function clientDir() {
  if (isMac) return path.join(home, 'Library', 'Application Support', 'Riot Games', 'Riot Client');
  return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Riot Games', 'Riot Client');
}

// ---------- Fortschritt aus dem Log ----------

function startTimeFromName(name) {
  const m = String(name).match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)/);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

/**
 * Letzter Status je Produkt aus einem Log-Text.
 * Ergebnis: Map "valorant.live" -> { status, progress (0..1), t (ms) }
 */
function parseLog(text, start) {
  const out = new Map();
  const re = /^(\d+(?:\.\d+)?)\|.*?HandleProductPatchlineStatusUpdate: productId: ([\w-]+), patchlineId: ([\w-]+), status: (\w+), progress: ([\d.]+)/;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    out.set(`${m[2]}.${m[3]}`, {
      status: m[4],
      progress: Math.max(0, Math.min(1, parseFloat(m[5]) / 100)),
      t: start ? start + parseFloat(m[1]) * 1000 : null
    });
  }
  return out;
}

/** Laufende Riot-Downloads: Map "valorant.live" -> update-Objekt */
async function liveUpdates(now = Date.now()) {
  const dir = path.join(clientDir(), 'Logs', 'Riot Client Logs');
  let names;
  try { names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.log')); } catch { return new Map(); }
  if (!names.length) return new Map();
  const stats = await Promise.all(names.map(async (n) => ({ n, s: await fs.promises.stat(path.join(dir, n)).catch(() => null) })));
  const latest = stats.filter((x) => x.s).sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)[0];
  if (!latest || now - latest.s.mtimeMs > 10 * 60 * 1000) return new Map();
  // Nur das Ende lesen – die Logs werden groß
  const fh = await fs.promises.open(path.join(dir, latest.n), 'r');
  let text;
  try {
    const len = Math.min(latest.s.size, 512 * 1024);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, latest.s.size - len);
    text = buf.toString('utf8');
  } finally { await fh.close(); }
  const out = new Map();
  for (const [id, st] of parseLog(text, startTimeFromName(latest.n))) {
    if (!/^(Updating|DependencyUpdate)$/.test(st.status)) continue;
    // Seit 2 Minuten keine Meldung mehr -> nicht mehr aktiv
    if (st.t && now - st.t > 120000) continue;
    out.set(id, { state: 'downloading', progress: st.progress, source: 'Riot' });
  }
  return out;
}

// ---------- Lokale Schnittstelle ----------

function readLockfile() {
  try {
    const [, , port, password, protocol] = fs.readFileSync(path.join(clientDir(), 'Config', 'lockfile'), 'utf8').trim().split(':');
    if (!port || !password) return null;
    return { port: Number(port), password, protocol: protocol || 'https' };
  } catch { return null; }
}

function api(method, p, body) {
  const lock = readLockfile();
  if (!lock) return Promise.resolve({ status: 0 });
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const req = https.request({
      host: '127.0.0.1',
      port: lock.port,
      path: p,
      method,
      // Der Riot Client nutzt ein eigenes Zertifikat für 127.0.0.1 – nur hier wird es akzeptiert
      rejectUnauthorized: false,
      timeout: 4000,
      headers: {
        authorization: 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64'),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data)
      }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0 }));
    req.end(data);
  });
}

/** Update eines Produkts ("league_of_legends.live") in die Warteschlange des Riot Client stellen */
async function queuePatch(installId) {
  const i = String(installId).lastIndexOf('.');
  const product = i > 0 ? installId.slice(0, i) : installId;
  const patchline = i > 0 ? installId.slice(i + 1) : 'live';
  const p = `/patch-proxy/v2/queue-patch/products/${encodeURIComponent(product)}/patchlines/${encodeURIComponent(patchline)}`;
  const r = await api('PUT', p, {});
  return r.status >= 200 && r.status < 300;
}

const hasApi = () => !!readLockfile();

module.exports = { liveUpdates, queuePatch, hasApi, api, parseLog, startTimeFromName, clientDir };
