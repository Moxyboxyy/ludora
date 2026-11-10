// Doppelte Namen in der Brücke überschreiben sich still (so blieb "Spiel aktualisieren" wochenlang wirkungslos)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('preload: keine doppelten Namen auf derselben Ebene', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  const body = src.slice(src.indexOf("exposeInMainWorld('gamehub', {") + 30);
  const stack = [new Set()];
  let depth = 0;
  for (const line of body.split('\n')) {
    const m = line.match(/^(\s*)([A-Za-z0-9_]+)\s*:/);
    if (m && m[1].length === 2 * (depth + 1)) {
      const set = stack[depth];
      assert.ok(!set.has(m[2]), `doppelter Name "${m[2]}" in preload.js`);
      set.add(m[2]);
    }
    for (const ch of line.replace(/'[^']*'|"[^"]*"/g, '')) {
      if (ch === '{') { depth++; stack[depth] = stack[depth] && depth > 0 && m ? new Set() : new Set(); }
      if (ch === '}') depth--;
    }
  }
});
