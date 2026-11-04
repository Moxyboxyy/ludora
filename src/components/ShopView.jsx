import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { LauncherLogo } from './bits.jsx';
import { t, DEC, LOCALE } from '../i18n.js';

const STORE_NAME = {
  steam: 'Steam', epic: 'Epic Games', gog: 'GOG', ea: 'EA app', ubisoft: 'Ubisoft Connect',
  battlenet: 'Battle.net', riot: 'Riot', rockstar: 'Rockstar', amazon: 'Amazon'
};
// Ist der Launcher nicht installiert, gibt es kein Programmsymbol -> Symbol der Store-Webseite (direkt vom Store)
const STORE_FAVICON = {
  steam: 'https://store.steampowered.com/favicon.ico', epic: 'https://store.epicgames.com/favicon.ico',
  gog: 'https://www.gog.com/favicon.ico', ea: 'https://www.ea.com/favicon.ico',
  ubisoft: 'https://store.ubisoft.com/favicon.ico', battlenet: 'https://shop.battle.net/favicon.ico',
  riot: 'https://www.riotgames.com/favicon.ico', rockstar: 'https://www.rockstargames.com/favicon.ico'
};
const EXTRA = new Set(['ea', 'ubisoft', 'battlenet']);

const norm = (s) => String(s || '').replace(/[\u2122\u00ae\u00a9]/g, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[™®©]/g, '').replace(/&/g, ' and ').replace(/\b(standard|base) edition\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

const euro = (n) => (n === 0 ? t("Kostenlos") : `${n.toFixed(2).replace('.', DEC)} €`);

function StoreLogo({ launcher, provider }) {
  const [ok, setOk] = useState(true);
  if (provider?.logo || provider?.id === 'manual') return <LauncherLogo provider={provider} small />;
  if (ok && STORE_FAVICON[launcher]) {
    return <img className="launcher-logo small" alt="" draggable={false} onError={() => setOk(false)} src={STORE_FAVICON[launcher]} />;
  }
  return <span className="store-letter">{(STORE_NAME[launcher] || launcher)[0]}</span>;
}

function ShopCover({ game }) {
  const [src, setSrc] = useState(game.image || game.imageFallback);
  useEffect(() => setSrc(game.image || game.imageFallback), [game.image, game.imageFallback]);
  if (!src) return <div className="shop-cover empty"><span>{game.title}</span></div>;
  return (
    <div className="shop-cover">
      <img src={src} alt="" loading="lazy" draggable={false}
        onError={() => setSrc((cur) => (cur !== game.imageFallback && game.imageFallback ? game.imageFallback : null))} />
    </div>
  );
}

// "In deiner Bibliothek" mit den Logos der Launcher, in denen man das Spiel besitzt
function OwnedBadge({ owned, providerById, className }) {
  const names = owned.map((id) => providerById[id]?.name || STORE_NAME[id] || id);
  return (
    (<span className={`owned-badge ${className || ''}`} title={t("Du besitzt das Spiel bei: {0}", [names.join(', ')])}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      <span>{t("In deiner Bibliothek")}</span>
      <span className="owned-logos">
        {owned.map((id) => (
          <span key={id} className="owned-logo"><StoreLogo launcher={id} provider={providerById[id] || (id === 'manual' ? { id: 'manual' } : null)} /></span>
        ))}
      </span>
    </span>)
  );
}

function ShopCard({ game, owned, providerById, onOpen }) {
  const discount = Math.max(0, ...game.stores.map((s) => s.discount || 0));
  return (
    (<article className="shop-card">
      <button className="shop-cover-btn" onClick={() => onOpen(game.stores[0])} title={t("{0} bei {1} ansehen", [game.title, STORE_NAME[game.stores[0].launcher]])}>
        <ShopCover game={game} />
        {discount > 0 && <span className="shop-discount">-{discount}%</span>}
        {owned && <OwnedBadge owned={owned} providerById={providerById} className="on-cover" />}
      </button>
      <div className="shop-info">
        <div className="shop-title" title={game.title}>{game.title}</div>
        <div className="shop-bottom">
          <span className="shop-price">{priceLabel(game)}</span>
          <StoreButtons game={game} providerById={providerById} onOpen={onOpen} />
        </div>
      </div>
    </article>)
  );
}

function priceLabel(game) {
  const best = game.stores.find((s) => Number.isFinite(s.price) && s.price === game.minPrice);
  if (game.minPrice == null) return <span className="muted">{t("Preis im Store")}</span>;
  return <>{game.stores.length > 1 && game.minPrice > 0 ? t("ab ") : ''}{best?.priceText && game.stores.length === 1 ? t(best.priceText) : euro(game.minPrice)}</>;
}

function StoreButtons({ game, providerById, onOpen }) {
  return (
    <span className="shop-stores">
      {game.stores.map((s) => (
        <button key={s.launcher} className="store-btn" onClick={(e) => { e.stopPropagation(); onOpen(s); }}
          title={t("Bei {0} ansehen", [STORE_NAME[s.launcher] || s.launcher]) + (s.priceText ? ` – ${t(s.priceText)}` : '')}
          aria-label={t("Bei {0} kaufen", [STORE_NAME[s.launcher] || s.launcher])}>
          <StoreLogo launcher={s.launcher} provider={providerById[s.launcher]} />
        </button>
      ))}
    </span>
  );
}

function ShopRow({ game, owned, providerById, onOpen }) {
  const discount = Math.max(0, ...game.stores.map((s) => s.discount || 0));
  return (
    (<div className="shop-row" onClick={() => onOpen(game.stores[0])} title={t("{0} bei {1} ansehen", [game.title, STORE_NAME[game.stores[0].launcher]])}>
      <div className="shop-row-thumb"><ShopCover game={game} /></div>
      <div className="shop-row-title">
        <span>{game.title}</span>
        {owned && <OwnedBadge owned={owned} providerById={providerById} />}
      </div>
      {discount > 0 ? <span className="shop-row-discount">-{discount}%</span> : <span />}
      <span className="shop-price">{priceLabel(game)}</span>
      <StoreButtons game={game} providerById={providerById} onOpen={onOpen} />
    </div>)
  );
}

function countLabel(n, total, approx) {
  if (total && total > n) return t(
    "{0} von {1}{2} Spielen",
    [n, approx ? t("ca. ") : '', total.toLocaleString(LOCALE)]
  );
  return `${n} ${n === 1 ? t("Spiel") : t("Spiele")}`;
}

function loadPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* egal */ }
}
const STORE_TABS = ['steam', 'epic', 'gog', 'ea', 'ubisoft', 'battlenet', 'riot', 'rockstar'];

