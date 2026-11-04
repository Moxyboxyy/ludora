// Lokaler Nachrichtenverlauf für Launcher, deren Chat keinen abrufbaren Verlauf hat (Epic).
// Pro Gespräch höchstens 200 Nachrichten, gespeichert im Ludora-Datenordner.
const fs = require('fs');
const path = require('path');

let file = null;
let data = null;
let saveTimer = null;

function load() {
  if (data) return data;
  try { data = file ? JSON.parse(fs.readFileSync(file, 'utf8')) || {} : {}; } catch { data = {}; }
  return data;
}
function save() {
  if (!file) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(file, JSON.stringify(data)); } catch { /* egal */ } }, 500);
  saveTimer.unref?.();
}

module.exports = {
  init(userDataDir) { file = path.join(userDataDir, 'chat-log.json'); data = null; },
  add(key, msg) {
    const d = load();
    const list = d[key] || (d[key] = []);
    if (list.some((m) => m.ts === msg.ts && m.text === msg.text && m.fromMe === msg.fromMe)) return false;
    list.push({ fromMe: !!msg.fromMe, text: String(msg.text), ts: Number(msg.ts) || Date.now() });
    if (list.length > 200) list.splice(0, list.length - 200);
    save();
    return true;
  },
  list(key) { return (load()[key] || []).slice(); }
};
