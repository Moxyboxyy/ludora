// Brücke zwischen Oberfläche (React) und Hauptprozess.
// Die Oberfläche bekommt nur diese Funktionen – keinen direkten Systemzugriff.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gamehub', {
  scan: () => ipcRenderer.invoke('library:scan'),
  cachedLibrary: () => ipcRenderer.invoke('library:cached'),
  launch: (gameId) => ipcRenderer.invoke('game:launch', gameId),
  openLauncher: (providerId, what) => ipcRenderer.invoke('launcher:open', providerId, what),
  friends2: {
    list: () => ipcRenderer.invoke('friends2:list'),
    login: (id) => ipcRenderer.invoke('friends2:login', id),
    logout: (id) => ipcRenderer.invoke('friends2:logout', id),
    refresh: (id) => ipcRenderer.invoke('friends2:refresh', id),
    fast: (on) => ipcRenderer.invoke('friends2:fast', on),
    startRiot: () => ipcRenderer.invoke('friends2:startRiot'),
    open: (id) => ipcRenderer.invoke('friends2:open', id),
    onUpdate: (fn) => {
      const h = (_e, v) => fn(v);
      ipcRenderer.on('friends2:update', h);
      return () => ipcRenderer.removeListener('friends2:update', h);
    }
  },
  hub: {
    get: () => ipcRenderer.invoke('hub:get'),
    register: (name, pw) => ipcRenderer.invoke('hub:register', name, pw),
    login: (name, pw) => ipcRenderer.invoke('hub:login', name, pw),
    logout: () => ipcRenderer.invoke('hub:logout'),
    deleteAccount: () => ipcRenderer.invoke('hub:deleteAccount'),
    unlink: (launcher, id) => ipcRenderer.invoke('hub:unlink', launcher, id),
    relink: () => ipcRenderer.invoke('hub:relink'),
    lookup: (items) => ipcRenderer.invoke('hub:lookup', items),
    friendRequest: (name) => ipcRenderer.invoke('hub:friendRequest', name),
    friendAccept: (name) => ipcRenderer.invoke('hub:friendAccept', name),
    friendRemove: (name) => ipcRenderer.invoke('hub:friendRemove', name),
    refreshFriends: () => ipcRenderer.invoke('hub:refreshFriends'),
    steamAdd: (steamid) => ipcRenderer.invoke('hub:steamAdd', steamid),
    onUpdate: (fn) => {
      const h = (_e, v) => fn(v);
      ipcRenderer.on('hub:update', h);
      return () => ipcRenderer.removeListener('hub:update', h);
    }
  },
  people: {
    get: () => ipcRenderer.invoke('people:get'),
    save: (list) => ipcRenderer.invoke('people:save', list)
  },
  friends: {
    get: () => ipcRenderer.invoke('friends:get'),
    qr: () => ipcRenderer.invoke('friends:qr'),
    logout: () => ipcRenderer.invoke('friends:logout'),
    fast: (on) => ipcRenderer.invoke('friends:fast', on),
    action: (steamid, action) => ipcRenderer.invoke('friends:action', steamid, action),
    onUpdate: (cb) => {
      const h = (_e, st) => cb(st);
      ipcRenderer.on('friends:update', h);
      return () => ipcRenderer.removeListener('friends:update', h);
    }
  },
  chat: {
    open: (steamid) => ipcRenderer.invoke('chat:open', steamid),
    history: (steamid) => ipcRenderer.invoke('chat:history', steamid),
    send: (steamid, text) => ipcRenderer.invoke('chat:send', steamid, text),
    typing: (steamid) => ipcRenderer.invoke('chat:typing', steamid),
    read: (steamid) => ipcRenderer.invoke('chat:read', steamid),
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on('chat:event', h);
      return () => ipcRenderer.removeListener('chat:event', h);
    }
  },
  downloadsStatus: () => ipcRenderer.invoke('downloads:status'),
  manageDownload: (gameId) => ipcRenderer.invoke('download:manage', gameId),
  update: (gameId, visible) => ipcRenderer.invoke('game:update', gameId, visible),
  setCover: (gameId) => ipcRenderer.invoke('game:setCover', gameId),
  running: () => ipcRenderer.invoke('games:running'),
  shop: {
    query: (opts) => ipcRenderer.invoke('shop:query', opts),
    more: (titles) => ipcRenderer.invoke('shop:more', titles),
    open: (store) => ipcRenderer.invoke('shop:open', store)
  },
  favorites: {
    get: () => ipcRenderer.invoke('favorites:get'),
    toggle: (gameId) => ipcRenderer.invoke('favorites:toggle', gameId)
  },
  focusGame: (gameId) => ipcRenderer.invoke('game:focus', gameId),
  uninstall: (gameId) => ipcRenderer.invoke('game:uninstall', gameId),
  openFolder: (gameId) => ipcRenderer.invoke('game:openFolder', gameId),
  pickExe: () => ipcRenderer.invoke('manual:pickExe'),
  addManual: (data) => ipcRenderer.invoke('manual:add', data),
  removeManual: (gameId) => ipcRenderer.invoke('manual:remove', gameId),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  cacheInfo: () => ipcRenderer.invoke('cache:info'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  accountLogin: (id) => ipcRenderer.invoke('account:login', id),
  accountLogout: (id) => ipcRenderer.invoke('account:logout', id),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  // Cover, die nach dem Scan im Hintergrund gefunden werden
  onCover: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('library:cover', handler);
    return () => ipcRenderer.removeListener('library:cover', handler);
  },
  update: {
    get: () => ipcRenderer.invoke('update:get'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onChange: (fn) => {
      const h = (_e, st) => fn(st);
      ipcRenderer.on('update:state', h);
      return () => ipcRenderer.removeListener('update:state', h);
    }
  },
  app: {
    onNavigate: (fn) => {
      const h = (_e, page) => fn(page);
      ipcRenderer.on('app:navigate', h);
      return () => ipcRenderer.removeListener('app:navigate', h);
    },
    info: () => ipcRenderer.invoke('app:info'),
    devtools: () => ipcRenderer.invoke('app:devtools'),
    quit: () => ipcRenderer.invoke('app:quit'),
    openData: () => ipcRenderer.invoke('app:openData')
  },
  platform: process.platform,
  language: ipcRenderer.sendSync('i18n:lang')
});
