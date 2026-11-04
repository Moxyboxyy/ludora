// Linux-Launcher: Epic, GOG und Amazon über Heroic, Battle.net, EA, Ubisoft und Rockstar über Lutris,
// dazu alle übrigen Lutris-Spiele. Die Module tragen die gleichen IDs wie unter Windows, damit
// Favoriten, Shop-Logos und Freunde gleich funktionieren.
const ll = require('../lib/linuxLaunchers');

const cmdLaunch = (c) => (c ? { type: 'exe', target: c.cmd, args: c.args } : null);

function heroicProvider(id, name, color, accent, store) {
  return {
    id, name, color, accent,
    platforms: ['linux'],
    via: 'Heroic',
    processes: ['heroic'],
    client: async () => cmdLaunch(ll.heroicCommand()),
    store,
    async detect() {
      const client = cmdLaunch(ll.heroicCommand());
      const games = ll.heroicGames(id).map((g) => (g.launch.type === 'heroic' ? { ...g, launch: client } : g));
      // Über Lutris installierte Spiele dieses Stores gehören auch dazu
      const seen = new Set(games.map((g) => g.name.toLowerCase()));
      for (const g of await ll.lutrisGames(id)) if (!seen.has(g.name.toLowerCase())) games.push(g);
      return games.filter((g) => g.launch);
    }
  };
}

function lutrisProvider(id, name, color, accent, store) {
  return {
    id, name, color, accent,
    platforms: ['linux'],
    via: 'Lutris',
    processes: ['lutris'],
    // Ist der Launcher selbst in Lutris eingerichtet, öffnet "Launcher öffnen" genau den, sonst Lutris
    client: async () => (await ll.lutrisLauncherApp(id)) || cmdLaunch(ll.lutrisCommand()),
    store,
    detect: () => ll.lutrisGames(id)
  };
}

module.exports = [
  heroicProvider('epic', 'Epic Games', '#2a2a2a', '#f5f5f5', { type: 'url', target: 'https://store.epicgames.com/' }),
  heroicProvider('gog', 'GOG', '#3b1f4f', '#c79bff', { type: 'url', target: 'https://www.gog.com/games' }),
  heroicProvider('amazon', 'Amazon Games', '#1a2330', '#ff9900', { type: 'url', target: 'https://gaming.amazon.com/home' }),
  lutrisProvider('battlenet', 'Battle.net', '#0b1a2e', '#148eff', { type: 'url', target: 'https://shop.battle.net/' }),
  lutrisProvider('ea', 'EA app', '#3a0d12', '#ff4747', { type: 'url', target: 'https://www.ea.com/games' }),
  lutrisProvider('ubisoft', 'Ubisoft Connect', '#0e1a3a', '#5aa0ff', { type: 'url', target: 'https://store.ubisoft.com/' }),
  lutrisProvider('rockstar', 'Rockstar', '#2a2306', '#fcaf17', { type: 'url', target: 'https://store.rockstargames.com/' }),
  lutrisProvider('lutris', 'Lutris', '#2a1a0d', '#ff9c2a', null)
];
