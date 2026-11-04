// Einfache Einstellungen als JSON im Benutzerordner der App
// (%APPDATA%\gamehub\settings.json)
const fs = require('fs');
const path = require('path');

let file = null;
let cache = null;

function init(userDataDir) {
  file = path.join(userDataDir, 'settings.json');
  cache = null;
}

function getAll() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cache = {}; }
  return cache;
}

function get(key, fallback) {
  const v = getAll()[key];
  return v === undefined ? fallback : v;
}

function set(patch) {
  cache = { ...getAll(), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

module.exports = { init, get, getAll, set };
