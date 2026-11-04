// Betriebssystem-Hilfen: Ludora läuft unter Windows und macOS (Steam zusätzlich unter Linux).
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const home = os.homedir();

/** ~/Library/Application Support/... (macOS) */
const macSupport = (...p) => path.join(home, 'Library', 'Application Support', ...p);

/** /Users/Shared/... (macOS – dort legen Battle.net, GOG und Riot gemeinsame Daten ab) */
const macShared = (...p) => path.join('/Users', 'Shared', ...p);

/** Pfad bis einschließlich ".app" (macOS-Programmpaket), sonst null */
function appBundle(p) {
  if (!p) return null;
  const m = String(p).match(/^(.*?\.app)(?:\/|$)/i);
  return m ? m[1] : null;
}

module.exports = { isWin, isMac, isLinux, home, macSupport, macShared, appBundle };
