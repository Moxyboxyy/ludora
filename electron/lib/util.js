const fs = require('fs');
const path = require('path');

async function exists(p) {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

async function readText(p) {
  try { return await fs.promises.readFile(p, 'utf8'); } catch { return null; }
}

async function readJson(p) {
  const t = await readText(p);
  if (!t) return null;
  try { return JSON.parse(t.replace(/^\uFEFF/, '')); } catch { return null; }
}

async function listDir(p) {
  try { return await fs.promises.readdir(p); } catch { return []; }
}

/** Zieht einen Kommandozeilen-Parameter wie --uid=fenris aus einem String. */
function getArg(str, name) {
  if (!str) return undefined;
  const re = new RegExp(`--?${name}[=\\s]+"?([^"\\s]+)"?`, 'i');
  const m = str.match(re);
  return m ? m[1] : undefined;
}

/** Entfernt Anführungszeichen und Parameter aus einem Pfad wie "C:\\x.exe",0 */
function cleanExePath(str) {
  if (!str) return undefined;
  let s = String(str).trim();
  if (s.startsWith('"')) s = s.slice(1, s.indexOf('"', 1));
  s = s.replace(/,\s*-?\d+$/, '');
  return s;
}

function env(name) {
  return process.env[name] || '';
}

/** Erster existierender Pfad aus einer Liste (leere Einträge werden übersprungen). */
async function firstExisting(paths) {
  for (const p of paths) if (p && (await exists(p))) return p;
  return null;
}

/** Programm-Start-Beschreibung für eine EXE */
function exeLaunch(exe, args = []) {
  return exe ? { type: 'exe', target: exe, args, cwd: path.dirname(exe) } : null;
}

/** Gesamtgröße eines Ordners in Bytes (rekursiv, Symlinks werden übersprungen). */
async function dirSize(dir, limit = 200000) {
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length && files < limit) {
    const d = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
    await Promise.all(entries.map(async (e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        files++;
        try { total += (await fs.promises.stat(p)).size; } catch { /* egal */ }
      }
    }));
  }
  return total;
}

module.exports = { dirSize, exists, readText, readJson, listDir, getArg, cleanExePath, env, path, firstExisting, exeLaunch };
