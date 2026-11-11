// Die Brücke (src/tauriBridge.js) und der Rust-Verteiler (src-tauri/src/ipc.rs) müssen zusammenpassen:
// jeder Kanal der Oberfläche hat einen Zweig in ipc.rs, jedes Ereignis wird in Rust gesendet.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const set = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]));
const rustSources = () => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.rs')) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(path.join(root, 'src-tauri', 'src'));
  return out.join('\n');
};

test('tauriBridge: jeder Kanal hat einen Zweig im Rust-Verteiler', () => {
  const tb = read('src/tauriBridge.js');
  const ipc = read('src-tauri/src/ipc.rs');
  const calls = set(tb, /call\('([^']+)'\)/g);
  const arms = set(ipc, /^\s*"([a-z0-9]+:[A-Za-z0-9]+)"\s*=>/gm);
  const missing = [...calls].filter((c) => !arms.has(c));
  assert.deepStrictEqual(missing, []);
  assert.ok(calls.size >= 68, `nur ${calls.size} Kanäle`);
});

test('tauriBridge: jedes Ereignis wird in Rust gesendet', () => {
  const tb = read('src/tauriBridge.js');
  const rs = rustSources();
  for (const ev of set(tb, /on\('([^']+)'\)/g)) {
    assert.ok(rs.includes(`"${ev}"`), `Ereignis ${ev} wird nirgends gesendet`);
  }
});

test('tauriBridge: keine doppelten Schlüssel (sonst überschreibt einer den anderen)', () => {
  const tb = read('src/tauriBridge.js');
  const body = tb.slice(tb.indexOf('window.gamehub = {'));
  // Schlüssel je Verschachtelungsebene sammeln
  let depth = 0;
  const seen = [new Set()];
  const dups = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+):/);
    if (m && depth >= 1) {
      const s = seen[depth] || (seen[depth] = new Set());
      if (s.has(m[1])) dups.push(m[1]); else s.add(m[1]);
    }
    for (const ch of line) {
      if (ch === '{') { depth++; seen[depth] = new Set(); }
      if (ch === '}') depth--;
    }
    if (depth <= 0 && line.includes('}')) break;
  }
  assert.deepStrictEqual(dups, []);
});

test('i18n: Oberfläche und Rust nutzen dieselbe Übersetzungsdatei', () => {
  assert.match(read('src/i18n.js'), /src-tauri\/i18n\/en\.json/);
  assert.match(read('src-tauri/src/util.rs'), /i18n\/en\.json/);
});
