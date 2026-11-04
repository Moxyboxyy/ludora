// Battle.net Agent – die lokale Schnittstelle, über die der Battle.net-Client selbst
// mit seinem Hintergrunddienst spricht (http://127.0.0.1:<Port>, Port steht in Agent.dat).
//
//   GET  /agent          -> { authorization, ... }  (Schlüssel für alle weiteren Anfragen)
//   GET  /update/<uid>   -> progress, download_rate (Bytes/s), estimated_time_in_sec,
//                           download_current/total, download_remaining, ...
//   POST /update         -> { uid, priority } stellt ein Update in die Warteschlange
//
// Gesehen in den Logs des Agents (ProgramData\Battle.net\Agent\Agent.*\Logs\Agent-*.log).
// Läuft der Agent nicht, liefern alle Funktionen null – Ludora nutzt dann product.db.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { isMac, macShared } = require('./platform');

let auth = null;

function agentDir() {
  if (isMac) return macShared('Battle.net', 'Agent');
  return path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Battle.net', 'Agent');
}

function port() {
  try {
    const n = parseInt(fs.readFileSync(path.join(agentDir(), 'Agent.dat'), 'utf8').trim(), 10);
    if (n > 0 && n < 65536) return n;
  } catch { /* Standard */ }
  return 1120;
}

function request(method, p, body, withAuth = true) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json' };
    if (withAuth && auth) headers.authorization = auth;
    if (data) headers['content-length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port: port(), path: p, method, headers, timeout: 2500 }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : {}; } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, json: null }));
    if (data) req.write(data);
    req.end();
  });
}

async function ensureAuth() {
  if (auth) return true;
  const r = await request('GET', '/agent', null, false);
  if (r.status === 200 && r.json?.authorization) { auth = r.json.authorization; return true; }
  return false;
}

async function call(method, p, body) {
  if (!(await ensureAuth())) return null;
  let r = await request(method, p, body);
  if (r.status === 401 || r.status === 403) { auth = null; if (!(await ensureAuth())) return null; r = await request(method, p, body); }
  return r;
}

const first = (v) => (Array.isArray(v) ? Number(v[0]) || 0 : Number(v) || 0);

/** Antwort von GET /update/<uid> in Ludoras Download-Format umwandeln */
function parseUpdate(j) {
  if (!j || typeof j !== 'object') return null;
  if (j.download_complete && j.patch_application_complete !== false && !(Number(j.download_rate) > 0)) return null;
  const total = first(j.download_total);
  const current = first(j.download_current);
  const rate = Number(j.download_rate) || 0;
  const remaining = Number(j.download_remaining);
  const progress = Number.isFinite(Number(j.progress)) ? Number(j.progress)
    : total ? current / total : undefined;
  if (progress === undefined && !total) return null;
  const paused = j.paused === true || j.state === 'paused';
  const out = {
    state: paused ? 'paused' : 'downloading',
    progress: progress !== undefined ? Math.max(0, Math.min(1, progress)) : undefined,
    bytesDone: current || undefined,
    bytesTotal: total || undefined,
    speed: rate,
    eta: Number(j.estimated_time_in_sec) > 0 ? Number(j.estimated_time_in_sec)
      : rate > 0 && remaining > 0 ? remaining / rate : null,
    source: 'Battle.net'
  };
  return out;
}

/** Laufender Download/Update eines Spiels (uid wie "wow", "fenris") oder null */
async function updateStatus(uid) {
  const r = await call('GET', `/update/${encodeURIComponent(uid)}`);
  if (!r || r.status !== 200) return null;
  return parseUpdate(r.json);
}

/** Update im Hintergrund in die Warteschlange stellen (wie der "Aktualisieren"-Knopf) */
async function startUpdate(uid) {
  // Wie der Battle.net-Client: Spiel beim Dienst anmelden, dann Update in die Warteschlange (vorne)
  await call('POST', `/game/${encodeURIComponent(uid)}`, { branch: '' });
  const r = await call('POST', '/update', { priority: { insert_at_head: true, value: 900 }, uid });
  return !!(r && r.status === 200);
}

/** Wartet, bis der Battle.net-Dienst antwortet (z. B. nach dem Start von Battle.net) */
async function waitUntilAvailable(ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    auth = null;
    if (await ensureAuth()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Lautlos deinstallieren (wie der "Deinstallieren"-Knopf in Battle.net) */
async function startUninstall(uid) {
  const r = await call('POST', '/uninstall', { run_compaction: true, uid });
  return !!(r && r.status === 200);
}

/** { progress, uninstall_complete } oder null */
async function uninstallStatus(uid) {
  const r = await call('GET', `/uninstall/${encodeURIComponent(uid)}`);
  return r && r.status === 200 ? r.json : null;
}

/** Laufenden Download/Update anhalten (Battle.net: "Pause") */
async function pauseUpdate(uid) {
  const r = await call('DELETE', `/update/${encodeURIComponent(uid)}`);
  return !!(r && r.status === 200);
}

async function available() {
  return ensureAuth();
}

module.exports = { updateStatus, startUpdate, waitUntilAvailable, startUninstall, uninstallStatus, pauseUpdate, available, parseUpdate, port, _reset: () => { auth = null; } };
