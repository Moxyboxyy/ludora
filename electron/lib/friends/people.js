// "Personen": mehrere Konten eines Menschen (Steam, Riot, Epic, GOG) zusammengefasst.
// Gespeichert in den Einstellungen als
//   [{ id, name, members: [{ launcher: 'steam', id: '7656…' }, { launcher: 'riot', id: '<puuid>' }] }]
// Ein Konto gehört höchstens zu einer Person.
const crypto = require('crypto');
const settings = require('../settings');

const KEY = 'friendPeople';
const LAUNCHERS = new Set(['steam', 'riot', 'epic', 'gog']);

function clean(list) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const name = String(p?.name || '').trim().slice(0, 60);
    if (!name) continue;
    const members = [];
    for (const m of Array.isArray(p.members) ? p.members : []) {
      const launcher = String(m?.launcher || '');
      const id = String(m?.id || '').slice(0, 120);
      const key = `${launcher}:${id}`;
      if (!LAUNCHERS.has(launcher) || !id || seen.has(key)) continue;
      seen.add(key);
      members.push({ launcher, id });
    }
    out.push({ id: /^[a-f0-9]{16}$/.test(p.id) ? p.id : crypto.randomBytes(8).toString('hex'), name, members });
  }
  return out;
}

function get() {
  return clean(settings.get(KEY, []));
}

function save(list) {
  const c = clean(list);
  settings.set({ [KEY]: c });
  return c;
}

module.exports = { get, save, clean };
