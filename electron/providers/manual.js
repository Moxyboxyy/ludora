// Manuell hinzugefügte Spiele (jede beliebige .exe oder Verknüpfung)
// Gespeichert als JSON im Benutzerordner der App.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let storeFile = null;

function init(userDataDir) {
  storeFile = path.join(userDataDir, 'manual-games.json');
}

function load() {
  try { return JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch { return []; }
}

function save(list) {
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify(list, null, 2), 'utf8');
}

function add({ name, exe, args = '' }) {
  const list = load();
  const entry = {
    id: crypto.randomUUID(),
    name: name || path.basename(exe, path.extname(exe)),
    exe,
    args
  };
  list.push(entry);
  save(list);
  return entry;
}

function remove(id) {
  save(load().filter((g) => g.id !== id));
}

async function detect() {
  return load().map((g) => ({
    nativeId: g.id,
    name: g.name,
    installDir: path.dirname(g.exe),
    status: fs.existsSync(g.exe) ? 'installed' : 'missing',
    covers: [],
    removable: true,
    launch: {
      type: 'exe',
      target: g.exe,
      args: g.args ? g.args.match(/(?:[^\s"]+|"[^"]*")+/g).map((a) => a.replace(/^"|"$/g, '')) : [],
      cwd: path.dirname(g.exe)
    }
  }));
}

module.exports = {
  id: 'manual',
  platforms: ['win32', 'darwin', 'linux'],
  name: 'Eigene Spiele',
  color: '#1f2a24',
  accent: '#7ee2a8',
  init,
  add,
  remove,
  detect
};
