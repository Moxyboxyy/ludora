// Hält Launcher-Fenster im Hintergrund.
//
// Nach dem Start eines Spiels beobachtet ein kleines PowerShell-Skript für ein paar
// Sekunden die Fenster des jeweiligen Launchers und minimiert bzw. versteckt sie,
// sobald sie auftauchen. Der Launcher läuft normal weiter (Tray-Symbol bleibt),
// das Spiel selbst wird nicht angefasst.
const { spawn } = require('child_process');

const SCRIPT = `
param([string]$Names, [int]$Seconds, [int]$Mode)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices;
public class GHWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
}
"@
$list = $Names.Split(',')
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $ids = @{}
  Get-Process -Name $list | ForEach-Object { $ids[[uint32]$_.Id] = $true }
  if ($ids.Count -gt 0) {
    [GHWin]::EnumWindows({
      param($h, $l)
      $p = [uint32]0
      [void][GHWin]::GetWindowThreadProcessId($h, [ref]$p)
      if ($ids.ContainsKey($p) -and [GHWin]::IsWindowVisible($h) -and [GHWin]::GetWindowTextLength($h) -gt 0) {
        if ($Mode -eq 0 -or -not [GHWin]::IsIconic($h)) { [void][GHWin]::ShowWindowAsync($h, $Mode) }
      }
      return $true
    }, [IntPtr]::Zero) | Out-Null
  }
  Start-Sleep -Milliseconds 300
}
`;

const running = new Map(); // providerId -> Kindprozess

/**
 * Launcher-Fenster für `seconds` Sekunden im Hintergrund halten.
 * mode: 'minimize' (Taskleiste) | 'hide' (nur Tray) | 'off'
 */
// macOS: Programme über "System Events" ausblenden (wie Cmd+H). Beim ersten Mal fragt macOS,
// ob Ludora "System Events" steuern darf – das muss einmal erlaubt werden.
function keepInBackgroundMac(providerId, processNames, seconds) {
  const list = processNames.map((n) => `"${n.replace(/"/g, '')}"`).join(', ');
  const script = `
set endTime to (current date) + ${Number(seconds) || 60}
repeat while (current date) < endTime
  try
    tell application "System Events"
      repeat with p in (every application process whose name is in {${list}})
        if visible of p then set visible of p to false
      end repeat
    end tell
  end try
  delay 0.5
end repeat`;
  const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
  child.on('exit', () => { if (running.get(providerId) === child) running.delete(providerId); });
  child.on('error', () => running.delete(providerId));
  running.set(providerId, child);
}

function keepInBackground(providerId, processNames, { seconds = 60, mode = 'minimize' } = {}) {
  if (mode === 'off' || !processNames?.length) return;
  if (process.platform === 'darwin') {
    stop(providerId);
    return keepInBackgroundMac(providerId, processNames, seconds); // ausblenden = auf dem Mac "verstecken" und "minimieren"
  }
  if (process.platform !== 'win32') return;
  stop(providerId);
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  // Skript als Base64 übergeben, Parameter danach über einen kleinen Wrapper
  const wrapper = `& ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')))) -Names '${processNames.join(',')}' -Seconds ${seconds} -Mode ${mode === 'hide' ? 0 : 6}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', wrapper], {
    windowsHide: true,
    stdio: 'ignore'
  });
  child.on('exit', () => { if (running.get(providerId) === child) running.delete(providerId); });
  child.on('error', () => running.delete(providerId));
  running.set(providerId, child);
}

/** Beobachtung abbrechen, z. B. wenn der Nutzer den Launcher bewusst öffnet. */
function stop(providerId) {
  const c = running.get(providerId);
  if (c) { try { c.kill(); } catch { /* egal */ } running.delete(providerId); }
}

function stopAll() {
  for (const id of [...running.keys()]) stop(id);
}

module.exports = { keepInBackground, stop, stopAll };
