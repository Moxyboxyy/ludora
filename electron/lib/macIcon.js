// Programm-Symbole auf dem Mac, ohne app.getFileIcon.
//
// app.getFileIcon läuft unter macOS in einem Hintergrund-Thread und bringt Electron auf
// neueren macOS-Versionen zum Absturz (SIGTRAP). Stattdessen lesen wir das Symbol direkt
// aus dem .app-Paket (Contents/Resources/<CFBundleIconFile>.icns) und wandeln es mit dem
// Mac-eigenen "sips" in ein PNG um. Ergebnis wird im Benutzerordner zwischengespeichert.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { appBundle } = require('./platform');

let cacheDir = null;
function init(userDataDir) {
  cacheDir = path.join(userDataDir, 'icon-cache');
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

/** .icns-Datei eines .app-Pakets finden */
async function findIcns(app) {
  const res = path.join(app, 'Contents', 'Resources');
  const plist = path.join(app, 'Contents', 'Info.plist');
  let name = await run('plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', plist]);
  if (name) {
    if (!/\.icns$/i.test(name)) name += '.icns';
    const f = path.join(res, name);
    if (fs.existsSync(f)) return f;
  }
  // Fallback: irgendeine .icns im Resources-Ordner (AppIcon bevorzugt)
  const files = (await fs.promises.readdir(res).catch(() => [])).filter((n) => /\.icns$/i.test(n));
  const pick = files.find((n) => /^(appicon|icon)\.icns$/i.test(n)) || files[0];
  return pick ? path.join(res, pick) : null;
}

/** PNG-Buffer des Programm-Symbols oder null */
async function iconPng(file) {
  if (process.platform !== 'darwin' || !file) return null;
  try {
    const app = appBundle(file) || (/\.app$/i.test(file) ? file : null);
    const icns = app ? await findIcns(app) : (/\.icns$/i.test(file) ? file : null);
    if (!icns) return null;
    const stat = await fs.promises.stat(icns);
    const key = crypto.createHash('sha1').update(`${icns}|${stat.mtimeMs}`).digest('hex');
    const dir = cacheDir || path.join(require('os').tmpdir(), 'gamehub-icons');
    const out = path.join(dir, `${key}.png`);
    if (!fs.existsSync(out)) {
      await fs.promises.mkdir(dir, { recursive: true });
      const ok = await run('sips', ['-s', 'format', 'png', '-Z', '256', icns, '--out', out]);
      if (ok === null || !fs.existsSync(out)) return null;
    }
    return await fs.promises.readFile(out);
  } catch {
    return null;
  }
}

module.exports = { init, iconPng, findIcns };
