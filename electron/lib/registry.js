// Liest die Windows-Registry über das eingebaute "reg.exe".
// So brauchen wir kein natives Node-Modul, das extra kompiliert werden müsste.
const { execFile } = require('child_process');

const VALUE_RE = /^\s{4}(.+?)\s{4}(REG_[A-Z_]+)\s{4}(.*)$/;
const VALUE_EMPTY_RE = /^\s{4}(.+?)\s{4}(REG_[A-Z_]+)\s*$/;

/**
 * Parst die Ausgabe von `reg query <key> /s`.
 * Ergebnis: { "HKEY_...\\Sub\\Key": { ValueName: value, ... }, ... }
 */
function parseRegOutput(output) {
  const result = {};
  let current = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;

    if (line.startsWith('HKEY_')) {
      current = line;
      result[current] = result[current] || {};
      continue;
    }
    if (!current) continue;

    let m = line.match(VALUE_RE);
    let name, type, value;
    if (m) {
      [, name, type, value] = m;
    } else if ((m = line.match(VALUE_EMPTY_RE))) {
      [, name, type] = m;
      value = '';
    } else {
      continue;
    }

    // "(Standard)" / "(Default)" – je nach Windows-Sprache
    if (/^\((Standard|Default|Par défaut|Predeterminado)\)$/i.test(name)) name = '(Default)';

    if (type === 'REG_DWORD' || type === 'REG_QWORD') {
      value = parseInt(value, 16);
    }
    result[current][name] = value;
  }
  return result;
}

// reg.exe gibt immer die langen Namen aus (HKEY_LOCAL_MACHINE statt HKLM)
const HIVES = {
  HKLM: 'HKEY_LOCAL_MACHINE',
  HKCU: 'HKEY_CURRENT_USER',
  HKCR: 'HKEY_CLASSES_ROOT',
  HKU: 'HKEY_USERS'
};

function normalizeKey(key) {
  const [hive, ...rest] = key.split('\\');
  return [HIVES[hive.toUpperCase()] || hive, ...rest].join('\\');
}

/** Liest einen Schlüssel rekursiv. Gibt {} zurück, wenn er nicht existiert. */
function queryKey(key, { recursive = true } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({});
  // Über cmd mit Codepage 65001 (UTF-8), sonst kommen Umlaute als "�" an
  const cmd = `chcp 65001>nul && reg query "${key.replace(/"/g, '')}"${recursive ? ' /s' : ''}`;
  return new Promise((resolve) => {
    execFile('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8', windowsVerbatimArguments: true },
      (err, stdout) => {
        if (err || !stdout) return resolve({});
        resolve(parseRegOutput(stdout));
      });
  });
}

/** Liest einen einzelnen Wert. */
async function getValue(key, name) {
  const data = await queryKey(key, { recursive: false });
  const full = normalizeKey(key).toLowerCase();
  const match = Object.keys(data).find((k) => k.toLowerCase() === full);
  const entry = match ? data[match] : undefined;
  return entry ? entry[name] : undefined;
}

/** Erster gefundener Wert aus mehreren möglichen Schlüsseln. */
async function getFirstValue(candidates) {
  for (const [key, name] of candidates) {
    const v = await getValue(key, name);
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/** Direkte Unterschlüssel eines Schlüssels mit ihren Werten. */
async function getSubKeys(key) {
  const data = await queryKey(key, { recursive: true });
  const prefix = normalizeKey(key).toLowerCase() + '\\';
  const out = [];
  for (const [path, values] of Object.entries(data)) {
    const lower = path.toLowerCase();
    if (!lower.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest.includes('\\')) continue; // nur direkte Kinder
    out.push({ name: rest, path, values });
  }
  return out;
}

// ---- Uninstall-Einträge (Programme & Features), werden pro Scan gecacht ----
const UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
];

let uninstallCache = null;

async function getUninstallEntries() {
  if (uninstallCache) return uninstallCache;
  const lists = await Promise.all(UNINSTALL_KEYS.map(getSubKeys));
  uninstallCache = lists.flat();
  return uninstallCache;
}

function clearCache() {
  uninstallCache = null;
}

module.exports = {
  parseRegOutput,
  normalizeKey,
  queryKey,
  getValue,
  getFirstValue,
  getSubKeys,
  getUninstallEntries,
  clearCache
};
