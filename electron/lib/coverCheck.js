// Prüft für jedes Spiel, ob mindestens ein Cover wirklich lädt, repariert Fehlschläge
// und schreibt einen Bericht (cover-report.json) – pro Launcher, welche Spiele noch
// ohne Bild sind.
//
// Ergebnisse werden 7 Tage gemerkt, damit nicht bei jedem Start alles neu geprüft wird.
const fs = require('fs');
const path = require('path');
const covers = require('./covers');

const TTL = 7 * 24 * 60 * 60 * 1000;
let stateFile = null;
let state = null;

function init(userDataDir) {
  stateFile = path.join(userDataDir, 'cover-check.json');
}

function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
  return state;
}

function save() {
  try { fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8'); } catch { /* egal */ }
}

/**
 * urlOk(url) -> Promise<boolean>   (wird vom Hauptprozess gestellt, kennt auch ghimg://)
 * onUpdate(id, { covers, wides })  -> reparierte Bilder an die Oberfläche schicken
 */
async function run(games, { urlOk, onUpdate, reportPaths = [] }) {
  const st = load();
  const now = Date.now();
  const queue = [...games];
  const result = new Map(); // id -> 'ok' | 'repaired' | 'icon' | 'none'

  async function firstWorking(g) {
    for (const u of [...(g.covers || []), ...(g.wides || [])]) {
      if (await urlOk(u)) return u;
    }
    return null;
  }

  async function worker() {
    while (queue.length) {
      const g = queue.shift();
      const prev = st[g.id];
      const key = [...(g.covers || []), ...(g.wides || [])].join('|');
      if (prev && prev.key === key && now - prev.at < TTL) { result.set(g.id, prev.result); continue; }

      let res;
      if (await firstWorking(g)) res = 'ok';
      else {
        const fixed = await covers.repair(g).catch(() => null);
        if (fixed) {
          Object.assign(g, { covers: fixed.covers, wides: fixed.wides });
          onUpdate(g.id, fixed);
          res = 'repaired';
        } else res = g.iconUrl ? 'icon' : 'none';
      }
      result.set(g.id, res);
      st[g.id] = { key: [...(g.covers || []), ...(g.wides || [])].join('|'), result: res, at: now };
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  save();

  // Bericht pro Launcher
  const report = { erstellt: new Date().toISOString(), launcher: {} };
  for (const g of games) {
    const r = (report.launcher[g.provider] ||= { spiele: 0, mitCover: 0, repariert: [], nurSymbol: [], ohneBild: [] });
    r.spiele++;
    const res = result.get(g.id);
    if (res === 'ok' || res === 'repaired') r.mitCover++;
    if (res === 'repaired') r.repariert.push(g.name);
    if (res === 'icon') r.nurSymbol.push(g.name);
    if (res === 'none') r.ohneBild.push(`${g.name} (${g.status === 'notInstalled' ? 'nicht installiert' : 'installiert'})`);
  }
  for (const p of reportPaths) {
    try { fs.writeFileSync(p, JSON.stringify(report, null, 2), 'utf8'); } catch { /* egal */ }
  }
  return report;
}

/** Nach "Cache leeren" o. Ä. alles neu prüfen */
function reset() {
  state = {};
  save();
}

module.exports = { init, run, reset };
