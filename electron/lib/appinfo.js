// Liest Steams lokalen App-Cache (Steam\appcache\appinfo.vdf).
// Darin stehen Name und Typ (Spiel, DLC, Tool, ...) jeder App, die der
// Steam-Client kennt – damit brauchen wir keine Web-API für die Namen.
//
// Binärformat:
//   u32 magic, u32 universe, [u64 stringTableOffset  (nur ab 0x07564429)]
//   pro App: u32 appid, u32 size, u32 infoState, u32 lastUpdated, u64 token,
//            20 byte sha1, u32 changeNumber, [20 byte binarySha1 (ab 0x07564428)],
//            binäre KeyValues
//   Ab 0x07564429 sind Schlüssel u32-Indizes in eine Stringtabelle am Dateiende.
const fs = require('fs');

const MAGIC_27 = 0x07564427;
const MAGIC_28 = 0x07564428;
const MAGIC_29 = 0x07564429;

function readCString(buf, pos) {
  let end = pos;
  while (end < buf.length && buf[end] !== 0) end++;
  return [buf.toString('utf8', pos, end), end + 1];
}

/** Binäre KeyValues ab pos lesen. Gibt [objekt, neuePos] zurück. */
function readKv(buf, pos, strings, end) {
  const obj = {};
  while (pos < end) {
    const type = buf[pos++];
    if (type === 0x08) return [obj, pos];

    let key;
    if (strings) { key = strings[buf.readUInt32LE(pos)]; pos += 4; }
    else { [key, pos] = readCString(buf, pos); }

    switch (type) {
      case 0x00: { const [o, p] = readKv(buf, pos, strings, end); obj[key] = o; pos = p; break; }
      case 0x01: { const [s, p] = readCString(buf, pos); obj[key] = s; pos = p; break; }
      case 0x02: case 0x04: case 0x06: obj[key] = buf.readInt32LE(pos); pos += 4; break;
      case 0x03: obj[key] = buf.readFloatLE(pos); pos += 4; break;
      case 0x07: case 0x0a: obj[key] = buf.readBigUInt64LE(pos).toString(); pos += 8; break;
      case 0x05: { // UTF-16-String
        let e = pos;
        while (e + 1 < end && (buf[e] !== 0 || buf[e + 1] !== 0)) e += 2;
        obj[key] = buf.toString('utf16le', pos, e); pos = e + 2; break;
      }
      default:
        throw new Error(`Unbekannter KV-Typ ${type}`);
    }
  }
  return [obj, pos];
}

function getCI(obj, key) {
  if (!obj) return undefined;
  if (key in obj) return obj[key];
  const k = Object.keys(obj).find((x) => x.toLowerCase() === key);
  return k ? obj[k] : undefined;
}

/**
 * Liefert Map appid -> { name, type } für die gewünschten IDs.
 * wanted: Set von appid-Strings (null = alle; langsam).
 */
async function readAppInfo(file, wanted) {
  const buf = await fs.promises.readFile(file);
  const magic = buf.readUInt32LE(0);
  if (![MAGIC_27, MAGIC_28, MAGIC_29].includes(magic)) {
    throw new Error('Unbekanntes appinfo.vdf-Format (' + magic.toString(16) + ')');
  }

  let pos = 8;
  let strings = null;
  let dataEnd = buf.length;
  if (magic === MAGIC_29) {
    const tableOffset = Number(buf.readBigUInt64LE(8));
    pos = 16;
    dataEnd = tableOffset;
    const count = buf.readUInt32LE(tableOffset);
    strings = new Array(count);
    let p = tableOffset + 4;
    for (let i = 0; i < count; i++) [strings[i], p] = readCString(buf, p);
  }
  const headerLen = magic === MAGIC_27 ? 40 : 60;

  const out = new Map();
  while (pos + 8 <= dataEnd) {
    const appid = buf.readUInt32LE(pos);
    if (appid === 0) break;
    const size = buf.readUInt32LE(pos + 4);
    const entryStart = pos + 8;
    const entryEnd = entryStart + size;
    pos = entryEnd;

    const id = String(appid);
    if (wanted && !wanted.has(id)) continue;

    try {
      const [kv] = readKv(buf, entryStart + headerLen, strings, entryEnd);
      const common = getCI(getCI(kv, 'appinfo'), 'common');
      if (!common) continue;
      out.set(id, {
        name: getCI(common, 'name'),
        type: String(getCI(common, 'type') || '').toLowerCase()
      });
    } catch { /* kaputter Eintrag – überspringen */ }
  }
  return out;
}

module.exports = { readAppInfo, readKv };
