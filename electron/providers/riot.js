// Riot Games (League of Legends, Valorant, Legends of Runeterra)
// Alle Riot-Spiele sind kostenlos – nicht installierte werden zum Installieren angeboten,
// sobald der Riot Client vorhanden ist.
const { t } = require('../lib/i18n.js');
const path = require('path');
const reg = require('../lib/registry');
const { getArg, cleanExePath, exists, readJson, env, exeLaunch } = require('../lib/util');

const { isMac, macShared } = require('../lib/platform');

// Windows: %ProgramData%\Riot Games, macOS: /Users/Shared/Riot Games
function riotDir() {
  return isMac ? macShared('Riot Games') : path.join(env('PROGRAMDATA') || 'C:\\ProgramData', 'Riot Games');
}

/**
 * macOS (und als Ergänzung unter Windows): installierte Produkte aus
 * Metadata/<produkt>.live/<produkt>.live.product_settings.yaml (product_install_full_path).
 */
async function installedFromMetadata() {
  const out = [];
  const meta = path.join(riotDir(), 'Metadata');
  for (const id of await require('../lib/util').listDir(meta)) {
    const m = id.match(/^([a-z0-9_]+)\.(live|pbe)$/);
    if (!m || m[1] === 'riot_client') continue;
    const yaml = await require('../lib/util').readText(path.join(meta, id, `${id}.product_settings.yaml`));
    const dir = yaml?.match(/product_install_full_path:\s*"?([^"\n]+)"?/)?.[1];
    if (dir && (await exists(dir))) out.push({ product: m[1], patchline: m[2], dir });
  }
  return out;
}

const PRODUCTS = [
  { id: 'league_of_legends', name: 'League of Legends' },
  { id: 'valorant', name: 'VALORANT' },
  { id: 'bacon', name: 'Legends of Runeterra' }
];

async function findClient(fromUninstall) {
  if (fromUninstall && (await exists(fromUninstall))) return fromUninstall;
  const info = await readJson(path.join(riotDir(), 'RiotClientInstalls.json'));
  for (const p of [info?.rc_default, info?.rc_live]) {
    if (p && (await exists(p))) return p;
  }
  const fallbacks = isMac
    ? [macShared('Riot Games', 'Riot Client.app'), '/Applications/Riot Client.app']
    : ['C:\\Riot Games\\Riot Client\\RiotClientServices.exe'];
  for (const f of fallbacks) if (await exists(f)) return f;
  return null;
}

async function riotUpdate(productId) {
  const s = await readJson(path.join(riotDir(), 'Metadata', productId, `${productId}.update-status.json`));
  if (s?.status?.updateRequired) return { state: 'available', detail: t("Pflicht-Update") };
  if (s?.status?.updateAvailable) return { state: 'available' };
  return null;
}

async function updates() {
  const map = new Map();
  for (const id of await require('../lib/util').listDir(path.join(riotDir(), 'Metadata'))) {
    if (!/\.live$/.test(id)) continue;
    const u = await riotUpdate(id);
    if (u) map.set(id, u);
  }
  // Laufendes Patchen samt Prozent aus dem Log des Riot Client
  for (const [id, live] of await require('../lib/riotClient').liveUpdates().catch(() => new Map())) {
    if (/^riot_client\./.test(id)) continue;
    map.set(id, { ...(map.get(id) || {}), ...live });
  }
  return [...map].map(([nativeId, update]) => ({ nativeId, update }));
}

/**
 * Update im Hintergrund: über die lokale Schnittstelle des Riot Client in die Warteschlange.
 * Läuft der Riot Client nicht, wird er unsichtbar gestartet und es wird kurz gewartet.
 */
async function backgroundUpdate(game) {
  const rc = require('../lib/riotClient');
  if (await rc.queuePatch(game.nativeId)) return { type: 'none' };
  const client = await findClient(null);
  if (!client) return null;
  if (!rc.hasApi()) {
    const { spawn } = require('child_process');
    try {
      const child = isMac
        ? spawn('open', ['-g', '-a', client], { detached: true, stdio: 'ignore' })
        : spawn(client, [], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {});
      child.unref();
    } catch { /* weiter unten sichtbar */ }
    for (let i = 0; i < 20 && !rc.hasApi(); i++) await new Promise((r) => setTimeout(r, 1000));
  }
  for (let i = 0; i < 5; i++) {
    if (await rc.queuePatch(game.nativeId)) return { type: 'none' };
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null; // Ludora öffnet dann den Riot Client sichtbar
}

async function detect() {
  const entries = await reg.getUninstallEntries();
  const games = [];
  const installed = new Set();
  let clientFromUninstall = null;

  for (const { values: v } of entries) {
    const un = v.UninstallString || '';
    if (!/RiotClientServices\.exe/i.test(un)) continue;
    const product = getArg(un, 'uninstall-product');
    const patchline = getArg(un, 'uninstall-patchline') || 'live';
    if (!product || /^riot_client$/i.test(product) || /^Riot Client$/i.test(v.DisplayName || '')) continue;

    const client = cleanExePath(un);
    clientFromUninstall = client;
    installed.add(product);
    games.push({
      nativeId: `${product}.${patchline}`,
      name: v.DisplayName || product,
      installDir: v.InstallLocation,
      status: 'installed',
      covers: [],
      // Logo aus ProgramData\Riot Games\Metadata (bis 256 px) – wird als Platzhalter-Bild gezeigt
      iconUrl: `ghimg://riot/${product}.${patchline}`,
      update: await riotUpdate(`${product}.${patchline}`),
      launch: {
        type: 'exe',
        target: client,
        args: [`--launch-product=${product}`, `--launch-patchline=${patchline}`]
      }
    });
  }

  const client = await findClient(clientFromUninstall);

  // macOS: keine Uninstall-Einträge – installierte Spiele aus den Riot-Metadaten
  if (isMac && client) {
    for (const p of await installedFromMetadata()) {
      if (installed.has(p.product)) continue;
      installed.add(p.product);
      games.push({
        nativeId: `${p.product}.${p.patchline}`,
        name: PRODUCTS.find((x) => x.id === p.product)?.name || p.product,
        installDir: p.dir,
        status: 'installed',
        covers: [],
        update: await riotUpdate(`${p.product}.${p.patchline}`),
        launch: { type: 'exe', target: client, args: [`--launch-product=${p.product}`, `--launch-patchline=${p.patchline}`] }
      });
    }
  }
  if (client) {
    for (const p of PRODUCTS) {
      if (installed.has(p.id)) continue;
      games.push({
        nativeId: `${p.id}.live`,
        name: p.name,
        status: 'notInstalled',
        covers: [],
        iconUrl: `ghimg://riot/${p.id}.live`,
        // Der Riot Client fragt dann, ob installiert werden soll
        launch: { type: 'exe', target: client, args: [`--launch-product=${p.id}`, '--launch-patchline=live'] }
      });
    }
  }
  return games;
}

module.exports = {
  id: 'riot',
  platforms: ['win32', 'darwin'],
  // Nur der Riot Client selbst – der League-Client (LeagueClientUx) bleibt sichtbar,
  // weil man dort die Spiele startet.
  processes: ['RiotClientUx', 'Riot Client'],
  processesMac: ['Riot Client', 'RiotClientUx'],
  client: async () => exeLaunch(await findClient(null)),
  updates,
  backgroundUpdate,
  store: { type: 'url', target: 'https://www.riotgames.com/de' },
  name: 'Riot Games',
  color: '#2b0d0f',
  accent: '#ff4655',
  detect
};
