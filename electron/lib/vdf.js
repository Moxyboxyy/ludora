// Minimaler Parser für Valves KeyValues/VDF-Textformat
// (libraryfolders.vdf, appmanifest_*.acf).
//
// "AppState"
// {
//     "appid"   "123"
//     "name"    "Spiel"
// }

function parseVdf(text) {
  let i = 0;
  const len = text.length;

  function skipWhitespaceAndComments() {
    while (i < len) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
      if (c === '/' && text[i + 1] === '/') {
        while (i < len && text[i] !== '\n') i++;
        continue;
      }
      break;
    }
  }

  function readString() {
    if (text[i] === '"') {
      i++;
      let out = '';
      while (i < len && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < len) {
          const n = text[i + 1];
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
          continue;
        }
        out += text[i++];
      }
      i++; // schließendes "
      return out;
    }
    // Token ohne Anführungszeichen
    let out = '';
    while (i < len && !/[\s{}"]/.test(text[i])) out += text[i++];
    return out;
  }

  function readObject() {
    const obj = {};
    while (true) {
      skipWhitespaceAndComments();
      if (i >= len) return obj;
      if (text[i] === '}') { i++; return obj; }

      const key = readString();
      skipWhitespaceAndComments();
      // optionale Bedingungen wie [$WIN32] überspringen
      if (text[i] === '[') { while (i < len && text[i] !== ']') i++; i++; skipWhitespaceAndComments(); }

      if (text[i] === '{') {
        i++;
        obj[key] = readObject();
      } else {
        obj[key] = readString();
      }
    }
  }

  return readObject();
}

/** Holt einen Wert unabhängig von Groß-/Kleinschreibung des Schlüssels. */
function getCI(obj, key) {
  if (!obj) return undefined;
  if (key in obj) return obj[key];
  const lower = key.toLowerCase();
  const match = Object.keys(obj).find((k) => k.toLowerCase() === lower);
  return match ? obj[match] : undefined;
}

module.exports = { parseVdf, getCI };
