// Brücke für die Rust-Version (Tauri): baut window.gamehub mit genau denselben Funktionen wie
// der früheren Electron-Version – die Oberfläche merkt keinen Unterschied. Alle Aufrufe gehen über einen
// einzigen Rust-Befehl "ipc" (Kanal + Argumente), Ereignisse über Tauri-Events gleichen Namens.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const isTauri = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

const call = (channel) => (...args) => invoke('ipc', { channel, args });

/** Ereignis abonnieren; gibt (wie in Electron) sofort eine Abmelde-Funktion zurück */
const on = (event) => (cb) => {
  let unlisten = null;
  let stopped = false;
  listen(event, (e) => cb(e.payload)).then((fn) => { if (stopped) fn(); else unlisten = fn; });
  return () => { stopped = true; unlisten?.(); };
};

/** Muss vor dem Laden der Oberfläche laufen (api.js / i18n.js lesen window.gamehub beim Import) */
export async function installTauriBridge() {
  const boot = await invoke('ipc', { channel: 'app:boot', args: [] });
  window.gamehub = {
    scan: call('library:scan'),
    cachedLibrary: call('library:cached'),
    launch: call('game:launch'),
    openLauncher: call('launcher:open'),
    friends2: {
      list: call('friends2:list'),
      login: call('friends2:login'),
      logout: call('friends2:logout'),
      refresh: call('friends2:refresh'),
      fast: call('friends2:fast'),
      startRiot: call('friends2:startRiot'),
      open: call('friends2:open'),
      onUpdate: on('friends2:update')
    },
    hub: {
      get: call('hub:get'),
      register: call('hub:register'),
      login: call('hub:login'),
      logout: call('hub:logout'),
      deleteAccount: call('hub:deleteAccount'),
      unlink: call('hub:unlink'),
      relink: call('hub:relink'),
      linkOne: call('hub:linkOne'),
      lookup: call('hub:lookup'),
      friendRequest: call('hub:friendRequest'),
      friendAccept: call('hub:friendAccept'),
      friendRemove: call('hub:friendRemove'),
      refreshFriends: call('hub:refreshFriends'),
      steamAdd: call('hub:steamAdd'),
      onUpdate: on('hub:update')
    },
    people: { get: call('people:get'), save: call('people:save') },
    friends: {
      get: call('friends:get'),
      qr: call('friends:qr'),
      logout: call('friends:logout'),
      fast: call('friends:fast'),
      action: call('friends:action'),
      onUpdate: on('friends:update')
    },
    friendsWindow: {
      open: call('friends:window'),
      onTab: on('friends:tab'),
      onHub: on('friends:hub'),
      dock: call('friends:dock'),
      onDock: on('friends:dock'),
      onSnap: on('friends:snap')
    },
    chat: {
      open: call('chat:open'),
      history: call('chat:history'),
      send: call('chat:send'),
      typing: call('chat:typing'),
      read: call('chat:read'),
      onEvent: on('chat:event')
    },
    downloadsStatus: call('downloads:status'),
    manageDownload: call('download:manage'),
    updateGame: call('game:update'),
    setCover: call('game:setCover'),
    running: call('games:running'),
    shop: { query: call('shop:query'), more: call('shop:more'), open: call('shop:open') },
    favorites: { get: call('favorites:get'), toggle: call('favorites:toggle'), onUpdate: on('favorites:update') },
    focusGame: call('game:focus'),
    uninstall: call('game:uninstall'),
    openFolder: call('game:openFolder'),
    pickExe: call('manual:pickExe'),
    addManual: call('manual:add'),
    removeManual: call('manual:remove'),
    getSettings: call('settings:get'),
    cacheInfo: call('cache:info'),
    clearCache: call('cache:clear'),
    accountLogin: call('account:login'),
    accountLogout: call('account:logout'),
    setSettings: call('settings:set'),
    openExternal: call('app:openExternal'),
    onCompat: on('library:compat'),
    getStreams: call('library:streams'),
    onStreams: on('library:streams'),
    stream: call('game:stream'),
    onCover: on('library:cover'),
    update: {
      get: call('update:get'),
      check: call('update:check'),
      install: call('update:install'),
      onOpen: on('update:open'),
      onChange: on('update:state')
    },
    app: {
      onNavigate: on('app:navigate'),
      info: call('app:info'),
      devtools: call('app:devtools'),
      quit: call('app:quit'),
      openData: call('app:openData')
    },
    platform: boot.platform,
    language: boot.language,
    runtime: 'tauri'
  };
}
