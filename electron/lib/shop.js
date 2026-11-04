// Ludora-Shop: Spiele aus allen Stores suchen/stöbern und pro Spiel zeigen, in welchen
// Launchern man es kaufen kann (mit direktem Link auf die Spielseite).
//
// Quellen (alle öffentlich, ohne Anmeldung):
//   Steam  -> store.steampowered.com/search/results (Bestseller + Suche, mit Preisen)
//   GOG    -> catalog.gog.com/v1/catalog
//   Epic   -> Epic-Store-GraphQL (searchStore)
//   EA / Ubisoft / Battle.net -> CheapShark (Preisvergleich, kennt diese Stores; Link führt zur Spielseite)
//   Riot / Battle.net / Rockstar -> kleine feste Liste mit den eigenen Spielen der Launcher
// Fällt eine Quelle aus, zeigen wir die übrigen.
const { t } = require('./i18n.js');
const fs = require('fs');

let fetchImpl = null;
function doFetch(url, opts) {
  if (fetchImpl) return fetchImpl(url, opts);
  try {
    const { net } = require('electron');
    if (net?.fetch) return net.fetch(url, opts); // Chromium-Netzwerk (System-Proxy, Zertifikate)
  } catch { /* außerhalb von Electron */ }
  return fetch(url, opts);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// CheapShark erlaubt nur wenige Anfragen pro Sekunde (sonst 429 "Too Many Requests"):
// alle Anfragen dorthin nacheinander, mit Abstand, und nach einem 429 eine Minute Pause.
const CS_GAP = 800;
let csChain = Promise.resolve();
let csLast = 0;
let csBlockedUntil = 0;
const wait = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
class RateLimited extends Error {}
function blockedText() {
  const min = Math.max(1, Math.ceil((csBlockedUntil - Date.now()) / 60000));
  return t(
    "Der Preisvergleich (CheapShark) hat Ludora wegen zu vieler Anfragen kurz gesperrt – noch etwa {0} Min.",
    [min]
  );
}
function throttled(url, fn) {
  if (!/cheapshark\.com/.test(url)) return fn();
  const run = csChain.then(async () => {
    loadTitleCache(); // enthält auch eine noch laufende Sperre vom letzten Start
    if (Date.now() < csBlockedUntil) throw new RateLimited(blockedText());
    const gap = csLast + (fetchImpl ? 0 : CS_GAP) - Date.now();
    if (gap > 0) await wait(gap);
    csLast = Date.now();
    return fn();
  });
  csChain = run.catch(() => {});
  return run;
}

async function getJson(url, opts = {}) {
  return throttled(url, () => getJsonNow(url, opts));
}
async function getJsonNow(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 12000);
  try {
    const r = await doFetch(url, { ...opts, signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'application/json', ...(opts.headers || {}) } });
    if (r.status === 429 && /cheapshark\.com/.test(url)) {
      // So lange warten, wie CheapShark sagt (Retry-After), mindestens 2 Minuten; über Neustarts hinweg merken
      const ra = Number(r.headers?.get?.('retry-after'));
      csBlockedUntil = Date.now() + Math.max(120, Number.isFinite(ra) ? ra : 0) * 1000;
      console.log(`[shop] CheapShark sperrt Anfragen bis ${new Date(csBlockedUntil).toLocaleTimeString('de-DE')} (Retry-After: ${r.headers?.get?.('retry-after') ?? '–'})`);
      const c = loadTitleCache();
      c.__blockedUntil = csBlockedUntil;
      saveTitleCache();
      throw new RateLimited(blockedText());
    }
    if (!r.ok) throw new Error(t("{0} antwortet mit {1}", [new URL(url).hostname, r.status]));
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Hilfen ----------
/** Liste mit Seiten-Infos: gibt es mehr, und wie viele insgesamt (falls der Store das sagt) */
function withMeta(list, more, total) {
  list.more = !!more;
  if (Number.isFinite(total)) list.total = total;
  return list;
}

const EDITION = /\b(standard|base) edition\b/g;
function normTitle(t) {
  return String(t || '')
    .replace(/[\u2122\u00ae\u00a9]/g, '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(EDITION, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "19,99€" / "19.99 €" / "Kostenlos" -> Zahl (Euro) oder null */
function parsePrice(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/kostenlos|free|gratis/i.test(s)) return 0;
  const m = s.replace(/\s/g, '').match(/(\d{1,3}(?:[.,]\d{3})*|\d+)(?:[.,](\d{2}))?/);
  if (!m) return null;
  return Number(m[1].replace(/[.,]/g, '')) + (m[2] ? Number(m[2]) / 100 : 0);
}

const decode = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#039;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();

// ---------- Steam ----------
/** Ergebnis-HTML der Steam-Suche -> Spiele (nur einzelne Apps, keine Bundles/Pakete) */
function parseSteamResults(html) {
  const out = [];
  for (const block of String(html || '').split(/<a\s+href="/).slice(1)) {
    const head = block.slice(0, block.indexOf('>'));
    if (/data-ds-(bundleid|packageid)=/.test(head)) continue;
    const id = (head.match(/data-ds-appid="(\d+)"/) || [])[1];
    if (!id) continue;
    const title = decode((block.match(/<span class="title">([\s\S]*?)<\/span>/) || [])[1]);
    if (!title) continue;
    const img = (block.match(/<img[^>]+src="([^"]+)"/) || [])[1] || null;
    const finalTxt = (block.match(/class="discount_final_price[^"]*">([^<]*)</) || [])[1] || '';
    const origTxt = (block.match(/class="discount_original_price">([^<]*)</) || [])[1];
    // Rabatt: neues Steam-HTML hat data-discount="50", älteres <div class="discount_pct">-50%</div>
    const pct = (block.match(/data-discount="(\d+)"/) || [])[1]
      || (block.match(/class="[^"]*discount_pct[^"]*"[^>]*>\s*-?(\d+)\s*%/) || [])[1];
    const cents = (block.match(/data-price-final="(\d+)"/) || [])[1];
    const price = cents != null ? Number(cents) / 100 : parsePrice(finalTxt);
    out.push({
      title,
      image: `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`,
      imageFallback: img,
      store: {
        launcher: 'steam',
        url: `https://store.steampowered.com/app/${id}/`,
        uri: `steam://store/${id}`,
        price: Number.isFinite(price) ? price : null,
        priceText: decode(finalTxt) || null,
        oldPriceText: origTxt ? decode(origTxt) : null,
        discount: pct ? Number(pct) : 0
      }
    });
  }
  return out;
}

async function steam({ q, page, deals, sort }) {
  const p = new URLSearchParams({
    term: q || '', start: String(page * PAGE), count: String(PAGE), infinite: '1',
    cc: 'DE', l: 'german', category1: '998' // 998 = nur Spiele
  });
  const STEAM_SORT = { price_asc: 'Price_ASC', price_desc: 'Price_DESC', new: 'Released_DESC' };
  if (STEAM_SORT[sort]) p.set('sort_by', STEAM_SORT[sort]);
  // Ohne Suche: Bestseller. Bei Angeboten ALLE reduzierten Spiele (nicht nur Bestseller)
  else if (!q && !deals) p.set('filter', 'topsellers');
  if (deals) p.set('specials', '1');
  const j = await getJson(`https://store.steampowered.com/search/results/?${p}`);
  const list = parseSteamResults(j.results_html);
  if (deals) for (const it of list) it.store.onSale = true; // Steam hat nur reduzierte Spiele geliefert
  // Steam zählt auch Bundles/Pakete mit, die wir weglassen -> nach der Gesamtzahl gehen, nicht nach der Länge
  const total = Number(j.total_count);
  const more = Number.isFinite(total) ? (page + 1) * PAGE < total : /data-ds-appid|data-ds-bundleid|data-ds-packageid/.test(j.results_html || '');
  return withMeta(list, more, total);
}

// ---------- GOG ----------
function fromGog(products) {
  return (products || []).filter((x) => x && x.title && x.slug).map((x) => {
    const amount = x.price?.finalMoney?.amount != null ? Number(x.price.finalMoney.amount) : parsePrice(x.price?.final);
    return {
      title: x.title,
      image: x.coverHorizontal || null,
      store: {
        launcher: 'gog',
        url: x.storeLink || `https://www.gog.com/de/game/${x.slug}`,
        uri: null,
        price: Number.isFinite(amount) ? amount : null,
        priceText: x.price?.final || null,
        oldPriceText: x.price?.discount ? x.price?.base : null,
        discount: Math.abs(parseInt(x.price?.discount, 10)) || 0
      }
    };
  });
}

async function gog({ q, page, deals, sort }) {
  const p = new URLSearchParams({
    limit: String(GOG_PAGE), page: String(page + 1), order: { price_asc: 'asc:price', price_desc: 'desc:price', new: 'desc:releaseDate' }[sort] || (q ? 'desc:score' : deals ? 'desc:discount' : 'desc:trending'),
    productType: 'in:game,pack', countryCode: 'DE', locale: 'de-DE', currencyCode: 'EUR'
  });
  if (q) p.set('query', `like:${q}`);
  if (deals) p.set('discounted', 'eq:true');
  const j = await getJson(`https://catalog.gog.com/v1/catalog?${p}`);
  const pages = Number(j.pages);
  const gl = fromGog(j.products);
  if (deals) for (const it of gl) it.store.onSale = true;
  return withMeta(gl, Number.isFinite(pages) ? page + 1 < pages : (j.products || []).length >= GOG_PAGE, Number(j.productCount));
}

// ---------- Epic ----------
const EPIC_QUERY = `query searchStoreQuery($keywords: String, $count: Int, $start: Int, $country: String!, $locale: String, $sortBy: String, $sortDir: String, $category: String, $onSale: Boolean) {
  Catalog { searchStore(keywords: $keywords, count: $count, start: $start, country: $country, locale: $locale, sortBy: $sortBy, sortDir: $sortDir, category: $category, onSale: $onSale) {
    elements { title id namespace productSlug urlSlug
      keyImages { type url }
      catalogNs { mappings(pageType: "productHome") { pageSlug pageType } }
      offerMappings { pageSlug pageType }
      price(country: $country) { totalPrice { discountPrice originalPrice fmtPrice(locale: $locale) { discountPrice originalPrice } } }
    } } } }`;

function epicSlug(e) {
  return e.offerMappings?.find((m) => m.pageSlug)?.pageSlug
    || e.catalogNs?.mappings?.find((m) => m.pageSlug)?.pageSlug
    || (e.productSlug ? String(e.productSlug).replace(/\/home$/, '') : null)
    || (e.urlSlug && !/^[0-9a-f]{32}$/.test(e.urlSlug) ? e.urlSlug : null);
}

function fromEpic(elements) {
  return (elements || []).map((e) => {
    const slug = epicSlug(e);
    if (!slug || !e.title) return null;
    const imgs = e.keyImages || [];
    const img = ['OfferImageWide', 'DieselStoreFrontWide', 'featuredMedia', 'Thumbnail'].map((t) => imgs.find((i) => i.type === t)).find(Boolean);
    const tp = e.price?.totalPrice;
    const cents = tp?.discountPrice;
    return {
      title: e.title,
      image: img?.url || null,
      store: {
        launcher: 'epic',
        url: `https://store.epicgames.com/de/p/${slug}`,
        uri: `com.epicgames.launcher://store/p/${slug}`,
        price: Number.isFinite(cents) ? cents / 100 : null,
        priceText: cents === 0 ? t("Kostenlos") : tp?.fmtPrice?.discountPrice || null,
        oldPriceText: tp && tp.originalPrice > tp.discountPrice ? tp.fmtPrice?.originalPrice : null,
        discount: tp && tp.originalPrice > 0 ? Math.round((1 - tp.discountPrice / tp.originalPrice) * 100) : 0
      }
    };
  }).filter(Boolean);
}

async function epic({ q, page, deals, sort }) {
  const variables = {
    keywords: q || '', count: EPIC_PAGE, start: page * EPIC_PAGE, country: 'DE', locale: 'de',
    category: 'games/edition/base', sortBy: q ? 'relevancy' : 'releaseDate', sortDir: 'DESC'
  };
  if (sort === 'price_asc' || sort === 'price_desc') { variables.sortBy = 'currentPrice'; variables.sortDir = sort === 'price_asc' ? 'ASC' : 'DESC'; }
  else if (sort === 'new') { variables.sortBy = 'releaseDate'; variables.sortDir = 'DESC'; }
  if (deals) variables.onSale = true;
  let lastErr;
  for (const endpoint of ['https://store.epicgames.com/graphql', 'https://graphql.epicgames.com/graphql']) {
    try {
      const j = await getJson(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://store.epicgames.com' },
        body: JSON.stringify({ query: EPIC_QUERY, variables })
      });
      const ss = j?.data?.Catalog?.searchStore;
      const els = ss?.elements;
      if (Array.isArray(els)) {
        const total = Number(ss.paging?.total);
        const el = fromEpic(els);
        if (deals) for (const it of el) it.store.onSale = true;
        return withMeta(el, Number.isFinite(total) ? (page + 1) * EPIC_PAGE < total : els.length >= EPIC_PAGE, total);
      }
      lastErr = new Error('Epic: unerwartete Antwort');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------- CheapShark (EA, Ubisoft, Battle.net, …) ----------
let csStores = null;
function launcherForStoreName(name) {
  const n = String(name || '').toLowerCase();
  if (/origin|ea app|\bea\b/.test(n)) return 'ea';
  if (/uplay|ubisoft/.test(n)) return 'ubisoft';
  if (/blizzard|battle\.net/.test(n)) return 'battlenet';
  if (/epic/.test(n)) return 'epic';
  if (/^gog/.test(n)) return 'gog';
  if (/^steam$/.test(n)) return 'steam';
  return null;
}
async function cheapStores() {
  if (csStores) return csStores;
  const list = await getJson('https://www.cheapshark.com/api/1.0/stores');
  csStores = new Map();
  for (const s of list || []) {
    const l = launcherForStoreName(s.storeName);
    if (l && s.isActive !== 0) csStores.set(String(s.storeID), l);
  }
  return csStores;
}

/** CheapShark-Spiele (mit Deals) -> Einträge; nur Stores, für die wir keine eigene Quelle haben */
const CS_ONLY = new Set(['ea', 'ubisoft', 'battlenet']);
function fromCheapShark(byId, stores) {
  const out = [];
  for (const g of Object.values(byId || {})) {
    const title = g?.info?.title;
    if (!title) continue;
    const appid = g.info.steamAppID;
    for (const d of g.deals || []) {
      const l = stores.get(String(d.storeID));
      if (!l || !CS_ONLY.has(l)) continue;
      out.push({
        title,
        image: appid ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg` : g.info.thumb || null,
        store: {
          launcher: l,
          // CheapShark leitet direkt auf die Spielseite im jeweiligen Store weiter
          url: `https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(d.dealID)}`,
          uri: null, price: null, priceText: null, oldPriceText: null, discount: 0
        }
      });
    }
  }
  return out;
}

async function cheapsharkByIds(ids) {
  if (!ids.length) return [];
  const stores = await cheapStores();
  const out = [];
  for (let i = 0; i < ids.length; i += 25) {
    const j = await getJson(`https://www.cheapshark.com/api/1.0/games?ids=${ids.slice(i, i + 25).join(',')}`);
    out.push(...fromCheapShark(j, stores));
  }
  return out;
}

async function cheapshark({ q, page }) {
  if (!q || page > 0) return [];
  const list = await getJson(`https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(q)}&limit=30`);
  return cheapsharkByIds((list || []).map((x) => x.gameID).filter(Boolean));
}

// Bestseller-Seiten: EA/Ubisoft/Battle.net-Verfügbarkeit pro Titel nachschlagen (mit Cache)
let cacheFile = null;
let titleCache = null; // normTitle -> { t: Zeit, ids: [gameID] }
const TITLE_TTL = 7 * 24 * 3600 * 1000;
function loadTitleCache() {
  if (titleCache) return titleCache;
  titleCache = {};
  try { if (cacheFile) titleCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch { titleCache = {}; }
  if (Number(titleCache.__blockedUntil) > csBlockedUntil) csBlockedUntil = Number(titleCache.__blockedUntil);
  return titleCache;
}
let saveTimer = null;
function saveTitleCache() {
  if (!cacheFile) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(cacheFile, JSON.stringify(titleCache)); } catch { /* egal */ } }, 1000);
  saveTimer.unref?.();
}

let enrichGen = 0;
async function enrich(titles) {
  const cache = loadTitleCache();
  const now = Date.now();
  const ids = [];
  const todo = [];
  for (const t of titles) {
    const k = normTitle(t);
    const c = cache[k];
    if (c && now - c.t < TITLE_TTL) ids.push(...c.ids);
    else todo.push([k, t]);
  }
  // behutsam: eine Anfrage nach der anderen (siehe throttled), höchstens 20 neue Titel pro Aufruf,
  // abbrechen, wenn schon neuere Spiele angezeigt werden oder CheapShark bremst
  const my = ++enrichGen;
  for (const [k, t] of todo.slice(0, 8)) {
    if (my !== enrichGen) break;
    try {
      const list = await getJson(`https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(t)}&exact=1&limit=3`);
      const found = (list || []).filter((x) => normTitle(x.external) === k).map((x) => x.gameID);
      cache[k] = { t: now, ids: found };
      ids.push(...found);
    } catch {
      break;
    }
  }
  saveTitleCache();
  return cheapsharkByIds([...new Set(ids)]);
}

// ---------- Feste Liste: eigene Spiele der Launcher ----------
const BN = (title, code, url) => ({ title, image: null, store: { launcher: 'battlenet', url, uri: `battlenet://${code}`, price: null, priceText: null, oldPriceText: null, discount: 0 } });
const RIOT = (title, url) => ({ title, image: null, store: { launcher: 'riot', url, uri: null, price: 0, priceText: t("Kostenlos"), oldPriceText: null, discount: 0 } });
const R = (title, url) => ({ title, image: null, store: { launcher: 'rockstar', url, uri: null, price: null, priceText: null, oldPriceText: null, discount: 0 } });
const STATIC = [
  BN('World of Warcraft', 'WoW', 'https://worldofwarcraft.blizzard.com/de-de/'),
  BN('Diablo IV', 'Fen', 'https://diablo4.blizzard.com/de-de/'),
  BN('Overwatch 2', 'Pro', 'https://overwatch.blizzard.com/de-de/'),
  BN('Hearthstone', 'WTCG', 'https://hearthstone.blizzard.com/de-de/'),
  BN('Diablo II: Resurrected', 'OSI', 'https://diablo2.blizzard.com/de-de/'),
  BN('Diablo III', 'D3', 'https://eu.diablo3.blizzard.com/de-de/'),
  BN('StarCraft II', 'S2', 'https://starcraft2.blizzard.com/de-de/'),
  BN('Heroes of the Storm', 'Hero', 'https://heroesofthestorm.blizzard.com/de-de/'),
  BN('Warcraft III: Reforged', 'W3', 'https://playwarcraft3.com/de-de/'),
  RIOT('League of Legends', 'https://www.leagueoflegends.com/de-de/'),
  RIOT('VALORANT', 'https://playvalorant.com/de-de/'),
  RIOT('Teamfight Tactics', 'https://teamfighttactics.leagueoflegends.com/de-de/'),
  RIOT('Legends of Runeterra', 'https://playruneterra.com/de-de/'),
  R('Grand Theft Auto V', 'https://www.rockstargames.com/de/gta-v'),
  R('Red Dead Redemption 2', 'https://www.rockstargames.com/de/reddeadredemption2')
];
function staticMatches(q) {
  if (!q) return STATIC;
  const n = normTitle(q);
  return STATIC.filter((s) => normTitle(s.title).includes(n));
}

// ---------- Zusammenführen ----------
const PAGE = 50;     // Steam, Epic, CheapShark pro Seite
const GOG_PAGE = 48; // GOG erlaubt höchstens 48
const EPIC_PAGE = 40; // Epic liefert höchstens 40
const ORDER = ['steam', 'epic', 'gog', 'ea', 'ubisoft', 'battlenet', 'riot', 'rockstar'];

/**
 * Listen der einzelnen Quellen -> ein Spiel pro Titel mit allen Stores.
 * Reihenfolge: abwechselnd aus den Quellen (beste Plätze zuerst), bei Suche exakte Treffer vorn.
 */
function merge(lists, q) {
  const byKey = new Map();
  const nq = normTitle(q);
  lists.forEach((list) => list.forEach((item, rank) => {
    const k = normTitle(item.title);
    if (!k) return;
    let g = byKey.get(k);
    if (!g) {
      g = { key: k, title: item.title, image: null, imageFallback: null, stores: {}, rank: Infinity };
      byKey.set(k, g);
    }
    g.rank = Math.min(g.rank, rank);
    // Bild: Steam bevorzugt (einheitliches Format), sonst das erste vorhandene
    if (item.image && (!g.image || item.store.launcher === 'steam')) { g.image = item.image; g.imageFallback = item.imageFallback || null; }
    if (item.store.launcher === 'steam') g.title = item.title;
    if (!g.stores[item.store.launcher]) g.stores[item.store.launcher] = item.store;
  }));
  const games = [...byKey.values()].map((g) => {
    const prices = Object.values(g.stores).map((s) => s.price).filter((p) => Number.isFinite(p));
    const order = Object.keys(g.stores).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    return { ...g, stores: order.map((l) => g.stores[l]), minPrice: prices.length ? Math.min(...prices) : null };
  });
  const score = (g) => (nq && g.key === nq ? -1000 : nq && g.key.startsWith(nq) ? -500 : 0) + g.rank;
  return games.sort((a, b) => score(a) - score(b) || b.stores.length - a.stores.length);
}

// ---------- Öffentliche Funktionen ----------
const resultCache = new Map(); // "q|page" -> { t, value }
const SOURCES = { steam, epic, gog, cheapshark };

// Spiele eines einzelnen Stores, der nur über CheapShark erreichbar ist (EA, Ubisoft, Battle.net)
async function cheapsharkStore(launcher, { q, page, deals, sort }) {
  const stores = await cheapStores();
  const ids = [...stores].filter(([, l]) => l === launcher).map(([id]) => id);
  if (!ids.length) return [];
  const p = new URLSearchParams({ storeID: ids.join(','), pageNumber: String(page), pageSize: String(PAGE), sortBy: { price_asc: 'Price', price_desc: 'Price', new: 'Release' }[sort] || (q ? 'Title' : deals ? 'Savings' : 'Deal Rating') });
  if (sort === 'price_desc' || sort === 'new' || (!sort && deals && !q)) p.set('desc', sort === 'price_desc' || sort === 'new' ? '1' : '0');
  if (q) p.set('title', q);
  if (deals) p.set('onSale', '1');
  const list = await getJson(`https://www.cheapshark.com/api/1.0/deals?${p}`);
  return withMeta((list || []).filter((d) => d && d.title && d.dealID).map((d) => ({
    title: d.title,
    image: d.steamAppID ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${d.steamAppID}/header.jpg` : d.thumb || null,
    imageFallback: d.thumb || null,
    store: {
      launcher,
      url: `https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(d.dealID)}`,
      uri: null, price: null, priceText: null, oldPriceText: null,
      discount: d.isOnSale === '1' || d.isOnSale === 1 ? Math.round(Number(d.savings) || 0) : 0,
      onSale: !!deals
    }
  })), (list || []).length >= PAGE);
}

const STORE_IDS = ['steam', 'epic', 'gog', 'ea', 'ubisoft', 'battlenet', 'riot', 'rockstar'];

/**
 * Shop abfragen. store = null -> alle Stores; sonst nur dieser eine Store
 * (für Steam/Epic/GOG direkt, EA/Ubisoft/Battle.net über CheapShark, Riot/Rockstar aus der festen Liste).
 */
async function query({ q = '', page = 0, store = null, deals = false, sort = '' } = {}) {
  q = String(q || '').trim().slice(0, 100);
  page = Math.max(0, Math.min(1000, Number(page) || 0));
  store = STORE_IDS.includes(store) ? store : null;
  deals = !!deals;
  sort = ['price_asc', 'price_desc', 'new'].includes(sort) ? sort : '';
  const key = `${store || 'all'}|${deals ? 'deals' : ''}|${sort}|${q.toLowerCase()}|${page}`;
  const hit = resultCache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.value;

  let sources;
  if (!store && deals) {
    // Angebote aus ALLEN Stores: auch EA, Ubisoft und Battle.net (über CheapShark)
    sources = { steam, epic, gog };
    for (const l of ['ea', 'ubisoft', 'battlenet']) sources[l] = (o) => cheapsharkStore(l, o);
  } else if (!store) sources = SOURCES;
  else if (SOURCES[store]) sources = { [store]: SOURCES[store] };
  else if (['ea', 'ubisoft', 'battlenet'].includes(store)) sources = { [store]: (o) => cheapsharkStore(store, o) };
  else sources = {};

  const names = Object.keys(sources);
  const settled = await Promise.allSettled(names.map((n) => sources[n]({ q, page, deals, sort })));
  const lists = [];
  const errors = {};
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') lists.push(r.value);
    else errors[names[i]] = String(r.reason?.message || r.reason);
  });
  // Für die Fehlersuche im cmd-Fenster: was hat jeder Store geliefert?
  console.log(`[shop] ${store || 'alle'}${deals ? ' Angebote' : ''}${q ? ` "${q}"` : ''} Seite ${page}: ` + names.map((n, i) => {
    const r = settled[i];
    return r.status === 'fulfilled' ? `${n} ${r.value.length}${Number.isFinite(r.value.total) ? `/${r.value.total}` : ''}` : `${n} FEHLER (${errors[n]})`;
  }).join(', '));
  if (page === 0 && !deals) {
    const st = staticMatches(q).filter((x) => !store || x.store.launcher === store);
    if (st.length) lists.push(st);
  }
  const needed = store ? names : ['steam', 'epic', 'gog'];
  if (needed.length && needed.every((n) => errors[n]) && !lists.some((l) => l.length)) {
    const limited = settled.find((r) => r.status === 'rejected' && r.reason instanceof RateLimited);
    return { ok: false, error: limited ? limited.reason.message : store ? t("Dieser Store ist gerade nicht erreichbar. Bist du online?") : t("Die Stores sind gerade nicht erreichbar. Bist du online?"), errors, games: [], more: false };
  }
  let games = merge(lists, q);
  // Angebote: nur Spiele, die in mindestens einem Store reduziert sind; größter Rabatt zuerst
  if (deals) {
    const best = (g) => Math.max(0, ...g.stores.map((x) => x.discount || 0));
    games = games.filter((g) => best(g) > 0 || g.stores.some((x) => x.onSale));
    if (!q && !sort) games.sort((a, b) => best(b) - best(a));
  }
  const more = lists.some((l) => (l.more !== undefined ? l.more : false));
  const totals = lists.map((l) => l.total).filter((t) => Number.isFinite(t) && t > 0);
  if (sort === 'price_asc' || sort === 'price_desc') {
    const dir = sort === 'price_asc' ? 1 : -1;
    games.sort((a, b) => (a.minPrice == null) - (b.minPrice == null) || dir * ((a.minPrice ?? 0) - (b.minPrice ?? 0)));
  }
  // Gesamtzahl: Summe der Stores, die eine nennen (Spiele in mehreren Stores zählen dann doppelt -> "ca.")
  const total = totals.length ? totals.reduce((a, b) => a + b, 0) : null;
  const value = { ok: true, games, errors, more, total, approx: !store && totals.length > 1 };
  if (!Object.keys(errors).length) resultCache.set(key, { t: Date.now(), value }); // unvollständige Ergebnisse nicht merken
  return value;
}

/** Zusätzliche Stores (EA, Ubisoft, Battle.net) für bereits angezeigte Spiele nachladen */
async function more(titles) {
  try {
    const items = await enrich((titles || []).slice(0, 60).map(String));
    const byKey = {};
    for (const it of items) {
      const k = normTitle(it.title);
      (byKey[k] ||= []);
      if (!byKey[k].some((s) => s.launcher === it.store.launcher)) byKey[k].push(it.store);
    }
    return { ok: true, stores: byKey };
  } catch (err) {
    return { ok: false, error: String(err.message || err), stores: {} };
  }
}

/** Ist das ein Link, den wir öffnen dürfen? (nur Store-Seiten, keine beliebigen Adressen) */
const ALLOWED_HOSTS = /(^|\.)(steampowered\.com|gog\.com|epicgames\.com|ea\.com|ubisoft\.com|ubi\.com|blizzard\.com|battle\.net|playwarcraft3\.com|leagueoflegends\.com|playvalorant\.com|playruneterra\.com|riotgames\.com|rockstargames\.com|cheapshark\.com)$/i;
const ALLOWED_URI = /^(steam:\/\/store\/\d+|com\.epicgames\.launcher:\/\/store\/p\/[\w-]+|battlenet:\/\/\w+)$/;
function isAllowedUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && ALLOWED_HOSTS.test(x.hostname); } catch { return false; }
}
const isAllowedUri = (u) => ALLOWED_URI.test(String(u || ''));

module.exports = {
  query, more, normTitle, isAllowedUrl, isAllowedUri,
  setCacheFile(f) { cacheFile = f; titleCache = null; },
  _parseSteamResults: parseSteamResults, _fromGog: fromGog, _fromEpic: fromEpic, _fromCheapShark: fromCheapShark,
  _merge: merge, _parsePrice: parsePrice, _launcherForStoreName: launcherForStoreName,
  _setFetch(f) { fetchImpl = f; resultCache.clear(); csStores = null; csBlockedUntil = 0; titleCache = null; }
};
