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

test('Funktionstest: jede Funktion der Oberfläche steht im Debug-Fenster', () => {
  const tb = read('src/tauriBridge.js');
  const suite = read('src/debug/suite.js');
  const covered = new Set([...suite.matchAll(/channels: \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])));
  const missing = [...set(tb, /call\('([^']+)'\)/g)].filter((c) => !covered.has(c));
  assert.deepStrictEqual(missing, []);
});

test('Funktionstest: nur in der Testversion (Debug-Build, Vite-Entwicklung)', () => {
  assert.match(read('src/main.jsx'), /import\.meta\.env\.DEV && window\.location\.hash === '#debug'/);
  const lib = read('src-tauri/src/lib.rs');
  assert.match(lib, /#\[cfg\(debug_assertions\)\]\s*pub mod selftest;/);
  assert.match(lib, /#\[cfg\(debug_assertions\)\]\s*selftest::open_window/);
});

test('JSX: keine //-Kommentare zwischen Tags (würden als Text angezeigt)', () => {
  const dir = path.join(root, 'src');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.jsx')) files.push(p); } };
  walk(dir);
  const bad = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => { if (/^\s*\/\/ /.test(l) && i > 0 && />\s*$/.test(lines[i - 1]) && /^\s*</.test(lines[i + 1] || '')) bad.push(`${path.relative(root, f)}:${i + 1}`); });
  }
  assert.deepStrictEqual(bad, []);
});
