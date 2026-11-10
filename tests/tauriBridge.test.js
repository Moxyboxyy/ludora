// Die Rust-Brücke (src/tauriBridge.js) muss dieselben Kanäle anbieten wie electron/preload.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const channels = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]));

test('tauriBridge: gleiche Kanäle und Ereignisse wie preload.js', () => {
  const pre = read('electron/preload.js');
  const tb = read('src/tauriBridge.js');
  const preCalls = channels(pre, /ipcRenderer\.invoke\('([^']+)'/g);
  const preEvents = channels(pre, /ipcRenderer\.on\('([^']+)'/g);
  const tbCalls = channels(tb, /call\('([^']+)'\)/g);
  const tbEvents = channels(tb, /on\('([^']+)'\)/g);
  assert.deepStrictEqual([...tbCalls].sort(), [...preCalls].sort());
  assert.deepStrictEqual([...tbEvents].sort(), [...preEvents].sort());
});
