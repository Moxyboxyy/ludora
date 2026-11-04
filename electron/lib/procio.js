// Ein-/Ausgabe-Zähler von Windows-Prozessen (wie "E/A-Lesevorgänge" im Task-Manager).
// Die gelesenen Bytes enthalten auch das, was über das Netzwerk empfangen wird –
// so lässt sich die Download-Geschwindigkeit eines Launchers messen, auch wenn er
// sie selbst nirgends speichert.
const { execFile } = require('child_process');

/** Summe der I/O-Bytes aller Prozesse mit diesen Namen (ohne .exe). null, wenn nicht ermittelbar. */
function readIo(names) {
  if (process.platform !== 'win32' || !names?.length) return Promise.resolve(null);
  const filter = names.map((n) => `Name='${n.replace(/'/g, '')}.exe'`).join(' OR ');
  const ps = `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    'Measure-Object -Property ReadTransferCount -Sum | Select-Object -ExpandProperty Sum';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        if (err) return resolve(null);
        const n = Number(String(stdout).trim());
        resolve(Number.isFinite(n) && n > 0 ? n : null);
      });
  });
}

module.exports = { readIo };
