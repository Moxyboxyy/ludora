// Epic-Manifeste (.manifest, Binärformat) lesen und die Download-Größe eines Updates
// berechnen – so wie es Epic selbst tut:
//   - neue Version: alle Dateien, die zu den gewählten Install-Tags gehören
//   - daraus alle Datenblöcke ("Chunks"), die es in der alten Version noch nicht gab
//   - deren komprimierte Größe zusammenzählen
//
// Aufbau (vgl. Legendary): Kopf (Magic 0x44BEC00C) + zlib-Daten:
//   Meta | Chunk-Liste (GUIDs, Hashes, ..., Fenstergrößen, Dateigrößen) | Datei-Liste (Namen, Tags, Teile)
const fs = require('fs');
const zlib = require('zlib');

const MAGIC = 0x44bec00c;

function readBody(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== MAGIC) throw new Error('Kein Binär-Manifest');
  const headerSize = b.readUInt32LE(4);
  const compressedSize = b.readUInt32LE(12);
  const storedAs = b[36];
  const data = b.subarray(headerSize, headerSize + compressedSize);
  return storedAs & 1 ? zlib.inflateSync(data) : data;
}

function fstring(d, o) {
  const n = d.readInt32LE(o);
  o += 4;
  if (n < 0) return [d.toString('utf16le', o, o - 2 * n).replace(/\0+$/, ''), o - 2 * n];
  return [d.toString('utf8', o, o + n).replace(/\0+$/, ''), o + n];
}

function parse(file) {
  const d = readBody(file);
  let o = d.readUInt32LE(0); // Meta überspringen

  // Chunk-Liste
  const cdlStart = o;
  const cdlSize = d.readUInt32LE(o);
  const count = d.readUInt32LE(o + 5);
  o += 9;
  const guids = new Array(count);
  for (let i = 0; i < count; i++) guids[i] = d.toString('hex', o + i * 16, o + i * 16 + 16);
  o += 16 * count + 8 * count + 20 * count + count + 4 * count; // GUIDs, Hashes, SHA, Gruppen, Fenster
  const chunkSize = new Map();
  for (let i = 0; i < count; i++) chunkSize.set(guids[i], Number(d.readBigInt64LE(o + i * 8)));
  o = cdlStart + cdlSize;

  // Datei-Liste
  const fileCount = d.readUInt32LE(o + 5);
  o += 9;
  let s;
  for (let i = 0; i < 2 * fileCount; i++) [s, o] = fstring(d, o); // Namen + Symlink-Ziele
  o += 21 * fileCount; // SHA + Flags
  const tags = new Array(fileCount);
  for (let i = 0; i < fileCount; i++) {
    const n = d.readUInt32LE(o); o += 4;
    const t = [];
    for (let j = 0; j < n; j++) { [s, o] = fstring(d, o); t.push(s); }
    tags[i] = t;
  }
  const parts = new Array(fileCount);
  for (let i = 0; i < fileCount; i++) {
    const n = d.readUInt32LE(o); o += 4;
    const p = [];
    for (let j = 0; j < n; j++) {
      const partSize = d.readUInt32LE(o);
      p.push(d.toString('hex', o + 4, o + 20));
      o += partSize;
    }
    parts[i] = p;
  }
  return { chunkSize, tags, parts };
}

/**
 * Download-Größe (komprimierte Bytes) von oldFile -> newFile.
 * selectedTags: Set der gewählten Install-Tags oder null (= alle Dateien).
 */
function updateSize(oldFile, newFile, selectedTags) {
  const next = parse(newFile);
  const prev = oldFile && fs.existsSync(oldFile) ? parse(oldFile) : null;
  const wanted = (t) => !selectedTags || !t.length || t.some((x) => selectedTags.has(x));
  const need = new Set();
  next.parts.forEach((p, i) => { if (wanted(next.tags[i])) p.forEach((g) => need.add(g)); });
  let total = 0;
  for (const g of need) if (!prev || !prev.chunkSize.has(g)) total += next.chunkSize.get(g) || 0;
  return total;
}

module.exports = { parse, updateSize };
