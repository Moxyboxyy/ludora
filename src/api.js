// Zugriff auf den Electron-Hauptprozess.
// Läuft die Oberfläche im normalen Browser (z. B. "npm run build" + Vorschau),
// gibt es Demo-Daten, damit man am Design arbeiten kann.
import { demoScan } from './demo.js';

const native = typeof window !== 'undefined' ? window.gamehub : undefined;

export const isDemo = !native;

export const api = native || {
  scan: async () => { await new Promise((r) => setTimeout(r, 400)); return demoScan(); },
  launch: async () => ({ ok: true }),
  openLauncher: async () => ({ ok: true }),
  openFolder: async () => ({ ok: true }),
  running: async () => demoScan().games.filter((g) => g.status === 'installed').slice(0, 1).map((g) => g.id), // Vorschau: erstes Spiel "läuft"
  focusGame: async () => ({ ok: true }),
  shop: {
    query: async ({ q = '', store = null, deals = false } = {}) => {
      const st = (launcher, price, priceText, discount = 0) => ({ launcher, url: 'https://store.steampowered.com/', uri: null, price, priceText, discount });
      const games = [
        { key: 'cyberpunk 2077', title: 'Cyberpunk 2077', image: null, stores: [st('steam', 29.99, '29,99€', 50), st('epic', 29.99, '29,99 €', 50), st('gog', 29.99, '29,99 €', 50)], minPrice: 29.99 },
        { key: 'ea sports fc 26', title: 'EA SPORTS FC 26', image: null, stores: [st('steam', 69.99, '69,99€'), st('epic', 69.99, '69,99 €'), st('ea', null, null)], minPrice: 69.99 },
        { key: 'valorant', title: 'VALORANT', image: null, stores: [st('riot', 0, 'Kostenlos')], minPrice: 0 },
        { key: 'diablo iv', title: 'Diablo IV', image: null, stores: [st('steam', 69.99, '69,99€'), st('battlenet', null, null)], minPrice: 69.99 },
        { key: 'assassin s creed shadows', title: "Assassin's Creed Shadows", image: null, stores: [st('steam', 59.99, '59,99€'), st('ubisoft', null, null)], minPrice: 59.99 }
      ].filter((g) => (!q || g.key.includes(q.toLowerCase())) && (!store || g.stores.some((s) => s.launcher === store)) && (!deals || g.stores.some((s) => s.discount > 0)));
      return { ok: true, games, errors: {}, more: false };
    },
    more: async () => ({ ok: true, stores: {} }),
    open: async () => ({ ok: true, via: 'browser' })
  },
  favorites: (() => {
    let favs = ['steam:1086940'];
    return {
      get: async () => favs,
      toggle: async (id) => { favs = favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id]; return favs; }
    };
  })(),
  uninstall: async () => ({ ok: false, canceled: true }),
  setCover: async () => ({ ok: false }),
  friends: (() => {
    const demo = {
      status: 'connected', me: { steamid: '1' }, error: null, qr: null,
      friends: [
        { steamid: '76561198000000001', name: 'Lena', state: 'online', appid: 730, gameName: 'Counter-Strike 2', richText: 'Wettkampf – Mirage (7:5)', joinable: true, avatar: null },
        { steamid: '76561198000000002', name: 'Tobi', state: 'online', appid: 3354750, gameName: 'skate.', richText: null, joinable: false, avatar: null },
        { steamid: '76561198000000003', name: 'Sam', state: 'away', appid: null, avatar: null },
        { steamid: '76561198000000004', name: 'Mia', state: 'online', appid: null, avatar: null },
        { steamid: '76561198000000005', name: 'Kevin', state: 'offline', appid: null, avatar: null, lastOnline: Date.now() - 3 * 3600e3 }
      ]
    };
    return {
      get: async () => demo, qr: async () => demo, logout: async () => ({ ok: true }),
      fast: async () => {}, action: async () => ({ ok: true }), onUpdate: () => () => {}
    };
  })(),
  friends2: (() => {
    const st = {
      riot: { status: 'connected', friends: [
        { id: 'p1', name: 'Sam', tag: 'EUW', state: 'online', gameName: 'VALORANT', richText: 'Agenten-Auswahl' },
        { id: 'p2', name: 'Pät', tag: '1337', state: 'offline' }
      ] },
      epic: { status: 'disconnected', needsLogin: true, friends: [] },
      gog: { status: 'connected', friends: [{ id: 'g1', name: 'jonas_gog', state: 'online' }] }
    };
    return {
      list: async () => st, login: async () => ({ ok: false }), logout: async () => ({ ok: true }),
      refresh: async () => {}, fast: async () => {}, startRiot: async () => ({ ok: true }),
      open: async () => ({ ok: true, name: 'Launcher' }), onUpdate: () => () => {}
    };
  })(),
  hub: (() => {
    let st = { configured: true, status: 'signedIn', user: { username: 'alex', display_name: 'Alex' },
      friends: [
        { username: 'sam', displayName: 'Sam', relation: 'friend', online: true, lastSeen: Date.now(),
          accounts: [{ launcher: 'steam', account_id: '76561198000000003', account_name: 'Sam', verified: true },
                     { launcher: 'riot', account_id: 'p1', account_name: 'Sam#EUW', verified: false },
                     { launcher: 'epic', account_id: 'e9', account_name: 'SamTTV', verified: true }] },
        { username: 'paet', displayName: 'Pät', relation: 'incoming', accounts: [] },
        { username: 'lena', displayName: 'Lena', relation: 'outgoing', accounts: [] }
      ],
      links: [{ launcher: 'steam', account_id: '1', account_name: 'Alex', verified: true }, { launcher: 'riot', account_id: 'x', account_name: 'Alex#EUW', verified: false }] };
    return {
      get: async () => st, register: async () => ({ ok: true }), login: async () => ({ ok: true }), logout: async () => ({ ok: true }), deleteAccount: async () => ({ ok: false, cancelled: true }),
      unlink: async () => ({ ok: true }), relink: async () => ({ ok: true }), onUpdate: () => () => {},
      friendRequest: async () => ({ ok: true, message: 'Anfrage gesendet.' }), friendAccept: async () => ({ ok: true }), friendRemove: async () => ({ ok: true }), refreshFriends: async () => {}, steamAdd: async () => ({ ok: true }),
      lookup: async () => ({ ok: true, items: [
        { launcher: 'steam', account_id: '76561198000000002', username: 'tobi', display_name: 'TobiTheGamer', verified: true },
        { launcher: 'riot', account_id: 'p2', username: 'tobi', display_name: 'TobiTheGamer', verified: false }
      ] })
    };
  })(),
  people: (() => {
    let list = [{ id: 'aaaaaaaaaaaaaaaa', name: 'Lena', members: [{ launcher: 'steam', id: '76561198000000001' }, { launcher: 'gog', id: 'g1' }] }];
    return { get: async () => list, save: async (l) => { list = l.map((p, i) => ({ id: p.id || `p${i}`.padEnd(16, '0'), ...p })); return list; } };
  })(),
  chat: {
    open: async (id) => { window.open(`#chat=${id}`, '_blank', 'width=420,height=640'); return { ok: true }; },
    history: async () => ({
      ok: true,
      messages: [
        { fromMe: false, text: 'Bock auf ne Runde CS?', ts: Date.now() - 600e3 },
        { fromMe: true, text: 'Klar, gib mir 5 Minuten', ts: Date.now() - 540e3 },
        { fromMe: false, text: 'Perfekt, ich bin in der Lobby 👍', ts: Date.now() - 60e3 }
      ]
    }),
    send: async () => ({ ok: true }), typing: async () => {}, read: async () => {},
    onEvent: () => () => {}
  },
  downloadsStatus: async () => ({
    'steam:1245620': { state: 'downloading', progress: 0.42, bytesDone: 21e9, bytesTotal: 50e9, speed: 38.4e6, eta: 754 },
    'epic:fortnite': { state: 'downloading', detail: 'Inhalt von LEGO® Fortnite', bytesDone: 1.2e9, speed: 22e6 },
    'steam:413150': { state: 'available' },
    'battlenet:diablo-iv': { state: 'paused' }
  }),
  update: async () => ({ ok: true }),
  manageDownload: async () => ({ ok: true, name: 'Steam' }),
  pickExe: async () => 'C:\\Games\\MeinSpiel\\MeinSpiel.exe',
  addManual: async () => ({ ok: true }),
  removeManual: async () => ({ ok: true }),
  getSettings: async () => ({ language: 'en', steamApiKey: '', steamId: '', steamGridDbKey: '', launcherMode: 'hide', accounts: { battlenet: { connected: false } }, enabledLaunchers: { amazon: false },
    launchers: [['steam','Steam','#66c0f4'],['epic','Epic Games','#f5f5f5'],['gog','GOG','#c79bff'],['ea','EA app','#ff4747'],['ubisoft','Ubisoft Connect','#5aa0ff'],['battlenet','Battle.net','#148eff'],['amazon','Amazon Games','#ff9900'],['riot','Riot Games','#ff4655'],['rockstar','Rockstar','#fcaf17'],['manual','Eigene Spiele','#7ee2a8']].map(([id,name,accent]) => ({ id, name, accent, account: id === 'battlenet' })), detectedSteamId: '76561198000000000' }),
  setSettings: async () => ({ ok: true }),
  cacheInfo: async () => ({ bytes: 48 * 1024 * 1024 }),
  clearCache: async () => ({ bytes: 0 }),
  accountLogin: async () => ({ ok: true, count: 7 }),
  accountLogout: async () => ({ ok: true }),
  openExternal: async (url) => { window.open(url, '_blank'); },
  onCover: () => () => {},
  update: { get: async () => ({ status: 'available', current: '0.5.0', latest: '0.5.1', progress: 0 }), check: async () => ({}), install: async () => ({ ok: true, page: true }), onChange: () => () => {} },
  app: { onNavigate: () => () => {}, info: async () => ({ version: '0.2.0', electron: 'Vorschau' }), devtools: async () => true, quit: async () => true, openData: async () => true },
  platform: 'demo'
};
