// Welche Spiele laufen gerade?
//
// Alle paar Sekunden wird die Prozessliste gelesen (Windows: PowerShell/CIM mit vollem
// Programmpfad, macOS: ps). Ein Spiel gilt als laufend, wenn ein Prozess aus seinem
// Installationsordner stammt – das klappt für jeden Launcher gleich, ohne Launcher-APIs.
const { execFile } = require('child_process');
const path = require('path');

const PS = "Get-CimInstance Win32_Process -Property ProcessId,ExecutablePath | Where-Object ExecutablePath | ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)\" }";

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out)));
  });
}

/** [{ pid, exe }] aller laufenden Prozesse mit Pfad */
async function listProcesses() {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS]);
    return out.split(/\r?\n/).map((l) => {
      const i = l.indexOf('|');
      return i > 0 ? { pid: Number(l.slice(0, i)), exe: l.slice(i + 1).trim() } : null;
    }).filter((p) => p && p.exe);
  }
  if (process.platform === 'darwin') {
    const out = await run('ps', ['-axo', 'pid=,comm=']);
    return out.split('\n').map((l) => {
      const m = l.trim().match(/^(\d+)\s+(.+)$/);
      return m ? { pid: Number(m[1]), exe: m[2] } : null;
    }).filter(Boolean);
  }
  return [];
}

const norm = (p) => {
  let s = path.normalize(String(p)).replace(/[\\/]+$/, '');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
};

/** Ordner sind nur brauchbar, wenn sie tief genug liegen (nicht "C:\" oder "/Applications") */
function usableDir(dir) {
  if (!dir) return false;
  const parts = norm(dir).split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 && !/^(\/applications|\/users\/shared)$/i.test(norm(dir));
}

/**
 * Laufende Spiele finden.
 * games: Liste aus dem Scan; exclude: Ordner der Launcher selbst (die laufen ja oft dauerhaft)
 * Ergebnis: Map gameId -> pid (der erste passende Prozess)
 */
async function detect(games, exclude = [], procsOverride = null) {
  const procs = procsOverride || await listProcesses();
  if (!procs.length) return new Map();
  const ex = exclude.filter(Boolean).map(norm);
  const list = procs
    .map((p) => ({ pid: p.pid, exe: norm(p.exe) }))
    .filter((p) => !ex.some((d) => p.exe === d || p.exe.startsWith(d + path.sep)));

  const out = new Map();
  for (const g of games) {
    if (g.status === 'notInstalled' || g.status === 'missing') continue;
    // Eigene Spiele: genau die gestartete Datei; sonst: alles aus dem Installationsordner
    const exact = g.provider === 'manual' && /\.exe$|\.app$/i.test(g.launch?.target || '') ? norm(g.launch.target) : null;
    const dir = !exact && usableDir(g.installDir) ? norm(g.installDir) : null;
    if (!exact && !dir) continue;
    const hit = list.find((p) => (exact ? p.exe === exact || p.exe.startsWith(exact + path.sep) : p.exe.startsWith(dir + path.sep)));
    if (hit) out.set(g.id, hit.pid);
  }
  return out;
}

/** Fenster eines laufenden Spiels nach vorne holen */
function focus(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject WScript.Shell).AppActivate(${pid}) | Out-Null`]);
  } else if (process.platform === 'darwin') {
    run('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]);
  }
}

module.exports = { detect, focus, listProcesses, usableDir, _norm: norm };
