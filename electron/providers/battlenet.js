// Battle.net (Blizzard + Activision)
const { t } = require('../lib/i18n');
const path = require('path');
const reg = require('../lib/registry');
const galaxy = require('../lib/galaxy');
const accounts = require('../lib/accounts');
const { similarity } = require('../lib/names');
const { isMac, isWin, home, macSupport, macShared } = require('../lib/platform');

// Windows: %APPDATA%\Battle.net\Battle.net.config, %ProgramData%\Battle.net\Agent\product.db
// macOS:   ~/Library/Application Support/Battle.net/Battle.net.config, /Users/Shared/Battle.net/Agent/product.db
function configPath() {
  if (isMac) return macSupport('Battle.net', 'Battle.net.config');
  const appData = env('APPDATA');
  return appData ? path.join(appData, 'Battle.net', 'Battle.net.config') : null;
}

function productDbPath() {
  if (isMac) return macShared('Battle.net', 'Agent', 'product.db');
  return path.join(env('PROGRAMDATA') || 'C:\\ProgramData', 'Battle.net', 'Agent', 'product.db');
}
const { exists, getArg, env, exeLaunch, readJson } = require('../lib/util');

// Interne uid aus dem Deinstallations-Eintrag -> Startcode für Battle.net.exe --exec="launch <Code>"
const UID_TO_CODE = {
  wow: 'WoW',
  wow_classic: 'WoWC',
  wow_classic_era: 'WoWC',
  prometheus: 'Pro', // Overwatch 2
  hs_beta: 'WTCG', // Hearthstone
  heroes: 'Hero',
  s1: 'S1',
  s2: 'S2',
  diablo3: 'D3',
  osi: 'OSI', // Diablo II: Resurrected
  fenris: 'Fen', // Diablo IV
  anbs: 'ANBS', // Diablo Immortal
  w3: 'W3',
  rtro: 'RTRO', // Blizzard Arcade Collection
  wlby: 'WLBY', // Crash Bandicoot 4
  viper: 'VIPR', // CoD Black Ops 4
  odin: 'ODIN', // CoD Modern Warfare
  lazarus: 'LAZR', // CoD MW2 Campaign Remastered
  zeus: 'ZEUS', // CoD Black Ops Cold War
  fore: 'FORE', // CoD Vanguard
  auks: 'AUKS' // Call of Duty (HQ)
};

// Anzeigenamen für Spiele, die gerade nicht installiert sind
const UID_TO_NAME = {
  wow: 'World of Warcraft',
  wow_classic: 'World of Warcraft Classic',
  wow_classic_era: 'World of Warcraft Classic Era',
  wow_classic_anniversary: 'World of Warcraft Classic Anniversary',
  prometheus: 'Overwatch 2',
  hs_beta: 'Hearthstone',
  heroes: 'Heroes of the Storm',
  s1: 'StarCraft Remastered',
  s2: 'StarCraft II',
  diablo3: 'Diablo III',
  osi: 'Diablo II: Resurrected',
  fenris: 'Diablo IV',
  anbs: 'Diablo Immortal',
  w3: 'Warcraft III: Reforged',
  rtro: 'Blizzard Arcade Collection',
  wlby: 'Crash Bandicoot 4: It’s About Time',
  viper: 'Call of Duty: Black Ops 4',
  odin: 'Call of Duty: Modern Warfare',
  lazarus: 'Call of Duty: Modern Warfare 2 Campaign Remastered',
  zeus: 'Call of Duty: Black Ops Cold War',
  fore: 'Call of Duty: Vanguard',
  auks: 'Call of Duty'
};

/**
 * Battle.net merkt sich in %APPDATA%\Battle.net\Battle.net.config jedes Spiel,
 * das auf diesem PC schon mal installiert oder gespielt wurde.
 * (Die komplette Kontobibliothek speichert Battle.net nicht lokal.)
 */
async function knownGames() {
  const file = configPath();
  if (!file) return [];
  const cfg = await readJson(file);
  const games = cfg?.Games || {};
  return Object.entries(games)
    .filter(([uid, v]) => uid !== 'battle_net' && v && (v.LastPlayed || v.LastActioned || v.LastInstalled))
    .map(([uid, v]) => ({ uid, lastPlayed: parseInt(v.LastPlayed || '0', 10) || undefined }));
}

/**
 * Zustand jedes Spiels aus der Datenbank des Battle.net-Agents
 * (%ProgramData%\Battle.net\Agent\product.db, Protobuf):
 *   Eintrag: 1 uid, 4 Zustand -> 1 Basis {1 installiert, 2 spielbar, 3 Update fertig}
 *                               4 Update-Fortschritt {2 Fortschritt 0..1, 4 Gesamt-Bytes, 5 Rest-Bytes}
 */
