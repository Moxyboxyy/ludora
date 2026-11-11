#!/usr/bin/env node
// Funktionstest der Testversion im Terminal: startet Ludora (Debug-Build) mit LUDORA_SELFTEST,
// zeigt jedes Ergebnis farbig an – bei „teilweise“ und „nicht bestanden“ mit Begründung – und
// beendet sich mit Exit-Code 0 (alles bestanden/teilweise) oder 1 (etwas nicht bestanden).
//   npm run selftest              alle automatischen Tests, danach schließt sich Ludora
//   npm run selftest -- --keep    Ludora bleibt offen (Debug-Fenster für manuelle Tests)
//   npm run selftest -- --verbose auch die Ausgabe von Vite/Cargo zeigen
import { spawn } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const verbose = args.has('--verbose');
const env = { ...process.env, LUDORA_SELFTEST: '1' };
if (args.has('--keep')) env.LUDORA_SELFTEST_KEEP = '1';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const red = (s) => paint('31', s);
const dim = (s) => paint('2', s);

console.log('Ludora-Funktionstest – baue und starte die Testversion (der erste Start dauert einige Minuten) …');

const child = spawn('npx', ['tauri', 'dev'], { env, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
let compiling = false;
let last = { fail: 0 };

function handle(line) {
  const m = line.match(/^\[selftest\] ?(.*)$/); // nur direkte Ausgabe, nicht das Protokoll-Echo
  if (!m) {
    if (verbose) console.log(dim(line));
    else if (/^\s*Compiling ludora/.test(line) && !compiling) { compiling = true; console.log(dim('… Ludora wird gebaut')); }
    else if (/\berror(\[E\d+\])?:/.test(line)) console.log(red(line)); // Build-Fehler immer zeigen
    return;
  }
  const text = m[1];
  if (text.startsWith('BESTANDEN')) console.log(green('✔ ') + text.replace(/^BESTANDEN\s+/, ''));
  else if (text.startsWith('TEILWEISE')) console.log(yellow('◐ ') + yellow(text.replace(/^TEILWEISE\s+/, '')));
  else if (text.startsWith('NICHT BESTANDEN')) console.log(red('✘ ') + red(text.replace(/^NICHT BESTANDEN\s+/, '')));
  else if (/^\s+Grund:/.test(text)) console.log('    ' + text.trim());
  else if (text.startsWith('ERGEBNIS')) {
    const f = Number(text.match(/(\d+) nicht bestanden/)?.[1] || 0);
    const w = Number(text.match(/(\d+) teilweise/)?.[1] || 0);
    last.fail = f;
    console.log('\n' + (f ? red(text) : w ? yellow(text) : green(text)));
  } else console.log(dim(text));
}

for (const stream of [child.stdout, child.stderr]) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(handle);
  });
}

process.on('SIGINT', () => child.kill('SIGINT'));
child.on('exit', (code) => {
  process.exit(last.fail ? 1 : code && code !== 0 && !last.fail ? code : 0);
});
