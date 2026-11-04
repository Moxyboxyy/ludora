const test = require('node:test');
const assert = require('node:assert');
const shop = require('../electron/lib/shop');

const STEAM_HTML = `
<a href="https://store.steampowered.com/app/1091500/Cyberpunk_2077/" data-ds-appid="1091500" class="search_result_row">
  <img src="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/capsule_231x87.jpg">
  <span class="title">Cyberpunk 2077</span>
  <div class="discount_block search_discount_block" data-price-final="2999"><div class="discount_pct">-50%</div>
  <div class="discount_original_price">59,99€</div><div class="discount_final_price">29,99€</div></div>
</a>
<a href="https://store.steampowered.com/bundle/1/x/" data-ds-bundleid="1" data-ds-appid="1,2"><span class="title">Bundle</span></a>
<a href="https://store.steampowered.com/app/570/Dota_2/" data-ds-appid="570"><span class="title">Dota 2</span>
  <div class="discount_block" data-price-final="0"><div class="discount_final_price">Kostenlos spielbar</div></div></a>`;

const GOG = { products: [{ title: 'Cyberpunk 2077', slug: 'cyberpunk_2077', coverHorizontal: 'https://images.gog/x.jpg', storeLink: 'https://www.gog.com/de/game/cyberpunk_2077', price: { final: '29,99 €', base: '59,99 €', discount: '-50%', finalMoney: { amount: '29.99', currency: 'EUR' } } }] };
const EPIC = { data: { Catalog: { searchStore: { elements: [
  { title: 'Cyberpunk 2077', productSlug: 'cyberpunk-2077', offerMappings: [{ pageSlug: 'cyberpunk-2077', pageType: 'productHome' }], keyImages: [{ type: 'OfferImageWide', url: 'https://cdn1.epicgames.com/x.jpg' }], price: { totalPrice: { discountPrice: 2999, originalPrice: 5999, fmtPrice: { discountPrice: '29,99 €', originalPrice: '59,99 €' } } } },
  { title: 'Fortnite', productSlug: 'fortnite/home', keyImages: [], price: { totalPrice: { discountPrice: 0, originalPrice: 0, fmtPrice: { discountPrice: '0' } } } }
] } } } };
const CS_STORES = [{ storeID: '1', storeName: 'Steam', isActive: 1 }, { storeID: '8', storeName: 'Origin', isActive: 1 }, { storeID: '13', storeName: 'Uplay', isActive: 1 }, { storeID: '25', storeName: 'Epic Games Store', isActive: 1 }];
const CS_GAMES = [{ gameID: '10', external: 'Cyberpunk 2077' }];
const CS_IDS = { 10: { info: { title: 'Cyberpunk 2077', steamAppID: '1091500' }, deals: [{ storeID: '1', dealID: 'a' }, { storeID: '13', dealID: 'u%1' }, { storeID: '8', dealID: 'e1' }] } };

