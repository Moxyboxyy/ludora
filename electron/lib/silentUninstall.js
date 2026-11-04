// Deinstallieren, ohne dass ein Launcher-Fenster aufgeht.
//
//  Steam      Steam kurz im Hintergrund beenden -> appmanifest + Spielordner entfernen -> Steam unsichtbar
//             neu starten. Steam selbst bietet von außen nur seinen Bestätigungsdialog an.
//  Epic       Epic beenden -> .item-Datei(en) + Eintrag in LauncherInstalled.dat + Spielordner entfernen
//             -> Epic unsichtbar neu starten (so machen es auch Legendary/Heroic).
//  Battle.net Über den Battle.net-Dienst: POST /uninstall (wie der "Deinstallieren"-Knopf), komplett lautlos.
//  Sonstige   Deinstallationsprogramm aus der Registry mit "lautlos"-Schalter (Inno Setup, MSI, NSIS).
//
// Sicherheit: Gelöscht wird nur, was eindeutig zum Spiel gehört (siehe insideSafe/looksLikeEpicInstall).
const { t } = require('./i18n.js');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const running = require('./running');
const { isWin, isMac } = require('./platform');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Hilfen ----------

async function isProcessRunning(names) {
  const want = names.map((n) => n.toLowerCase().replace(/\.exe$/, ''));
  const procs = await running.listProcesses();
  return procs.some((p) => want.includes(path.basename(p.exe).toLowerCase().replace(/\.exe$/, '')));
}

async function waitGone(names, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await isProcessRunning(names))) return true;
    await sleep(1000);
  }
  return false;
}

function detached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts });
  child.on('error', () => {});
  child.unref();
  return child;
}

/** Ordner liegt wirklich *in* parent (nicht parent selbst, kein "..") */
function insideSafe(dir, parent) {
  if (!dir || !parent) return false;
  const d = path.resolve(dir);
  const p = path.resolve(parent);
  const rel = path.relative(p, d);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(/[\\/]/).filter(Boolean).length >= 1;
}

/** Nicht zu flach: mindestens Laufwerk + 2 Ordner (E:\Spiele\Fortnite, nicht E:\Spiele) */
function deepEnough(dir) {
  return path.resolve(dir).split(/[\\/]/).filter(Boolean).length >= 3;
}

async function removeDir(dir) {
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
}

// ---------- Steam ----------

async function steamUninstall(game, steam) {
  const steamPath = await steam.findSteamPath();
  if (!steamPath) throw new Error(t("Steam-Ordner nicht gefunden."));
  // appmanifest + Installationsordner finden
  let manifest = null;
  let lib = null;
  let installdir = null;
  for (const l of await steam.getLibraryFolders(steamPath)) {
    const f = path.join(l, `appmanifest_${game.nativeId}.acf`);
    if (fs.existsSync(f)) {
      manifest = f;
      lib = l;
      const text = fs.readFileSync(f, 'utf8');
      installdir = text.match(/"installdir"\s+"([^"]+)"/i)?.[1] || null;
      break;
    }
  }
  if (!manifest) throw new Error(t("Steam kennt das Spiel nicht mehr als installiert."));
  const common = path.join(lib, 'common');
  const gameDir = installdir ? path.join(common, installdir) : null;
  if (gameDir && !insideSafe(gameDir, common)) throw new Error(t("Unerwarteter Spielordner – abgebrochen."));

  // Steam im Hintergrund beenden (sonst schreibt es das appmanifest wieder zurück)
  const names = isMac ? ['steam_osx', 'Steam'] : ['steam'];
  const wasRunning = await isProcessRunning(names);
  if (wasRunning) {
    const exe = await steam.findSteamExe();
    if (isMac) detached('osascript', ['-e', 'quit app "Steam"']);
    else if (exe) detached(exe, ['-shutdown']);
    if (!(await waitGone(names, 45000))) throw new Error(t("Steam ließ sich nicht im Hintergrund beenden."));
  }

  fs.rmSync(manifest, { force: true });
  for (const extra of [path.join(lib, 'downloading', String(game.nativeId)), path.join(lib, 'temp', String(game.nativeId))]) {
    if (insideSafe(extra, lib)) await removeDir(extra).catch(() => {});
  }

  // Steam unsichtbar wieder starten, bevor der (evtl. große) Ordner gelöscht wird
  if (wasRunning) {
    const exe = await steam.findSteamExe();
    if (isMac) detached('open', ['-g', '-a', exe || 'Steam']);
    else if (exe) detached(exe, ['-silent']);
  }
  if (gameDir) await removeDir(gameDir);
  return { via: 'Steam' };
}

// ---------- Epic ----------

function epicInstalledDat() {
  return path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
}