async function readProductDb() {
  const { decode, ints } = require('../lib/protobuf');
  let buf;
  try { buf = await require('fs').promises.readFile(productDbPath()); } catch { return new Map(); }
  const out = new Map();
  try {
    for (const p of decode(buf).filter((f) => f.field === 1 && f.wire === 2)) {
      const m = decode(p.value);
      const uid = m.find((f) => f.field === 1 && f.wire === 2)?.value.toString();
      const stateField = m.find((f) => f.field === 4 && f.wire === 2);
      if (!uid || !stateField) continue;
      const settingsField = m.find((f) => f.field === 3 && f.wire === 2);
      let installPath = null;
      try { installPath = settingsField ? decode(settingsField.value).find((f) => f.field === 1 && f.wire === 2)?.value.toString() : null; } catch { /* egal */ }
      const s = decode(stateField.value);
      const sub = (n) => { const x = s.find((f) => f.field === n && f.wire === 2); return x ? decode(x.value) : []; };
      const base = ints(sub(1));
      const job = ints(sub(2)); // Feld 2.2 = 1, solange Battle.net an einem Update/Download arbeitet
      const upd = sub(4);
      const prog = upd.find((f) => f.field === 2 && f.wire === 1);
      // Feld 6 im Update-Teil = Zielversion; steht da, sobald Battle.net ein Update vorbereitet ("Initialisieren")
      const hasTarget = upd.some((f) => f.field === 6 && f.wire === 2);
      const u = ints(upd);
      out.set(uid, {
        installPath,
        installed: base[1] === 1,
        playable: base[2] === 1,
        updateComplete: base[3] === 1,
        progress: prog ? prog.value.readDoubleLE(0) : 0,
        total: u[4] || 0,
        remaining: u[5] || 0,
        hasTarget,
        // Update angefangen (läuft, initialisiert oder pausiert) – nicht nur "fällig"
        inProgress: base[5] === 1 || job[2] === 1
      });
    }
  } catch { /* Format geändert */ }
  return out;
}

/** Updates/Downloads: product.db (Fortschritt) + Battle.net.config (pausiert?) */
async function bnetUpdates() {
  const out = new Map();
  const cfg = configPath() ? await readJson(configPath()) : null;
  const paused = (uid) => cfg?.Games?.[uid]?.UserPausedUpdate === 'true';
  for (const [uid, s] of await readProductDb()) {
    if (uid === 'agent' || uid === 'battle.net' || uid === 'bna') continue;
    if (s.installed && s.updateComplete) continue;
    const running = s.total > 0 && s.remaining > 0;
    // "Initialisieren": Update läuft schon (Spiel gesperrt, Zielversion eingetragen), Größe steht noch nicht fest
    // Nur wenn Battle.net das Update wirklich angefangen hat (Feld 1.5 / 2.2 oder "Resumable"),
    // nicht schon, wenn es bloß fällig ist (dann steht die Zielversion auch schon drin).
    const started = s.inProgress || cfg?.Games?.[uid]?.Resumable === 'true';
    const initializing = !running && !s.playable && started;
    const info = running
      ? { progress: s.progress, bytesTotal: s.total, bytesDone: s.total - s.remaining }
      : initializing
        ? (s.progress > 0
          ? { progress: s.progress }                                   // schon angefangen (z. B. pausiert)
          : { detail: paused(uid) ? undefined : t("Initialisieren …") })
        : {};
    if (!s.installed && !running && !initializing) continue;
    out.set(uid, {
      state: running || initializing ? (paused(uid) ? 'paused' : 'downloading') : 'available',
      ...info,
      firstInstall: !s.installed,
      _init: initializing && !paused(uid),
      _running: running && !paused(uid)
    });
  }
  // Battle.net arbeitet eins nach dem anderen ab: Nur ein Spiel "lädt" – das gerade ladende bzw.
  // (beim Initialisieren) das zuletzt angefasste. Die übrigen warten in der Warteschlange.
  const active = [...out.values()];
  const anyRunning = active.some((u) => u._running);
  const lastActioned = (uid) => Number(cfg?.Games?.[uid]?.LastActioned) || 0;
  const inits = [...out.entries()].filter(([, u]) => u._init).sort((a, b) => lastActioned(b[0]) - lastActioned(a[0]));
  inits.forEach(([, u], i) => {
    if (anyRunning || i > 0) { u.state = 'queued'; delete u.detail; }
  });
  for (const u of out.values()) { delete u._init; delete u._running; }
  return out;
}