function mockFetch(calls) {
  return async (url, opts) => {
    calls.push(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('store.steampowered.com/search/results')) return ok({ results_html: STEAM_HTML });
    if (url.includes('catalog.gog.com')) return ok(GOG);
    if (url.includes('epicgames.com/graphql')) { assert.equal(opts.method, 'POST'); return ok(EPIC); }
    if (url.includes('cheapshark.com/api/1.0/stores')) return ok(CS_STORES);
    if (url.includes('cheapshark.com/api/1.0/games?ids=')) return ok(CS_IDS);
    if (url.includes('cheapshark.com/api/1.0/games?title=')) return ok(CS_GAMES);
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('Steam-Ergebnisse: nur Apps, Preise und Rabatt', () => {
  const r = shop._parseSteamResults(STEAM_HTML);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, 'Cyberpunk 2077');
  assert.equal(r[0].store.price, 29.99);
  assert.equal(r[0].store.discount, 50);
  assert.equal(r[0].store.uri, 'steam://store/1091500');
  assert.equal(r[1].store.price, 0);
});

test('Epic: Slug aus offerMappings bzw. productSlug ohne /home', () => {
  const r = shop._fromEpic(EPIC.data.Catalog.searchStore.elements);
  assert.equal(r[0].store.url, 'https://store.epicgames.com/de/p/cyberpunk-2077');
  assert.equal(r[1].store.url, 'https://store.epicgames.com/de/p/fortnite');
  assert.equal(r[1].store.priceText, 'Kostenlos');
});

test('Titel-Normalisierung verbindet Schreibweisen', () => {
  assert.equal(shop.normTitle('Cyberpunk 2077™ Standard Edition'), shop.normTitle('Cyberpunk 2077'));
  assert.equal(shop.normTitle('Tom Clancy’s Rainbow Six® Siege'), shop.normTitle("Tom Clancy's Rainbow Six Siege"));
});

test('Suche führt alle Stores zu einem Spiel zusammen', async () => {
  const calls = [];
  shop._setFetch(mockFetch(calls));
  const res = await shop.query({ q: 'cyberpunk' });
  assert.ok(res.ok);
  const cp = res.games.find((g) => g.key === 'cyberpunk 2077');
  assert.deepEqual(cp.stores.map((s) => s.launcher), ['steam', 'epic', 'gog', 'ea', 'ubisoft']);
  assert.equal(cp.minPrice, 29.99);
  assert.equal(res.games[0].key, 'cyberpunk 2077', 'exakter Treffer zuerst');
  // CheapShark-Link (zur Spielseite) korrekt kodiert
  assert.ok(cp.stores.find((s) => s.launcher === 'ubisoft').url.endsWith('dealID=u%251'));
});

test('Bestseller: feste Launcher-Spiele dabei, fällt eine Quelle aus, kommen die anderen', async () => {
  shop._setFetch(async (url, opts) => {
    if (url.includes('graphql')) throw new Error('blockiert');
    return mockFetch([])(url, opts);
  });
  const res = await shop.query({ q: '' });
  assert.ok(res.ok);
  assert.ok(res.errors.epic);
  assert.ok(res.games.some((g) => g.title === 'VALORANT' && g.stores[0].launcher === 'riot'));
  assert.ok(res.games.some((g) => g.title === 'Diablo IV' && g.stores[0].uri === 'battlenet://Fen'));
});

test('Zusätzliche Stores für angezeigte Titel', async () => {
  shop._setFetch(mockFetch([]));
  shop.setCacheFile(null);
  const res = await shop.more(['Cyberpunk 2077']);
  assert.deepEqual(res.stores['cyberpunk 2077'].map((s) => s.launcher).sort(), ['ea', 'ubisoft']);
});

test('Nur Store-Links werden geöffnet', () => {
  assert.ok(shop.isAllowedUrl('https://store.steampowered.com/app/1/'));
  assert.ok(shop.isAllowedUrl('https://www.cheapshark.com/redirect?dealID=x'));
  assert.ok(!shop.isAllowedUrl('https://evil.example/steampowered.com'));
  assert.ok(!shop.isAllowedUrl('http://store.steampowered.com/'));
  assert.ok(!shop.isAllowedUrl('file:///C:/x.exe'));
  assert.ok(shop.isAllowedUri('steam://store/570'));
  assert.ok(shop.isAllowedUri('com.epicgames.launcher://store/p/fortnite'));
  assert.ok(!shop.isAllowedUri('steam://run/570'));
  assert.ok(!shop.isAllowedUri('steam://store/570; calc'));
});

test('Einzelner Store: EA über CheapShark-Deals, Riot aus der festen Liste', async () => {
  const calls = [];
  shop._setFetch(async (url, opts) => {
    calls.push(url);
    if (url.includes('/deals?')) return { ok: true, status: 200, json: async () => [{ title: 'EA SPORTS FC 26', dealID: 'd1', storeID: '8', steamAppID: '3405690', isOnSale: '1', savings: '40.0' }] };
    return mockFetch([])(url, opts);
  });
  const ea = await shop.query({ store: 'ea' });
  assert.ok(ea.ok);
  assert.equal(ea.games.length, 1);
  assert.equal(ea.games[0].stores[0].launcher, 'ea');
  assert.equal(ea.games[0].stores[0].discount, 40);
  assert.ok(calls.some((u) => u.includes('storeID=8')));
  assert.ok(!calls.some((u) => u.includes('steampowered')), 'andere Stores werden nicht abgefragt');
  const riot = await shop.query({ store: 'riot' });
  assert.ok(riot.games.every((g) => g.stores[0].launcher === 'riot'));
  assert.ok(riot.games.length >= 4);
});

test('Angebote: Rabatt-Filter an alle Stores weitergeben, nur reduzierte Spiele', async () => {
  const calls = [];
  const posts = [];
  shop._setFetch(async (url, opts) => {
    if (opts?.body) posts.push(JSON.parse(opts.body));
    return mockFetch(calls)(url, opts);
  });
  const res = await shop.query({ deals: true });
  assert.ok(calls.some((u) => u.includes('steampowered') && u.includes('specials=1')));
  assert.ok(calls.some((u) => u.includes('catalog.gog.com') && u.includes('discounted=eq%3Atrue')));
  assert.equal(posts[0].variables.onSale, true);
  assert.ok(res.games.length > 0);
  assert.ok(res.games.every((g) => g.stores.some((s) => s.discount > 0 || s.onSale)));
  assert.ok(!res.games.some((g) => g.title === 'VALORANT'));
});

test('Weiterladen richtet sich nach der Gesamtzahl des Stores (Bundles zählen nicht)', async () => {
  shop._setFetch(async (url, opts) => {
    if (url.includes('steampowered')) return { ok: true, status: 200, json: async () => ({ results_html: STEAM_HTML, total_count: 4321 }) };
    return mockFetch([])(url, opts);
  });
  const res = await shop.query({ store: 'steam', deals: true });
  assert.equal(res.more, true, 'nur 1 Spiel auf der Seite, aber 4321 insgesamt');
  assert.equal(res.total, 4321);
  const last = await shop.query({ store: 'steam', deals: true, page: 86 });
  assert.equal(last.more, false);
});

test('Angebote in allen Stores: Steam ohne Bestseller-Filter, EA/Ubisoft/Battle.net dabei', async () => {
  const calls = [];
  shop._setFetch(async (url, opts) => {
    calls.push(url);
    if (url.includes('/deals?')) return { ok: true, status: 200, json: async () => [{ title: 'Far Cry 6', dealID: 'u1', storeID: '13', isOnSale: '1', savings: '70' }] };
    return mockFetch([])(url, opts);
  });
  const res = await shop.query({ deals: true, sort: 'price_asc' });
  const steamUrl = calls.find((u) => u.includes('steampowered'));
  assert.ok(!steamUrl.includes('topsellers'));
  assert.ok(steamUrl.includes('sort_by=Price_ASC'));
  assert.ok(calls.some((u) => u.includes('/deals?') && u.includes('storeID=13')));
  assert.ok(res.games.some((g) => g.title === 'Far Cry 6' && g.stores.some((s) => s.launcher === 'ubisoft')));
});

test('Steam-Angebote: Rabatt aus data-discount, und reduzierte Spiele gehen nie verloren', async () => {
  const html = `<a href="https://store.steampowered.com/app/10/X/" data-ds-appid="10"><span class="title">Neues Markup</span>
    <div class="discount_block search_discount_block" data-price-final="999" data-bundlediscount="0" data-discount="75">
    <div class="discount_prices"><div class="discount_original_price">39,99€</div><div class="discount_final_price">9,99€</div></div></div></a>
    <a href="https://store.steampowered.com/app/11/Y/" data-ds-appid="11"><span class="title">Ganz anderes Markup</span><span class="preis">4,99€</span></a>`;
  const r = shop._parseSteamResults(html);
  assert.equal(r[0].store.discount, 75);
  assert.equal(r[0].store.price, 9.99);
  shop._setFetch(async (url, opts) => {
    if (url.includes('steampowered')) return { ok: true, status: 200, json: async () => ({ results_html: html, total_count: 2 }) };
    return mockFetch([])(url, opts);
  });
  const res = await shop.query({ store: 'steam', deals: true });
  assert.deepEqual(res.games.map((g) => g.title).sort(), ['Ganz anderes Markup', 'Neues Markup']);
});

test('CheapShark: nach 429 eine Minute Pause, verständliche Meldung, Epic lädt in 40er-Seiten weiter', async () => {
  let csCalls = 0;
  const posts = [];
  shop._setFetch(async (url, opts) => {
    if (url.includes('cheapshark')) { csCalls++; return { ok: false, status: 429, json: async () => ({}) }; }
    if (opts?.body) posts.push(JSON.parse(opts.body));
    if (url.includes('graphql')) {
      const els = Array.from({ length: 40 }, (_, i) => ({ title: `Spiel ${i}`, productSlug: `spiel-${i}`, keyImages: [] }));
      return { ok: true, status: 200, json: async () => ({ data: { Catalog: { searchStore: { elements: els, paging: { count: 40, total: 500 } } } } }) };
    }
    return mockFetch([])(url, opts);
  });
  const ubi = await shop.query({ store: 'ubisoft', deals: true, q: 'x429' });
  assert.equal(ubi.ok, false);
  assert.match(ubi.error, /gesperrt/);
  const before = csCalls;
  await shop.query({ store: 'ea', deals: true, q: 'x429' });
  assert.equal(csCalls, before, 'während der Pause keine weiteren Anfragen');
  const ep = await shop.query({ store: 'epic', q: 'spiel' });
  assert.equal(posts.at(-1).variables.count, 40);
  assert.equal(ep.more, true);
});