function looksLikeEpicInstall(dir) {
  return !!dir && deepEnough(dir) && fs.existsSync(path.join(dir, '.egstore'));
}

async function epicUninstall(game, epic) {
  if (!isWin) return null;
  const manDir = path.join(epic.epicDataDir(), 'Manifests');
  const items = [];
  for (const sub of ['', 'Pending']) {
    const d = path.join(manDir, sub);
    for (const f of (fs.existsSync(d) ? fs.readdirSync(d) : []).filter((x) => /\.item$/i.test(x))) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8').replace(/^\uFEFF/, ''));
        if (m.AppName === game.nativeId || m.MainGameAppName === game.nativeId) items.push({ file: path.join(d, f), m });
      } catch { /* kaputte Datei überspringen */ }
    }
  }
  const main = items.find((x) => x.m.AppName === game.nativeId);
  if (!main) throw new Error(t("Epic kennt das Spiel nicht mehr als installiert."));
  const dir = main.m.InstallLocation;
  if (!looksLikeEpicInstall(dir)) throw new Error(t("Unerwarteter Spielordner – abgebrochen."));

  const names = ['EpicGamesLauncher'];
  const wasRunning = await isProcessRunning(names);
  if (wasRunning) {
    detached('taskkill', ['/IM', 'EpicGamesLauncher.exe', '/F']);
    if (!(await waitGone(names, 20000))) throw new Error(t("Epic ließ sich nicht im Hintergrund beenden."));
  }

  for (const it of items) fs.rmSync(it.file, { force: true });
  // Eintrag(e) aus Epics Installationsliste entfernen
  const dat = epicInstalledDat();
  try {
    const raw = fs.readFileSync(dat, 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    const apps = new Set(items.map((x) => x.m.AppName));
    if (Array.isArray(j.InstallationList)) {
      j.InstallationList = j.InstallationList.filter((e) => !apps.has(e.AppName) && !apps.has(e.ArtifactId));
      const out = JSON.stringify(j, null, '\t');
      fs.writeFileSync(dat, raw.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out, 'utf8');
    }
  } catch { /* Datei fehlt -> egal */ }

  if (wasRunning) {
    const exe = await epic.findEpicExe();
    if (exe) detached(exe, ['-silent']);
  }
  await removeDir(dir);
  return { via: 'Epic Games' };
}

// ---------- Battle.net ----------

async function bnetUninstall(game, bnet) {
  const agent = require('./bnetAgent');
  if (!(await agent.available())) {
    // Battle.net (und damit sein Dienst) unsichtbar starten und kurz warten
    const exe = await bnet.findBattleNetExe();
    if (exe) detached(isMac ? 'open' : exe, isMac ? ['-g', '-a', exe] : []);
    for (let i = 0; i < 20 && !(await agent.available()); i++) await sleep(1000);
  }
  if (!(await agent.startUninstall(game.nativeId))) return null;
  // Fortschritt abwarten (höchstens 10 Minuten)
  for (let i = 0; i < 600; i++) {
    const s = await agent.uninstallStatus(game.nativeId);
    if (!s || s.uninstall_complete) break;
    await sleep(1000);
  }
  return { via: 'Battle.net' };
}

// ---------- Deinstallationsprogramme aus der Registry ----------

/** Befehl so umbauen, dass das Deinstallationsprogramm ohne Fenster läuft – null, wenn unbekannt */
function silentCommand(cmd, quiet) {
  if (quiet) return quiet;
  const c = String(cmd || '').trim();
  if (!c) return null;
  // MSI: msiexec /I{GUID} oder /X{GUID}
  const msi = c.match(/msiexec(?:\.exe)?"?\s+\/[IX]\s*(\{[0-9A-F-]+\})/i);
  if (msi) return `MsiExec.exe /X${msi[1]} /qn /norestart`;
  const exe = (c.match(/^"([^"]+)"/)?.[1] || c.split(/\s+/)[0]).toLowerCase();
  const base = exe.split(/[\\/]/).pop();
  // Inno Setup (GOG, viele Indie-Spiele): unins000.exe
  if (/^unins\d{3}\.exe$/.test(base)) return `${c} /VERYSILENT /SUPPRESSMSGBOXES /NORESTART`;
  // NSIS: uninst.exe / uninstall.exe
  if (/^(uninst|uninstall)[^\\/]*\.exe$/.test(base) && !/\s\/S(\s|$)/.test(c)) return `${c} /S`;
  return null;
}

/** Lautloses Deinstallationsprogramm starten und auf das Ende warten */
function runHidden(cmdline) {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${cmdline}"`], { windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true });
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

module.exports = { steamUninstall, epicUninstall, bnetUninstall, silentCommand, runHidden, insideSafe, looksLikeEpicInstall, isProcessRunning };