async function updates() {
  // Fortschritt + Größe aus product.db (Battle.net selbst); Tempo/Restzeit misst Ludora live.
  // (Battle.nets lokale Schnittstelle nimmt nur Anfragen von Blizzard-signierten Programmen an.)
  return [...(await bnetUpdates())].map(([nativeId, update]) => ({ nativeId, update }));
}

/**
 * Update im Hintergrund:
 * Ist das Update in Battle.net als "vom Nutzer pausiert" markiert (Battle.net.config ->
 * Games.<uid>.UserPausedUpdate), setzt Battle.net es nie von selbst fort. Ludora nimmt die
 * Markierung heraus und startet Battle.net unsichtbar – dann lädt Battle.net weiter.
 * Läuft Battle.net gerade, wird nur das Fenster-Programm kurz beendet (der Download-Dienst läuft
 * weiter), sonst würde Battle.net die Datei beim Beenden wieder überschreiben.
 */
async function backgroundUpdate(game) {
  const exe = await findBattleNetExe();
  if (!exe) return null;
  const { isProcessRunning } = require('../lib/silentUninstall');
  const { spawn, execFile } = require('child_process');
  const cfgFile = configPath();
  let changed = false;
  try {
    const raw = cfgFile ? await require('fs').promises.readFile(cfgFile, 'utf8') : null;
    const cfg = raw ? JSON.parse(raw.replace(/^\uFEFF/, '')) : null;
    const g = cfg?.Games?.[game.nativeId];
    if (g && g.UserPausedUpdate === 'true') {
      if (await isProcessRunning(['Battle.net'])) {
        if (isWin) await new Promise((r) => execFile('taskkill', ['/IM', 'Battle.net.exe', '/F'], { windowsHide: true }, () => r()));
        else await new Promise((r) => execFile('osascript', ['-e', 'quit app "Battle.net"'], () => r()));
        for (let i = 0; i < 20 && (await isProcessRunning(['Battle.net'])); i++) await new Promise((r) => setTimeout(r, 500));
      }
      g.UserPausedUpdate = 'false';
      const out = JSON.stringify(cfg, null, 4);
      await require('fs').promises.writeFile(cfgFile, raw.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out, 'utf8');
      changed = true;
    }
  } catch { /* Datei unlesbar -> einfach starten */ }
  if (changed || !(await isProcessRunning(['Battle.net']))) {
    try {
      const child = isMac
        ? spawn('open', ['-g', '-a', exe], { detached: true, stdio: 'ignore' })
        : spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(exe) });
      child.on('error', () => {});
      child.unref();
    } catch { return null; }
  }
  return { type: 'none' }; // Ludora prüft danach, ob der Download wirklich läuft
}

async function findBattleNetExe() {
  if (isMac) {
    for (const c of ['/Applications/Battle.net.app', path.join(home, 'Applications', 'Battle.net.app')]) if (await exists(c)) return c;
    return null;
  }
  const candidates = [
    path.join(env('ProgramFiles(x86)') || 'C:\\Program Files (x86)', 'Battle.net', 'Battle.net.exe'),
    path.join(env('ProgramFiles') || 'C:\\Program Files', 'Battle.net', 'Battle.net.exe')
  ];
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}