export default function ShopView({ providerById, games: library, notify }) {
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [failed, setFailed] = useState({});
  const [total, setTotal] = useState(null);
  const [approx, setApprox] = useState(false);
  const [sort, setSort] = useState(() => loadPref('shop.sort', ''));
  const changeSort = (v) => { setSort(v); savePref('shop.sort', v); };
  const [view, setView] = useState(() => loadPref('shop.view', 'grid'));
  const [store, setStore] = useState(() => loadPref('shop.store', 'all'));
  const changeView = (v) => { setView(v); savePref('shop.view', v); };
  const changeStore = (v) => { setStore(v); savePref('shop.store', v); };
  const [deals, setDeals] = useState(() => loadPref('shop.deals', '0') === '1');
  const toggleDeals = () => { const v = !deals; setDeals(v); savePref('shop.deals', v ? '1' : '0'); };
  const gen = useRef(0);
  const sentinel = useRef(null);

  // Titel -> Launcher, in denen man das Spiel besitzt
  const owned = useMemo(() => {
    const m = new Map();
    for (const g of library || []) {
      const k = norm(g.name);
      if (!m.has(k)) m.set(k, []);
      if (!m.get(k).includes(g.provider)) m.get(k).push(g.provider);
    }
    return m;
  }, [library]);

  // Suche erst nach kurzer Tipp-Pause starten
  useEffect(() => {
    const timer = setTimeout(() => setQ(input.trim()), 450);
    return () => clearTimeout(timer);
  }, [input]);

  // EA / Ubisoft / Battle.net für die angezeigten Spiele nachladen
  const addExtraStores = useCallback(async (list, my) => {
    const titles = list.filter((g) => !g.stores.some((s) => EXTRA.has(s.launcher))).map((g) => g.title);
    if (!titles.length || !api.shop?.more) return;
    const res = await api.shop.more(titles);
    if (my !== gen.current || !res?.ok) return;
    setItems((cur) => cur.map((g) => {
      const extra = res.stores[g.key];
      if (!extra?.length) return g;
      const have = new Set(g.stores.map((s) => s.launcher));
      const add = extra.filter((s) => !have.has(s.launcher));
      return add.length ? { ...g, stores: [...g.stores, ...add] } : g;
    }));
  }, []);

  const load = useCallback(async (query, p, st, dl, so, skipped = 0) => {
    if (!api.shop?.query) { setError(t("Der Shop ist nur in der Ludora-App verfügbar.")); return; }
    const my = p === 0 ? ++gen.current : gen.current;
    setLoading(true);
    if (p === 0) setError(null);
    const res = await api.shop.query({ q: query, page: p, store: st === 'all' ? null : st, deals: !!dl, sort: so || '' });
    if (my !== gen.current) return;
    setLoading(false);
    if (!res?.ok) { if (p === 0) { setItems([]); setError(res?.error || t("Shop nicht erreichbar")); } setMore(false); return; }
    setFailed(res.errors || {});
    if (p === 0) { setTotal(res.total || null); setApprox(!!res.approx); }
    // Seite ohne passende Spiele (z. B. nur Bundles): gleich die nächste holen
    if (!res.games.length && res.more && skipped < 5) { load(query, p + 1, st, dl, so, skipped + 1); return; }
    let added = [];
    setItems((cur) => {
      if (p === 0) { added = res.games; return res.games; }
      const seen = new Set(cur.map((g) => g.key));
      added = res.games.filter((g) => !seen.has(g.key));
      return [...cur, ...added];
    });
    setPage(p);
    setMore(res.more);
    if (st === 'all' || !EXTRA.has(st)) setTimeout(() => addExtraStores(added, my), 0);
  }, [addExtraStores]);

  useEffect(() => { setItems([]); setMore(false); load(q, 0, store, deals, sort); }, [q, store, deals, sort, load]);

  // Automatisch weiterladen, wenn man unten ankommt
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more || loading) return undefined;
    const io = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) load(q, page + 1, store, deals, sort); }, { rootMargin: '1500px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more, loading, page, q, store, deals, sort, load]);

  const open = async (store) => {
    const res = await api.shop.open(store);
    if (!res?.ok) notify(res?.error || t("Konnte den Store nicht öffnen"), 'error');
    else notify(res.via === 'launcher' ? t("{0} öffnet die Spielseite …", [STORE_NAME[store.launcher]]) : t("Spielseite bei {0} geöffnet", [STORE_NAME[store.launcher]]));
  };

  const failedNames = Object.keys(failed).filter((k) => k !== 'cheapshark').map((k) => STORE_NAME[k] || k);

  return (<>
    <header className="topbar">
      <div className="title-block">
        <h1>{t("Shop")}</h1>
        <label className="sort shop-sort">
          <select value={sort} onChange={(e) => changeSort(e.target.value)} aria-label={t("Sortieren")}>
            <option value="">{deals ? t("Größter Rabatt / beliebt") : q ? t("Relevanz") : t("Beliebt")}</option>
            <option value="price_asc">{t("Preis aufsteigend")}</option>
            <option value="price_desc">{t("Preis absteigend")}</option>
            <option value="new">{t("Neueste zuerst")}</option>
          </select>
        </label>
        {items.length > 0 && <span className="count">{countLabel(items.length, total, approx)}</span>}
      </div>
      <div className="search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input placeholder={store === 'all' ? t("Alle Stores durchsuchen") : t("{0} durchsuchen", [STORE_NAME[store]])} value={input} onChange={(e) => setInput(e.target.value)} autoFocus />
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
    <div className="shop-tabs" role="tablist" aria-label="Store">
      <button className={`shop-tab deals ${deals ? 'on' : ''}`} onClick={toggleDeals} aria-pressed={deals}
        title={deals ? t("Wieder alle Spiele zeigen") : t("Nur reduzierte Spiele zeigen")}>
        <svg viewBox="0 0 24 24"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg>
        <span>{t("Angebote")}</span>
      </button>
      <span className="shop-tab-sep" />
      <button className={`shop-tab ${store === 'all' ? 'on' : ''}`} onClick={() => changeStore('all')} title={t("Alle Stores")}>{t("Alle")}</button>
      {STORE_TABS.map((id) => (
        <button key={id} className={`shop-tab icon ${store === id ? 'on' : ''}`} onClick={() => changeStore(id)}
          title={STORE_NAME[id]} aria-label={STORE_NAME[id]}>
          <StoreLogo launcher={id} provider={providerById[id]} />
        </button>
      ))}
    </div>
    {failedNames.length > 0 && <div className="banner">{t("Gerade nicht erreichbar: {0}", [failedNames.join(', ')])}</div>}
    {error ? (
      <div className="empty">{error}</div>
    ) : items.length === 0 ? (
      <div className="empty">{loading ? <><div className="loader" />{t("Stores werden durchsucht …")}</> : `${deals ? t("Gerade keine Angebote") : t("Nichts gefunden")}${q ? t(" für „{0}“", [q]) : ''}${store !== 'all' ? t(" bei {0}", [STORE_NAME[store]]) : ''}.`}</div>
    ) : (
      <div className="shop-scroll">
        {view === 'list' ? (
          <section className="shop-list">
            {items.map((g) => <ShopRow key={g.key} game={g} owned={owned.get(g.key)} providerById={providerById} onOpen={open} />)}
          </section>
        ) : (
          <section className="shop-grid">
            {items.map((g) => <ShopCard key={g.key} game={g} owned={owned.get(g.key)} providerById={providerById} onOpen={open} />)}
          </section>
        )}
        <div ref={sentinel} className="shop-more">
          {loading ? <div className="loader" /> : more ? <button className="secondary small" onClick={() => load(q, page + 1, store, deals, sort)}>{t("Mehr laden")}</button> : null}
        </div>
        <p className="shop-credit">{t(
          "Spiele und Preise von Steam, Epic Games und GOG; EA, Ubisoft und Battle.net über den Preisvergleich CheapShark. Ludora ist mit keinem dieser Stores verbunden – gekauft wird immer direkt im jeweiligen Store."
        )}</p>
      </div>
    )}
  </>);
}
