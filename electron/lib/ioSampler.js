// Sekundengenaue Download-Messung über die Ein-/Ausgabe-Zähler von Windows.
//
// Windows zählt für jedes Programm mit, wie viele Bytes es gelesen hat – das schließt
// empfangene Netzwerkdaten ein (wie "E/A-Lesevorgänge" im Task-Manager). Ein einziger,
// dauerhaft laufender und unsichtbarer PowerShell-Prozess liest diese Zähler für die
// Launcher-Programme jede Sekunde aus. Läuft kein Download, wird er wieder beendet.
const { spawn } = require('child_process');

// Programme, die bei den jeweiligen Launchern die Daten herunterladen
const PROCESSES = {
  steam: ['steam'],
  epic: ['EpicGamesLauncher', 'EpicOnlineServicesHost'],
  gog: ['GalaxyClient', 'GalaxyClientService', 'GalaxyCommunication'],
  riot: ['RiotClientServices'],
  ea: ['EABackgroundService', 'EADesktop'],
  ubisoft: ['upc', 'UbisoftConnect'],
  battlenet: ['Agent'],
  rockstar: ['RockstarService', 'Launcher'],
  amazon: ['Amazon Games']
};

const SCRIPT = (names) => `
$ErrorActionPreference = 'SilentlyContinue'
$filter = "${names.map((n) => `Name='${n}.exe'`).join(' OR ')}"
while ($true) {
  $sum = @{}
  foreach ($p in (Get-CimInstance Win32_Process -Filter $filter -Property Name,ReadTransferCount)) {
    $k = $p.Name.ToLower()
    $sum[$k] = [double]$sum[$k] + [double]$p.ReadTransferCount
  }
  $parts = foreach ($k in $sum.Keys) { "$k=$($sum[$k])" }
  [Console]::Out.WriteLine(((Get-Date).ToUniversalTime().Ticks).ToString() + '|' + ($parts -join ';'))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}`;

let child = null;
let stopTimer = null;
const history = new Map(); // providerId -> [{ t, bytes }]  (letzte ~30 s)

/** Eine Ausgabezeile in Bytes je Launcher umrechnen */
function parseLine(line) {
  const [ticks, rest = ''] = String(line).trim().split('|');
  const t = Number(ticks) ? Number(ticks) / 10000 - 62135596800000 : Date.now(); // .NET-Ticks -> ms
  const byName = new Map();
  for (const part of rest.split(';').filter(Boolean)) {
    const i = part.lastIndexOf('=');
    byName.set(part.slice(0, i).replace(/\.exe$/, ''), Number(part.slice(i + 1)) || 0);
  }
  const out = new Map();
  for (const [pid, names] of Object.entries(PROCESSES)) {
    let sum = 0;
    let any = false;
    for (const n of names) {
      const v = byName.get(n.toLowerCase());
      if (v !== undefined) { sum += v; any = true; }
    }
    if (any) out.set(pid, sum);
  }
  return { t, out };
}

function record({ t, out }) {
  for (const [pid, bytes] of out) {
    const list = history.get(pid) || [];
    const last = list[list.length - 1];
    // Prozess neu gestartet (Zähler kleiner) -> neu anfangen
    if (last && bytes < last.bytes) list.length = 0;
    list.push({ t, bytes });
    while (list.length && t - list[0].t > 30000) list.shift();
    history.set(pid, list);
  }
}

/** Messung starten (bzw. am Laufen halten). Stoppt von selbst, wenn 60 s niemand fragt. */
function keepAlive() {
  if (process.platform !== 'win32') return;
  clearTimeout(stopTimer);
  stopTimer = setTimeout(stop, 60000);
  if (child) return;
  const names = [...new Set(Object.values(PROCESSES).flat())];
  child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT(names)], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.includes('|')) record(parseLine(line));
    }
  });
  const gone = () => { child = null; };
  child.on('exit', gone);
  child.on('error', gone);
}

function stop() {
  clearTimeout(stopTimer);
  if (child) { try { child.kill(); } catch { /* egal */ } child = null; }
  history.clear();
}

/**
 * Aktuelle Rate eines Launchers in Bytes/s (gemittelt über `windowMs`) und die
 * seit `sinceT` insgesamt gelesenen Bytes. null, solange keine zwei Messpunkte da sind.
 */
function rate(providerId, windowMs = 4000) {
  const list = history.get(providerId);
  if (!list || list.length < 2) return null;
  const last = list[list.length - 1];
  let first = list[0];
  for (const s of list) if (last.t - s.t <= windowMs) { first = s; break; }
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return null;
  return { speed: Math.max(0, (last.bytes - first.bytes) / dt), total: last.bytes, t: last.t };
}

module.exports = { keepAlive, stop, rate, parseLine, PROCESSES, _record: record, _history: history };