async function detect() {
  const entries = await reg.getUninstallEntries();
  const bnet = await findBattleNetExe();
  const pendingUpdates = await bnetUpdates().catch(() => new Map());
  const games = [];

  // macOS: keine Uninstall-Einträge – installierte Spiele stehen in product.db
  if (isMac) {
    for (const [uid, s] of await readProductDb()) {
      if (!s.installed || ['agent', 'battle.net', 'bna'].includes(uid)) continue;
      const code = UID_TO_CODE[uid];
      games.push({
        nativeId: uid,
        name: UID_TO_NAME[uid] || uid,
        installDir: s.installPath || undefined,
        status: 'installed',
        covers: [],
        update: pendingUpdates.get(uid) || null,
        launch: bnet && code ? { type: 'exe', target: bnet, args: [`--exec=launch ${code}`] }
          : { type: 'uri', target: `battlenet://${code || uid}` }
      });
    }
  }

  for (const { name: key, values: v } of entries) {
    const un = v.UninstallString || '';
    if (!/Blizzard Uninstaller|Battle\.net/i.test(un)) continue;
    if (/^Battle\.net$/i.test(v.DisplayName || '')) continue;

    const uid = (getArg(un, 'uid') || '').toLowerCase();
    if (!uid || uid === 'battle.net' || uid === 'bna') continue;
    const code = UID_TO_CODE[uid];

    let launch;
    if (bnet && code) {
      launch = { type: 'exe', target: bnet, args: [`--exec=launch ${code}`], cwd: path.dirname(bnet) };
    } else {
      // Unbekannter Code: Battle.net auf der Spielseite öffnen
      launch = { type: 'uri', target: `battlenet://${code || uid}` };
    }

    games.push({
      nativeId: uid,
      name: v.DisplayName || key,
      installDir: v.InstallLocation,
      status: 'installed',
      covers: [],
      update: pendingUpdates.get(uid) || null,
      launch
    });
  }

  // Früher genutzte Spiele aus Battle.net.config
  const installedUids = new Set(games.map((g) => g.nativeId));
  for (const k of await knownGames().catch(() => [])) {
    const name = UID_TO_NAME[k.uid];
    if (!name || installedUids.has(k.uid)) continue; // unbekannte Codes lieber weglassen
    const code = UID_TO_CODE[k.uid];
    installedUids.add(k.uid);
    games.push({
      nativeId: k.uid,
      name,
      status: 'notInstalled',
      lastPlayed: k.lastPlayed,
      covers: [],
      // Battle.net öffnet die Spielseite mit dem Installieren-Knopf
      launch: bnet && code
        ? { type: 'exe', target: bnet, args: [`--exec=launch ${code}`], cwd: path.dirname(bnet) }
        : { type: 'uri', target: `battlenet://${code || k.uid}` }
    });
  }

  // Optional: komplette Bibliothek über die Battle.net-Anmeldung in Ludora.
  // Nutzt eine inoffizielle Schnittstelle -> nur, wenn in den Einstellungen ausdrücklich eingeschaltet.
  const allowed = require('../lib/settings').get('bnetAccountLibrary', false);
  const { games: accountGames, warning } = allowed ? await accounts.library('battlenet') : { games: [], warning: null };
  for (const a of accountGames) {
    // Passenden internen Code über den Namen finden (für den Start-Befehl)
    const best = Object.entries(UID_TO_NAME)
      .map(([uid, n]) => ({ uid, s: similarity(n, a.name) }))
      .sort((x, y) => y.s - x.s)[0];
    const uid = best && best.s >= 0.75 ? best.uid : null;
    if (uid && installedUids.has(uid)) continue;
    if (games.some((g) => similarity(g.name, a.name) >= 0.9)) continue;
    const code = uid && UID_TO_CODE[uid];
    if (uid) installedUids.add(uid);
    games.push({
      nativeId: uid || `acc:${a.titleId || a.name}`,
      name: a.name,
      status: 'notInstalled',
      covers: [],
      launch: bnet && code
        ? { type: 'exe', target: bnet, args: [`--exec=launch ${code}`], cwd: path.dirname(bnet) }
        : bnet ? { type: 'exe', target: bnet, args: [], cwd: path.dirname(bnet) }
          : { type: 'uri', target: 'battlenet://' }
    });
  }
  if (warning) games.warning = warning;

  // Bibliothek über GOG Galaxy (falls Battle.net dort verknüpft ist)
  const result = await galaxy.addOwned(games, ['battlenet'], (o) => {
    const code = UID_TO_CODE[o.id.toLowerCase()];
    if (bnet && code) return { type: 'exe', target: bnet, args: [`--game=${code}`], cwd: path.dirname(bnet) };
    return { type: 'uri', target: `battlenet://${code || o.id}` };
  });
  result.warning = games.warning;
  return result;
}

module.exports = {
  id: 'battlenet',
  platforms: ['win32', 'darwin'],
  processes: ['Battle.net'],
  processesMac: ['Battle.net'],
  client: async () => exeLaunch(await findBattleNetExe()),
  updates,
  backgroundUpdate,
  updateWaitMs: 60000, // Battle.net braucht nach dem Start etwas, bis der Download weiterläuft
  // Spielseite in Battle.net (dort "Aktualisieren"), Code aus dem Startbefehl
  updatePage: (game) => {
    const code = (game.launch?.args || []).join(' ').match(/launch\s+(\S+)/)?.[1];
    return code ? { type: 'uri', target: `battlenet://${code}` } : null;
  },
  uninstallPage: (game) => module.exports.updatePage(game),
  store: { type: 'url', target: 'https://shop.battle.net/de-de' },
  name: 'Battle.net',
  color: '#0b1a2e',
  accent: '#148eff',
  detect,
  findBattleNetExe,
  // Fortsetzen ohne Fenster: Pausen-Markierung entfernen + Battle.net unsichtbar starten
  resumeDownload: async (game) => !!(await backgroundUpdate(game))
};
