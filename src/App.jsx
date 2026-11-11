import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, isDemo } from './api.js';
import Sidebar from './components/Sidebar.jsx';
import GameCard from './components/GameCard.jsx';
import GameRow from './components/GameRow.jsx';
import AddGameDialog from './components/AddGameDialog.jsx';
import DownloadsPanel from './components/DownloadsPanel.jsx';
import FriendsPanel from './components/FriendsPanel.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import ShopView from './components/ShopView.jsx';
import TitleBar from './components/TitleBar.jsx';
import { OpenIcon, StoreIcon, UsersIcon, LauncherLogo } from './components/bits.jsx';
import { reloadApp } from './reload.js';

// Listen im Freunde-Knopf (von oben nach unten)
const FRIEND_LISTS = [['all', t("Alle Freunde")], ['hub', 'Ludora'], ['steam', 'Steam'], ['riot', 'Riot'], ['epic', 'Epic'], ['gog', 'GOG']];
import { t } from './i18n.js';

function loadPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* egal */ }
}

const SHOW_OPTIONS = [
  ['installed', t("Installiert")],
  ['all', t("Alle")],
  ['notInstalled', t("Nicht installiert")],
  ['stream', t("Stream")] // auf einem anderen deiner Geräte installiert
];
// Name des eigenen Betriebssystems (für den Filter "Läuft auf …")
const OS_NAME = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[api.platform] || 'Windows';

const SORT_OPTIONS = [
  ['name', t("Name")],
  ['playtime', t("Spielzeit")],
  ['recent', t("Zuletzt gespielt")]
];

