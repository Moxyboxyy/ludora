// Minimaler Protobuf-Leser (ohne Schema) – für Ubisofts Cache-Dateien.
// Liefert pro Nachricht eine Liste von { field, wire, value }.

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (true) {
    if (pos >= buf.length) throw new Error('Ende erreicht');
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [result, pos];
    shift += 7;
    if (shift > 63) throw new Error('Varint zu lang');
  }
}

function decode(buf, start = 0, end = buf.length) {
  const out = [];
  let pos = start;
  while (pos < end) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field === 0) throw new Error('Ungültiges Feld');
    let value;
    if (wire === 0) [value, pos] = readVarint(buf, pos);
    else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      if (pos + len > end) throw new Error('Länge außerhalb');
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 1) { value = buf.subarray(pos, pos + 8); pos += 8; }
    else if (wire === 5) { value = buf.subarray(pos, pos + 4); pos += 4; }
    else throw new Error('Unbekannter Wire-Typ');
    out.push({ field, wire, value });
  }
  if (pos !== end) throw new Error('Überlauf');
  return out;
}

/** Erste Zahl je Feldnummer, z. B. { 1: 4553, 6: 0 } */
function ints(msg) {
  const o = {};
  for (const { field, wire, value } of msg) if (wire === 0 && !(field in o)) o[field] = value;
  return o;
}

module.exports = { decode, ints };
