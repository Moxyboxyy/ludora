// Ubisoft Connect
//
// Installiert: Registry Ubisoft\Launcher\Installs
// Bibliothek:  lokaler Cache von Ubisoft Connect (ohne Login)
//   cache\ownership\<konto-id>          -> welche Produkt-IDs dir gehören
//   cache\configuration\configurations  -> Name, Typ und Bilder jedes Produkts (YAML)
// Hinweis: Die Ownership-Datei enthält auch CD-Keys. Ludora liest daraus nur die Zahlen-IDs.
const fs = require('fs');
const path = require('path');
const reg = require('../lib/registry');
const galaxy = require('../lib/galaxy');
const { decode, ints } = require('../lib/protobuf');
const { firstExisting, exeLaunch, listDir } = require('../lib/util');
const { normalize } = require('../lib/names');

const INSTALLS_KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs';
const ASSETS = 'https://ubistatic3-a.akamaihd.net/orbit/uplay_launcher_3_0/assets/';

async function launcherDir() {
  const dir = await reg.getFirstValue([['HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher', 'InstallDir']]);
  return dir || 'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher';
}

async function findUbisoftExe() {
  const base = await launcherDir();
  return firstExisting([path.join(base, 'UbisoftConnect.exe'), path.join(base, 'upc.exe')]);
}

// ---------- YAML-Konfiguration (nur die paar Felder, die wir brauchen) ----------

function yamlValue(yaml, key) {
  const m = yaml.match(new RegExp(`^\\s{2}${key}:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1].replace(/^["']|["']$/g, '') : null;
}

/** "l1" / "GAMENAME" -> Text aus localizations.default */
function localize(yaml, value) {
  if (!value || !/^(l\d+|[A-Z_]+)$/.test(value)) return value;
  const block = yaml.match(/^localizations:\s*\n\s+default:\s*\n((?:[ \t]{4,}.*\n?)+)/m);
  if (!block) return null;
  const m = block[1].match(new RegExp(`^\\s+${value}:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1].replace(/^["']|["']$/g, '') : null;
}

function readConfigurations(file) {
  const map = new Map();
  let buf;
  try { buf = fs.readFileSync(file); } catch { return map; }
  for (const { value } of decode(buf)) {
    const msg = decode(value);
    const id = ints(msg)[1];
    const yamlField = msg.find((f) => f.field === 3 && f.wire === 2);
    if (id === undefined || !yamlField) continue;
    const yaml = yamlField.value.toString('utf8');
    if (!/^\s+start_game:/m.test(yaml)) continue; // nur startbare Spiele
    const name = localize(yaml, yamlValue(yaml, 'name'));
    if (!name) continue;
    const thumb = localize(yaml, yamlValue(yaml, 'thumb_image'));
    map.set(id, { name, thumb: thumb && /\.(jpe?g|png)$/i.test(thumb) ? thumb : null });
  }
  return map;
}

/**
 * Ownership-Datei: Kopf (Signatur) + Protobuf. Die Länge des Kopfs ist nicht
 * dokumentiert, daher suchen wir die Stelle, ab der die Datei sauber als Liste
 * von Produkt-Einträgen (Feld 1) lesbar ist.
 */
function readOwnership(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return []; }
  for (let off = 0; off < Math.min(2048, buf.length); off++) {
    if (buf[off] !== 0x0a) continue; // Feld 1, Länge-codiert
    let top;
    try { top = decode(buf, off); } catch { continue; }
    const products = top.filter((f) => f.field === 1 && f.wire === 2);
    if (products.length < top.length * 0.3) continue;
    const out = [];
    try {
      for (const p of products) {
        const v = ints(decode(p.value));
        if (v[1] !== undefined) out.push({ id: v[1], launchId: v[2] || v[1], isAddon: v[6] === 1 });
      }
    } catch { continue; }
    if (out.length) return out;
  }
  return [];
}

async function readLibrary() {
  const base = await launcherDir();
  const cache = path.join(base, 'cache');
  const configs = readConfigurations(path.join(cache, 'configuration', 'configurations'));
  if (!configs.size) return [];

  // Bei mehreren Konten: die zuletzt geänderte Ownership-Datei
  const dir = path.join(cache, 'ownership');
  const files = (await listDir(dir))
    .map((f) => ({ f, t: (() => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) return [];

  const seen = new Set();
  const out = [];
  for (const o of readOwnership(path.join(dir, files[0].f))) {
    if (o.isAddon) continue;
    const cfg = configs.get(o.id);
    if (!cfg) continue;
    if (/\[?\bsteam\]?\s*$/i.test(cfg.name)) continue; // Steam-Fassungen laufen über Steam
    const key = normalize(cfg.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: o.launchId, name: cfg.name, thumb: cfg.thumb ? ASSETS + cfg.thumb : null });
  }
  return out;
}

async function detect() {
  const installs = await reg.getSubKeys(INSTALLS_KEY);
  const uninstall = await reg.getUninstallEntries();

  const games = installs
    .filter((e) => e.values.InstallDir)
    .map(({ name: id, values }) => {
      const dir = path.normalize(values.InstallDir);
      const un = uninstall.find((u) => u.name.toLowerCase() === `uplay install ${id}`);
      return {
        nativeId: id,
        name: un?.values.DisplayName || path.basename(dir),
        installDir: dir,
        status: 'installed',
        covers: [],
        launch: { type: 'uri', target: `uplay://launch/${id}/0` }
      };
    });

  // Bibliothek aus dem lokalen Cache
  const installedIds = new Set(games.map((g) => String(g.nativeId)));
  const installedNames = new Set(games.map((g) => normalize(g.name)));
  for (const o of await readLibrary().catch(() => [])) {
    if (installedIds.has(String(o.id)) || installedNames.has(normalize(o.name))) continue;
    games.push({
      nativeId: String(o.id),
      name: o.name,
      status: 'notInstalled',
      covers: [], // Cover sucht covers.js; das Ubisoft-Bild ist nur Reserve
      ubisoftThumb: o.thumb,
      // Ubisoft Connect zeigt dann den Installieren-Dialog
      launch: { type: 'uri', target: `uplay://launch/${o.id}/0` }
    });
  }

  // Zusätzlich GOG Galaxy, falls Ubisoft dort verknüpft ist
  return galaxy.addOwned(games, ['uplay', 'ubisoft'], (o) =>
    /^\d+$/.test(o.id) ? { type: 'uri', target: `uplay://launch/${o.id}/0` } : null);
}

module.exports = {
  id: 'ubisoft',
  processes: ['upc', 'UbisoftConnect'],
  client: async () => exeLaunch(await findUbisoftExe()),
  store: { type: 'url', target: 'https://store.ubisoft.com/de/home' },
  name: 'Ubisoft Connect',
  color: '#0e1a3a',
  accent: '#5aa0ff',
  detect,
  readOwnership,
  readConfigurations
};