export default function App() {
  const [data, setData] = useState({ games: [], providers: [] });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [view, setView] = useState(() => loadPref('view', 'grid'));
  const [show, setShow] = useState(() => loadPref('show', 'all'));
  const [sort, setSort] = useState(() => loadPref('sort', 'name'));
  // Nur Spiele zeigen, die auf diesem System laufen (oder von einem anderen Gerät gestreamt werden können)
  const [osOnly, setOsOnly] = useState(() => loadPref('osOnly', '1') === '1');
  const [streams, setStreams] = useState({}); // "steam:<appid>" -> ["DESKTOP-PC"]
  const [toast, setToast] = useState(null);
  const [launching, setLaunching] = useState(null);
  const [dialog, setDialog] = useState(null); // 'add' | 'settings' | 'downloads' | 'friends' | null
  const [hubRequest, setHubRequest] = useState(0); // Konto-Knopf oben -> Ludora-Konto-Fenster öffnen
  const [unread, setUnread] = useState({ total: 0 });
  const [friendsDial, setFriendsDial] = useState(false); // Freunde-Knopf: runde Launcher-Knöpfe nach oben

  const notify = useCallback((text, kind = 'info') => {
    setToast({ text, kind, key: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const scan = await api.scan();
      setData(scan);
      const steamErr = scan.providers.find((p) => p.id === 'steam')?.error;
      if (steamErr) notify('Steam: ' + steamErr, 'error');
    } catch (err) {
      notify(t("Scan fehlgeschlagen: {0}", [err.message]), 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  // Tray-Menü -> Bereich öffnen
  useEffect(() => api.app?.onNavigate?.((page) => {
    if (page === 'library') { setFilter((f) => (f === 'shop' ? 'all' : f)); setDialog(null); }
    else if (page === 'shop') { setFilter('shop'); setDialog(null); }
    else if (['downloads', 'friends', 'settings'].includes(page)) setDialog(page);
  }), []);

  // Start: zuerst die gespeicherte Bibliothek (sofort da), dann im Hintergrund neu einlesen
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cached = await api.cachedLibrary?.();
        if (alive && cached?.games?.length) setData((d) => (d.games.length ? d : cached));
      } catch { /* egal */ }
      if (alive) refresh();
    })();
    return () => { alive = false; };
  }, [refresh]);

  // Fenster versteckt (z. B. im Tray)? Dann seltener bzw. gar nicht abfragen
  const [windowVisible, setWindowVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setWindowVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  const downloadsActive = useMemo(() => data.games.some((g) => g.update?.state === 'downloading'), [data.games]);

  // Downloads & Updates
  const pollBusy = useRef(false);
  const pollDownloads = useCallback(async () => {
    if (pollBusy.current) return; // vorige Abfrage läuft noch
    pollBusy.current = true;
    try {
      const map = await api.downloadsStatus();
      setData((d) => {
        let changed = false;
        const games = d.games.map((g) => {
          const u = map[g.id] || null;
          if (JSON.stringify(u) === JSON.stringify(g.update || null)) return g;
          changed = true;
          return { ...g, update: u };
        });
        return changed ? { ...d, games } : d; // nichts geändert -> nichts neu zeichnen
      });
    } catch { /* egal */ } finally { pollBusy.current = false; }
  }, []);
  useEffect(() => {
    if (loading) return;
    pollDownloads();
    // Läuft ein Download (oder ist das Download-Fenster offen): jede Sekunde, sonst alle 15 s
    const fast = windowVisible && (dialog === 'downloads' || downloadsActive);
    const timer = setInterval(pollDownloads, fast ? 1000 : windowVisible ? 15000 : 60000);
    return () => clearInterval(timer);
  }, [pollDownloads, dialog, loading, downloadsActive, windowVisible]);

  // Laufende Spiele: alle 5 s (statt "Spielen" steht dann "Läuft")
  const [runningIds, setRunningIds] = useState(() => new Set());
  const [uninstalling, setUninstalling] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => loadPref('sidebarCollapsed', '0') === '1');

  // Favoriten (Spiel-IDs, launcherübergreifend)
  const [favorites, setFavorites] = useState(() => new Set());
  useEffect(() => { api.favorites.get().then((l) => setFavorites(new Set(l))).catch(() => {}); }, []);
  const toggleFavorite = useCallback(async (game) => {
    setFavorites((prev) => { const n = new Set(prev); if (n.has(game.id)) n.delete(game.id); else n.add(game.id); return n; });
    try { setFavorites(new Set(await api.favorites.toggle(game.id))); } catch { /* bleibt lokal */ }
  }, []);
  useEffect(() => {
    if (loading || !windowVisible) return;
    let alive = true;
    const tick = async () => {
      try {
        const ids = await api.running();
        if (alive) setRunningIds((prev) => (prev.size === ids.length && ids.every((i) => prev.has(i)) ? prev : new Set(ids)));
      } catch { /* egal */ }
    };
    tick();
    const timer = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [loading, windowVisible]);

  const downloadInfo = useMemo(() => {
    const list = data.games.filter((g) => g.update);
    const running = list.filter((g) => g.update.state === 'downloading' && Number.isFinite(g.update.progress));
    const progress = running.length ? running.reduce((a, g) => a + g.update.progress, 0) / running.length : null;
    return { total: list.length, active: list.some((g) => g.update.state === 'downloading'), progress };
  }, [data.games]);

  // Nachgereicht: läuft das Spiel auf diesem System?
  useEffect(() => api.onCompat?.(({ id, platforms, runsHere }) => {
    setData((d) => ({ ...d, games: d.games.map((g) => (g.id === id ? { ...g, platforms, runsHere } : g)) }));
  }), []);
  // Auf anderen Geräten installiert (Steam Remote Play)
  useEffect(() => {
    api.getStreams?.().then((x) => setStreams(x || {})).catch(() => {});
    return api.onStreams?.((x) => setStreams(x || {}));
  }, []);

  // Nachgeladene Cover einsetzen, sobald sie gefunden wurden
  useEffect(() => api.onCover(({ id, covers, wides }) => {
    setData((d) => ({
      ...d,
      games: d.games.map((g) => (g.id === id ? { ...g, covers, wides } : g))
    }));
  }), []);

  const providerById = useMemo(
    () => Object.fromEntries(data.providers.map((p) => [p.id, p])),
    [data.providers]
  );

  // Streambar = hier nicht installiert, aber auf einem anderen angemeldeten Gerät
  const streamFrom = useCallback((g) => (g.status === 'notInstalled' ? streams[g.id]?.[0] || null : null), [streams]);
  const runsHere = useCallback((g) => g.runsHere !== false || !!streamFrom(g), [streamFrom]);

  const matchesShow = useCallback((g) => {
    if (show === 'stream') return !!streamFrom(g); // läuft ja auf dem anderen Gerät – Systemfilter egal
    return (!osOnly || runsHere(g)) &&
      (show === 'all' || (show === 'notInstalled' ? g.status === 'notInstalled' : g.status !== 'notInstalled'));
  }, [show, osOnly, runsHere, streamFrom]);
  const streamCount = useMemo(() => data.games.filter((g) => streamFrom(g)).length, [data.games, streamFrom]);
  const hiddenOs = useMemo(() => data.games.filter((g) => !runsHere(g)).length, [data.games, runsHere]);
  const toggleOsOnly = () => { setOsOnly(!osOnly); savePref('osOnly', osOnly ? '0' : '1'); };

  // Zähler in der Seitenleiste passend zum Installiert/Alle-Filter
  const counts = useMemo(() => {
    const c = { all: 0 };
    for (const g of data.games) {
      if (favorites.has(g.id)) c.favorites = (c.favorites || 0) + 1; // Favoriten: immer alle zählen
      if (!matchesShow(g)) continue;
      c.all++;
      c[g.provider] = (c[g.provider] || 0) + 1;
    }
    return c;
  }, [data.games, matchesShow, favorites]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = data.games.filter((g) =>
      (filter === 'favorites'
        ? favorites.has(g.id) // Favoriten: unabhängig von Installiert/Alle
        : (filter === 'all' || g.provider === filter) && matchesShow(g)) &&
      (!q || g.name.toLowerCase().includes(q))
    );
    if (sort === 'playtime') list.sort((a, b) => (b.playtimeMin || 0) - (a.playtimeMin || 0));
    if (sort === 'recent') list.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
    return list;
  }, [data.games, filter, query, matchesShow, sort, favorites]);

  async function play(game) {
    setLaunching(game.id);
    const res = await api.launch(game.id);
    setTimeout(() => setLaunching(null), 2500);
    const via = providerById[game.provider]?.name;
    if (!res.ok) notify(res.error || t("Start fehlgeschlagen"), 'error');
    else if (game.status === 'notInstalled') notify(t("{0} öffnet die Installation von {1} …", [via, game.name]));
    else notify(t("{0} wird über {1} gestartet …", [game.name, via]));
  }

  async function streamGame(game) {
    setLaunching(game.id);
    const res = await api.stream(game.id);
    setTimeout(() => setLaunching(null), 2500);
    if (!res.ok) notify(res.error || t("Streamen fehlgeschlagen"), 'error');
    else notify(t("{0} wird von {1} gestreamt …", [game.name, streamFrom(game)]));
  }

  async function openLauncher(providerId, what) {
    const p = providerById[providerId];
    const res = await api.openLauncher(providerId, what);
    if (!res.ok) notify(res.error, 'error');
    else if (what === 'download') notify(t("Download von {0} wird im Browser geöffnet …", [p?.name]));
    else notify(what === 'store' ? t("{0}-Shop wird geöffnet …", [p?.name]) : t("{0} wird geöffnet …", [p?.name]));
  }

  async function runUpdate(game, visible = false) {
    // Läuft der Download schon, öffnet ein Klick den Launcher sichtbar
    const show = visible || game.update?.state === 'downloading';
    const via = providerById[game.provider]?.name;
    if (!show) notify(t("Update von {0} wird über {1} gestartet …", [game.name, via]));
    let res;
    try { res = await api.updateGame(game.id, show); } catch (err) { res = { ok: false, error: String(err?.message || err) }; }
    if (!res.ok) notify(res.error || t("Launcher konnte nicht gestartet werden"), 'error');
    else if (res.fallback || (res.visible && !show)) notify(t(
      "{0} startet das Update nicht von selbst – {1} ist jetzt bei {2} geöffnet, dort auf „Aktualisieren“ klicken.",
      [via, via, game.name]
    ) + (res.steamError ? ` (${res.steamError})` : ''), res.steamError ? 'error' : undefined);
    else if (show) notify(t("{0} wird geöffnet …", [via]));
    else notify(t(
      "Update von {0} läuft im Hintergrund über {1} – Fortschritt unter „Downloads“.",
      [game.name, via]
    ));
    pollDownloads();
    setTimeout(pollDownloads, 4000);
  }

  async function setCover(game) {
    const res = await api.setCover(game.id);
    if (!res.ok) return;
    setData((d) => ({
      ...d,
      games: d.games.map((g) => (g.id === game.id ? { ...g, covers: res.covers, wides: res.wides } : g))
    }));
    notify(t("Cover für {0} gespeichert", [game.name]));
  }

  async function openFolder(game) {
    const res = await api.openFolder(game.id);
    if (!res.ok) notify(res.error, 'error');
  }

  async function focusGame(game) {
    const res = await api.focusGame(game.id);
    if (!res.ok) notify(t("{0} läuft nicht mehr.", [game.name]));
  }

  async function uninstallGame(game) {
    setUninstalling(game.id); // Karte zeigt "Deinstalliert …", solange Ludora arbeitet
    const res = await api.uninstall(game.id).finally(() => setUninstalling(null));
    if (res.canceled) return;
    if (!res.ok) return notify(res.error || t("Deinstallieren nicht möglich"), 'error');
    if (res.done) {
      notify(t("{0} wurde deinstalliert (im Hintergrund über {1}).", [game.name, res.via]));
      refresh();
      return;
    }
    notify(res.page
      ? t(
      "{0} ist geöffnet – dort bei {1} „Deinstallieren“ wählen.",
      [res.via, game.name]
    )
      : t(
      "Deinstallation von {0} gestartet ({1}). Die Bibliothek aktualisiert sich danach.",
      [game.name, res.via]
    ));
    // Nach einer Weile neu scannen, damit das Spiel als "nicht installiert" erscheint
    setTimeout(refresh, 60000);
  }

  async function removeGame(game) {
    const res = await api.removeManual(game.id);
    if (res.ok) { notify(t("{0} entfernt", [game.name])); refresh(); }
    else notify(res.error, 'error');
  }

  function pref(setter, key) {
    return (v) => { setter(v); savePref(key, v); };
  }
  const changeView = pref(setView, 'view');
  const changeShow = pref(setShow, 'show');
  const changeSort = pref(setSort, 'sort');

  const title = filter === 'all' ? t("Alle Spiele") : filter === 'favorites' ? t("Favoriten") : providerById[filter]?.name;
  // Karten bekommen Handler, die immer die aktuelle Funktion aufrufen (über eine Ref).
  // So können GameCard/GameRow per memo Neuzeichnen überspringen, wenn sich am Spiel nichts geändert hat.
  const act = useRef({});
  act.current = { play, streamGame, openFolder, setCover, runUpdate, toggleFavorite, focusGame, uninstallGame, removeGame };
  const cardProps = (g) => ({
    game: uninstalling === g.id ? { ...g, busy: t("Deinstalliert …") } : g,
    provider: providerById[g.provider],
    launching: launching === g.id,
    onPlay: () => act.current.play(g),
    streamFrom: streamFrom(g),
    onStream: () => act.current.streamGame(g),
    osName: OS_NAME,
    onFolder: () => act.current.openFolder(g),
    onSetCover: () => act.current.setCover(g),
    onUpdate: () => act.current.runUpdate(g),
    running: runningIds.has(g.id),
    favorite: favorites.has(g.id),
    onToggleFavorite: () => act.current.toggleFavorite(g),
    onFocus: () => act.current.focusGame(g),
    // Linux: Heroic/Lutris deinstallieren selbst – dort nur Steam direkt aus Ludora
    onUninstall: g.status === 'installed' && g.provider !== 'manual' && (api.platform !== 'linux' || g.provider === 'steam') ? () => act.current.uninstallGame(g) : undefined,
    onRemove: g.removable ? () => act.current.removeGame(g) : undefined
  });

  return (
    (<div className="shell">
      <TitleBar
        page={filter === 'shop' ? 'shop' : 'library'}
        onLibrary={() => { if (filter === 'shop') setFilter('all'); }}
        onShop={() => setFilter('shop')}
        onSettings={() => setDialog('settings')}
        onRefresh={refresh}
        onAccount={() => { setDialog('friends'); setHubRequest((n) => n + 1); }}
        notify={notify}
      />
      <div className={`app ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => { const v = !sidebarCollapsed; setSidebarCollapsed(v); savePref('sidebarCollapsed', v ? '1' : '0'); }}
          providers={data.providers}
          counts={counts}
          active={filter}
          onSelect={setFilter}
          onAdd={() => setDialog('add')}
          onOpenLauncher={openLauncher}
          downloads={downloadInfo}
          onDownloads={() => setDialog('downloads')}
        />

        {filter === 'shop' ? (
        <main className="main">
          <ShopView providerById={providerById} games={data.games} notify={notify} />
        </main>
        ) : (
        <main className="main">
          <header className="topbar">
            <div className="title-block">
              <h1>{title}</h1>
              <span className="count">{visible.length} {visible.length === 1 ? t("Spiel") : t("Spiele")}</span>
              {filter !== 'all' && providerById[filter] && (
                <div className="launcher-actions">
                  {providerById[filter].hasClient && (
                    <button className="secondary small" onClick={() => openLauncher(filter, 'client')}>
                      <OpenIcon /> {t("{0} öffnen", [providerById[filter].name])}</button>
                  )}
                  {providerById[filter].hasStore && (
                    <button className="secondary small" onClick={() => openLauncher(filter, 'store')}>
                      <StoreIcon /> {t("Shop")}</button>
                  )}
                </div>
              )}
            </div>

            <div className="search">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <input
                placeholder={t("Bibliothek durchsuchen")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div className="segmented" role="tablist" aria-label={t("Ansicht")}>
              <button className={view === 'grid' ? 'on' : ''} onClick={() => changeView('grid')} title={t("Raster")}>
                <svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></svg>
              </button>
              <button className={view === 'list' ? 'on' : ''} onClick={() => changeView('list')} title={t("Liste")}>
                <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
              </button>
            </div>

          </header>

          <div className="toolbar">
            {filter === 'favorites' ? (
              <div className="fav-hint">{t("Alle Favoriten aus allen Launchern – installiert oder nicht")}</div>
            ) : (
              <div className="segmented text">
                {SHOW_OPTIONS.map(([id, label]) => (
                  <button key={id} className={show === id ? 'on' : ''} onClick={() => changeShow(id)}
                    title={id === 'stream' ? t("Spiele, die auf einem anderen deiner Geräte installiert sind und sich hierher streamen lassen") : undefined}>
                    {label}{id === 'stream' && streamCount > 0 && <span className="seg-count">{streamCount}</span>}
                  </button>
                ))}
              </div>
            )}
            <button className={`os-filter ${osOnly ? 'on' : ''}`} onClick={toggleOsOnly}
              title={osOnly
                ? t("Nur Spiele, die auf {0} laufen oder von einem anderen Gerät gestreamt werden können ({1} ausgeblendet) – klicken für alle", [OS_NAME, hiddenOs])
                : t("Alle Spiele – auch die, die nicht auf {0} laufen", [OS_NAME])}>
              <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
              {t("Läuft auf {0}", [OS_NAME])}
              {osOnly && hiddenOs > 0 && <span className="os-hidden">−{hiddenOs}</span>}
            </button>
            <button className="reload-btn" onClick={reloadApp} title={t("Neu laden – Bibliothek frisch einlesen")} aria-label={t("Neu laden")}>
              <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" /></svg>
            </button>
            <label className="sort">{t("Sortieren:")}<select value={sort} onChange={(e) => changeSort(e.target.value)}>
                {SORT_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
          </div>

          {isDemo && (
            <div className="banner">{t(
              "Vorschau mit Beispieldaten – in der Ludora-App siehst du deine echten Spiele."
            )}</div>
          )}

          {loading && !data.games.length ? (
            <div className="empty"><div className="loader" />{t("Launcher werden durchsucht …")}</div>
          ) : visible.length === 0 ? (
            <div className="empty">
              {query ? t("Nichts gefunden für „{0}“.", [query])
                : filter === 'favorites' ? t("Noch keine Favoriten – klick bei einem Spiel auf das Herz.")
                : show === 'stream' ? t("Gerade lässt sich nichts streamen. Dafür muss ein anderes deiner Geräte eingeschaltet und bei Steam angemeldet sein, und du musst in Ludora bei Steam angemeldet sein (Freunde → Steam).")
                : t("Hier gibt es keine Spiele für diesen Filter.")}
            </div>
          ) : view === 'grid' ? (
            <section className="grid">
              {visible.map((g) => <GameCard key={g.id} {...cardProps(g)} />)}
            </section>
          ) : (
            <section className="list">
              {visible.map((g) => <GameRow key={g.id} {...cardProps(g)} />)}
            </section>
          )}
        </main>
        )}

        {dialog === 'add' && (
          <AddGameDialog
            onClose={() => setDialog(null)}
            onAdded={(name) => { setDialog(null); notify(t("{0} hinzugefügt", [name])); refresh(); }}
          />
        )}
        {dialog === 'settings' && (
          <SettingsDialog
            providerById={providerById}
            onClose={() => setDialog(null)}
            onSaved={() => { setDialog(null); notify(t("Gespeichert – Bibliothek wird neu geladen …")); refresh(); }}
          />
        )}

        {dialog === 'downloads' && (
          <DownloadsPanel
            games={data.games}
            providerById={providerById}
            onClose={() => setDialog(null)}
            onUpdate={(g) => runUpdate(g, false)}
            onOpen={(g) => runUpdate(g, true)}
            onManage={async (g) => {
              const res = await api.manageDownload(g.id);
              if (res.ok && res.silent) {
                notify(t(
                  res.action === 'paused' ? "{0}: Download angehalten." : "{0}: Download fortgesetzt.",
                  [g.name]
                ));
                pollDownloads();
              } else if (res.ok) notify(t(
                "{0}: Download-Ansicht geöffnet – dort pausieren oder fortsetzen.",
                [res.name]
              ));
              else notify(res.error, 'error');
            }}
          />
        )}
        <FriendsPanel
          open={dialog === 'friends'}
          onClose={() => setDialog(null)}
          games={data.games}
          onLaunchGame={play}
          notify={notify}
          onUnread={setUnread}
          providerById={providerById}
          hubRequest={hubRequest}
        />

        {/* Freunde: schwebender Knopf unten rechts – Zahl = ungelesene Nachrichten. Klick klappt runde Launcher-Knöpfe
            nach oben auf; jeder öffnet die passende Freundesliste im eigenen Freundefenster. */}
        {!dialog && (
          <div className={`friends-dial ${friendsDial ? 'open' : ''}`} onMouseLeave={() => setFriendsDial(false)}>
            {friendsDial && FRIEND_LISTS.map(([id, name], i) => (
              <button key={id} className="round-pick" style={{ '--i': FRIEND_LISTS.length - 1 - i }} title={name} aria-label={name}
                onClick={() => { setFriendsDial(false); api.friendsWindow?.open(id); }}>
                {id === 'all' ? <UsersIcon /> : <LauncherLogo provider={id === 'hub' ? { id: 'manual' } : { id, name, ...(providerById[id] || {}) }} />}
                {(id === 'all' ? unread.total : unread[id]) > 0 && <span className="fab-badge">{id === 'all' ? unread.total : unread[id]}</span>}
              </button>
            ))}
            <button className="friends-fab" onClick={() => setFriendsDial((v) => !v)} aria-expanded={friendsDial}
              title={unread.total ? t("Freunde – {0} ungelesene Nachrichten", [unread.total]) : t("Freunde")} aria-label={t("Freunde")}>
              <UsersIcon />
              {unread.total > 0 && <span className="fab-badge">{unread.total}</span>}
            </button>
          </div>
        )}

        {toast && <div key={toast.key} className={`toast ${toast.kind}`}>{toast.text}</div>}
      </div>
    </div>)
  );
}
