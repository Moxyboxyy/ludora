//! Shop: Spiele in allen Stores suchen und Preise vergleichen (Steam, Epic, GOG direkt;
//! Ubisoft/Battle.net über CheapShark, EA über den Steam-Store).

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use unicode_normalization::UnicodeNormalization;

use crate::friends::now;
use crate::util::{t, t_args};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CS_GAP: i64 = 800;
const PAGE: i64 = 50;
const GOG_PAGE: i64 = 48;
const EPIC_PAGE: i64 = 40;
const TITLE_TTL: i64 = 7 * 24 * 3600 * 1000;
const ORDER: [&str; 8] = ["steam", "epic", "gog", "ea", "ubisoft", "battlenet", "riot", "rockstar"];

#[derive(Debug)]
struct RateLimited(String);
impl std::fmt::Display for RateLimited {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for RateLimited {}

struct Cs {
    last: i64,
    blocked_until: i64,
    stores: Option<HashMap<String, String>>,
}
static CS: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
static CS_STATE: Lazy<Mutex<Cs>> = Lazy::new(|| Mutex::new(Cs { last: 0, blocked_until: 0, stores: None }));
static TITLE_CACHE: Lazy<Mutex<Option<Map<String, Value>>>> = Lazy::new(|| Mutex::new(None));
static RESULT_CACHE: Lazy<Mutex<HashMap<String, (i64, Value)>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static ENRICH_GEN: Lazy<Mutex<u64>> = Lazy::new(|| Mutex::new(0));

fn cache_file() -> PathBuf {
    crate::paths::data_dir().join("shop-cache.json")
}

fn with_title_cache<R>(f: impl FnOnce(&mut Map<String, Value>) -> R) -> R {
    let mut g = TITLE_CACHE.lock();
    if g.is_none() {
        let c = std::fs::read_to_string(cache_file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default();
        if let Some(b) = c.get("__blockedUntil").and_then(|v| v.as_i64()) {
            let mut cs = CS_STATE.lock();
            cs.blocked_until = cs.blocked_until.max(b);
        }
        *g = Some(c);
    }
    f(g.as_mut().unwrap())
}

fn save_title_cache() {
    let data = TITLE_CACHE.lock().clone();
    if let Some(d) = data {
        let _ = std::fs::write(cache_file(), Value::Object(d).to_string());
    }
}

fn blocked_text() -> String {
    let until = CS_STATE.lock().blocked_until;
    let min = ((until - now()) as f64 / 60000.0).ceil().max(1.0) as i64;
    t_args("Der Preisvergleich (CheapShark) hat Ludora wegen zu vieler Anfragen kurz gesperrt – noch etwa {0} Min.", &[&min.to_string()])
}

/// JSON abrufen; CheapShark-Anfragen nacheinander mit Abstand (sonst sperrt CheapShark)
async fn get_json(url: &str, post: Option<Value>) -> anyhow::Result<Value> {
    let cheap = url.contains("cheapshark.com");
    let _guard = if cheap { Some(CS.lock().await) } else { None };
    if cheap {
        with_title_cache(|_| ());
        if now() < CS_STATE.lock().blocked_until {
            return Err(RateLimited(blocked_text()).into());
        }
        let gap = CS_STATE.lock().last + CS_GAP - now();
        if gap > 0 {
            tokio::time::sleep(Duration::from_millis(gap as u64)).await;
        }
        CS_STATE.lock().last = now();
    }
    let c = crate::net::client();
    let mut r = match &post {
        Some(b) => c.post(url).header("content-type", "application/json").header("origin", "https://store.epicgames.com").body(b.to_string()),
        None => c.get(url),
    };
    r = r.header("user-agent", UA).header("accept", "application/json").timeout(Duration::from_secs(12));
    let res = r.send().await?;
    let st = res.status().as_u16();
    if st == 429 && cheap {
        let ra = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
        let until = now() + ra.max(120) * 1000;
        CS_STATE.lock().blocked_until = until;
        crate::log::info(&format!("[shop] CheapShark sperrt Anfragen (Retry-After: {ra})"));
        with_title_cache(|c| {
            c.insert("__blockedUntil".into(), json!(until));
        });
        save_title_cache();
        return Err(RateLimited(blocked_text()).into());
    }
    if !(200..300).contains(&st) {
        let host = reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
        anyhow::bail!(t_args("{0} antwortet mit {1}", &[&host, &st.to_string()]));
    }
    Ok(res.json().await?)
}

pub fn norm_title(s: &str) -> String {
    let s: String = s.chars().filter(|c| !matches!(c, '\u{2122}' | '\u{00ae}' | '\u{00a9}')).collect();
    let s: String = s.nfkd().filter(|c| !('\u{0300}'..='\u{036f}').contains(c)).collect::<String>().to_lowercase().replace('&', " and ");
    let s = crate::re!(r"\b(standard|base) edition\b").replace_all(&s, " ");
    crate::re!(r"[^a-z0-9]+").replace_all(&s, " ").trim().to_string()
}

pub fn parse_price(text: &str) -> Option<f64> {
    let s = text.trim();
    if s.is_empty() {
        return None;
    }
    if crate::re!(r"(?i)kostenlos|free|gratis").is_match(s) {
        return Some(0.0);
    }
    let compact: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    let c = crate::re!(r"(\d{1,3}(?:[.,]\d{3})*|\d+)(?:[.,](\d{2}))?").captures(&compact)?;
    let whole: f64 = c[1].replace(['.', ','], "").parse().ok()?;
    Some(whole + c.get(2).map_or(0.0, |m| m.as_str().parse::<f64>().unwrap_or(0.0) / 100.0))
}

fn decode(s: &str) -> String {
    s.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&#039;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").trim().to_string()
}

fn store(launcher: &str, url: String, uri: Option<String>, price: Option<f64>, price_text: Option<String>, old: Option<String>, discount: i64) -> Value {
    json!({ "launcher": launcher, "url": url, "uri": uri, "price": price, "priceText": price_text, "oldPriceText": old, "discount": discount })
}

#[derive(Default)]
struct List {
    items: Vec<Value>,
    more: Option<bool>,
    total: Option<f64>,
}

fn cap(re: &str, s: &str) -> Option<String> {
    Regex::new(re).unwrap().captures(s).map(|c| c[1].to_string())
}

pub fn parse_steam_results(html: &str) -> Vec<Value> {
    let mut out = vec![];
    for block in crate::re!(r#"<a\s+href=""#).split(html).skip(1) {
        let head = &block[..block.find('>').unwrap_or(block.len())];
        if crate::re!(r"data-ds-(bundleid|packageid)=").is_match(head) {
            continue;
        }
        let Some(id) = cap(r#"data-ds-appid="(\d+)""#, head) else { continue };
        let title = decode(&cap(r#"(?s)<span class="title">(.*?)</span>"#, block).unwrap_or_default());
        if title.is_empty() {
            continue;
        }
        let img = cap(r#"<img[^>]+src="([^"]+)""#, block);
        let final_txt = cap(r#"class="discount_final_price[^"]*">([^<]*)<"#, block).unwrap_or_default();
        let orig = cap(r#"class="discount_original_price">([^<]*)<"#, block);
        let pct = cap(r#"data-discount="(\d+)""#, block).or_else(|| cap(r#"class="[^"]*discount_pct[^"]*"[^>]*>\s*-?(\d+)\s*%"#, block));
        let price = cap(r#"data-price-final="(\d+)""#, block).and_then(|c| c.parse::<f64>().ok()).map(|c| c / 100.0).or_else(|| parse_price(&final_txt));
        let ft = decode(&final_txt);
        out.push(json!({
            "title": title,
            "image": format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{id}/header.jpg"),
            "imageFallback": img,
            "store": store("steam", format!("https://store.steampowered.com/app/{id}/"), Some(format!("steam://store/{id}")), price, if ft.is_empty() { None } else { Some(ft) }, orig.map(|o| decode(&o)), pct.and_then(|p| p.parse().ok()).unwrap_or(0))
        }));
    }
    out
}

struct Opts {
    q: String,
    page: i64,
    deals: bool,
    sort: String,
}

fn mark_sale(items: &mut [Value]) {
    for it in items {
        it["store"]["onSale"] = json!(true);
    }
}

async fn steam(o: &Opts) -> anyhow::Result<List> {
    steam_with(o, None).await
}

/// EA-Spiele: CheapShark führt EA nicht mehr – darum EA-Titel aus dem Steam-Store (Herausgeber Electronic Arts)
async fn ea_from_steam(o: &Opts) -> anyhow::Result<List> {
    let mut l = steam_with(o, Some("Electronic Arts")).await?;
    for it in &mut l.items {
        it["store"]["launcher"] = json!("ea");
        it["store"]["uri"] = Value::Null; // Klick öffnet die Steam-Seite im Browser
    }
    Ok(l)
}

async fn steam_with(o: &Opts, publisher: Option<&str>) -> anyhow::Result<List> {
    let mut p: Vec<(&str, String)> = vec![("term", o.q.clone()), ("start", (o.page * PAGE).to_string()), ("count", PAGE.to_string()), ("infinite", "1".into()), ("cc", "DE".into()), ("l", "german".into()), ("category1", "998".into())];
    match o.sort.as_str() {
        "price_asc" => p.push(("sort_by", "Price_ASC".into())),
        "price_desc" => p.push(("sort_by", "Price_DESC".into())),
        "new" => p.push(("sort_by", "Released_DESC".into())),
        _ if o.q.is_empty() && !o.deals => p.push(("filter", "topsellers".into())),
        _ => {}
    }
    if o.deals {
        p.push(("specials", "1".into()));
    }
    if let Some(pb) = publisher {
        p.push(("publisher", pb.into()));
        if o.q.is_empty() && o.sort.is_empty() {
            p.retain(|(k, _)| *k != "filter"); // Bestseller-Filter + Herausgeber liefert bei Steam fast nichts
        }
    }
    let j = get_json(&format!("https://store.steampowered.com/search/results/?{}", crate::net::form(&p)), None).await?;
    let html = j["results_html"].as_str().unwrap_or("");
    let mut items = parse_steam_results(html);
    if o.deals {
        mark_sale(&mut items);
    }
    let total = j["total_count"].as_f64();
    let more = match total {
        Some(t) => ((o.page + 1) * PAGE) as f64 > 0.0 && (((o.page + 1) * PAGE) as f64) < t,
        None => crate::re!(r"data-ds-appid|data-ds-bundleid|data-ds-packageid").is_match(html),
    };
    Ok(List { items, more: Some(more), total })
}

pub fn from_gog(products: &[Value]) -> Vec<Value> {
    products
        .iter()
        .filter(|x| x["title"].is_string() && x["slug"].is_string())
        .map(|x| {
            let pr = &x["price"];
            let amount = pr["finalMoney"]["amount"].as_str().and_then(|s| s.parse::<f64>().ok()).or(pr["finalMoney"]["amount"].as_f64()).or_else(|| parse_price(pr["final"].as_str().unwrap_or("")));
            let discount = pr["discount"].as_str().and_then(|s| crate::re!(r"-?\d+").find(s).and_then(|m| m.as_str().parse::<i64>().ok())).or(pr["discount"].as_i64()).unwrap_or(0).abs();
            let has_discount = match &pr["discount"] {
                Value::String(s) => !s.is_empty(),
                Value::Null => false,
                Value::Number(n) => n.as_f64() != Some(0.0),
                _ => true,
            };
            json!({
                "title": x["title"],
                "image": x["coverHorizontal"],
                "store": store("gog",
                    x["storeLink"].as_str().map(String::from).unwrap_or_else(|| format!("https://www.gog.com/de/game/{}", x["slug"].as_str().unwrap_or(""))),
                    None, amount, pr["final"].as_str().map(String::from),
                    if has_discount { pr["base"].as_str().map(String::from) } else { None }, discount)
            })
        })
        .collect()
}

async fn gog(o: &Opts) -> anyhow::Result<List> {
    let order = match o.sort.as_str() {
        "price_asc" => "asc:price",
        "price_desc" => "desc:price",
        "new" => "desc:releaseDate",
        _ if !o.q.is_empty() => "desc:score",
        _ if o.deals => "desc:discount",
        _ => "desc:trending",
    };
    let mut p: Vec<(&str, String)> = vec![("limit", GOG_PAGE.to_string()), ("page", (o.page + 1).to_string()), ("order", order.into()), ("productType", "in:game,pack".into()), ("countryCode", "DE".into()), ("locale", "de-DE".into()), ("currencyCode", "EUR".into())];
    if !o.q.is_empty() {
        p.push(("query", format!("like:{}", o.q)));
    }
    if o.deals {
        p.push(("discounted", "eq:true".into()));
    }
    let j = get_json(&format!("https://catalog.gog.com/v1/catalog?{}", crate::net::form(&p)), None).await?;
    let prods = j["products"].as_array().cloned().unwrap_or_default();
    let mut items = from_gog(&prods);
    if o.deals {
        mark_sale(&mut items);
    }
    let more = match j["pages"].as_f64() {
        Some(pages) => ((o.page + 1) as f64) < pages,
        None => prods.len() as i64 >= GOG_PAGE,
    };
    Ok(List { items, more: Some(more), total: j["productCount"].as_f64() })
}

const EPIC_QUERY: &str = r#"query searchStoreQuery($keywords: String, $count: Int, $start: Int, $country: String!, $locale: String, $sortBy: String, $sortDir: String, $category: String, $onSale: Boolean) {
  Catalog { searchStore(keywords: $keywords, count: $count, start: $start, country: $country, locale: $locale, sortBy: $sortBy, sortDir: $sortDir, category: $category, onSale: $onSale) {
    elements { title id namespace productSlug urlSlug
      keyImages { type url }
      catalogNs { mappings(pageType: "productHome") { pageSlug pageType } }
      offerMappings { pageSlug pageType }
      price(country: $country) { totalPrice { discountPrice originalPrice fmtPrice(locale: $locale) { discountPrice originalPrice } } }
    } } } }"#;

fn epic_slug(e: &Value) -> Option<String> {
    let first = |v: &Value| v.as_array().and_then(|a| a.iter().find_map(|m| m["pageSlug"].as_str().filter(|s| !s.is_empty()).map(String::from)));
    first(&e["offerMappings"])
        .or_else(|| first(&e["catalogNs"]["mappings"]))
        .or_else(|| e["productSlug"].as_str().filter(|s| !s.is_empty()).map(|s| s.trim_end_matches("/home").to_string()))
        .or_else(|| e["urlSlug"].as_str().filter(|s| !(s.len() == 32 && s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')))).map(String::from))
}

pub fn from_epic(elements: &[Value]) -> Vec<Value> {
    elements
        .iter()
        .filter_map(|e| {
            let slug = epic_slug(e)?;
            let title = e["title"].as_str()?;
            let imgs = e["keyImages"].as_array().cloned().unwrap_or_default();
            let img = ["OfferImageWide", "DieselStoreFrontWide", "featuredMedia", "Thumbnail"].iter().find_map(|t| imgs.iter().find(|i| i["type"] == *t)).and_then(|i| i["url"].as_str().map(String::from));
            let tp = &e["price"]["totalPrice"];
            let cents = tp["discountPrice"].as_f64();
            let orig = tp["originalPrice"].as_f64().unwrap_or(0.0);
            let reduced = cents.is_some_and(|c| orig > c);
            Some(json!({
                "title": title,
                "image": img,
                "store": store("epic", format!("https://store.epicgames.com/de/p/{slug}"), Some(format!("com.epicgames.launcher://store/p/{slug}")),
                    cents.map(|c| c / 100.0),
                    if cents == Some(0.0) { Some(t("Kostenlos")) } else { tp["fmtPrice"]["discountPrice"].as_str().map(String::from) },
                    if reduced { tp["fmtPrice"]["originalPrice"].as_str().map(String::from) } else { None },
                    if orig > 0.0 { ((1.0 - cents.unwrap_or(orig) / orig) * 100.0).round() as i64 } else { 0 })
            }))
        })
        .collect()
}

async fn epic(o: &Opts) -> anyhow::Result<List> {
    let (mut sort_by, mut sort_dir) = (if o.q.is_empty() { "releaseDate" } else { "relevancy" }, "DESC");
    match o.sort.as_str() {
        "price_asc" => (sort_by, sort_dir) = ("currentPrice", "ASC"),
        "price_desc" => (sort_by, sort_dir) = ("currentPrice", "DESC"),
        "new" => (sort_by, sort_dir) = ("releaseDate", "DESC"),
        _ => {}
    }
    let mut vars = json!({ "keywords": o.q, "count": EPIC_PAGE, "start": o.page * EPIC_PAGE, "country": "DE", "locale": "de", "category": "games/edition/base", "sortBy": sort_by, "sortDir": sort_dir });
    if o.deals {
        vars["onSale"] = json!(true);
    }
    let mut last = anyhow::anyhow!("Epic: unerwartete Antwort");
    let body = json!({ "query": EPIC_QUERY, "variables": vars });
    for ep in ["webview", "https://store.epicgames.com/graphql", "https://graphql.epicgames.com/graphql"] {
        // Epic sperrt Programme ohne Browser (Cloudflare, 403) – darum zuerst über ein unsichtbares
        // Fenster mit der Epic-Seite, das wie ein normaler Browser fragt
        let res = if ep == "webview" { epic_via_webview(&body).await } else { get_json(ep, Some(body.clone())).await };
        match res {
            Ok(j) => {
                let ss = &j["data"]["Catalog"]["searchStore"];
                if let Some(els) = ss["elements"].as_array() {
                    let total = ss["paging"]["total"].as_f64();
                    let mut items = from_epic(els);
                    if o.deals {
                        mark_sale(&mut items);
                    }
                    let more = match total {
                        Some(t) => (((o.page + 1) * EPIC_PAGE) as f64) < t,
                        None => els.len() as i64 >= EPIC_PAGE,
                    };
                    return Ok(List { items, more: Some(more), total });
                }
                last = anyhow::anyhow!("Epic: unerwartete Antwort");
            }
            Err(e) => {
                crate::log::warn(&format!("[shop] epic {ep}: {e}"));
                last = e
            }
        }
    }
    Err(last)
}

static APP: once_cell::sync::OnceCell<tauri::AppHandle> = once_cell::sync::OnceCell::new();
static EPIC_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
const EPIC_LABEL: &str = "epic-shop";

pub fn init(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

/// Unsichtbares Fenster mit store.epicgames.com (wird wiederverwendet)
async fn epic_window(app: &tauri::AppHandle) -> anyhow::Result<tauri::WebviewWindow> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window(EPIC_LABEL) {
        return Ok(w);
    }
    let w = tauri::WebviewWindowBuilder::new(app, EPIC_LABEL, tauri::WebviewUrl::External("https://store.epicgames.com/de/".parse()?))
        .title("Epic Games Store")
        .visible(false)
        .skip_taskbar(true)
        .inner_size(1000.0, 700.0)
        .build()?;
    // Seite (und ggf. Cloudflare-Prüfung) laden lassen
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if w.url().is_ok_and(|u| u.host_str() == Some("store.epicgames.com")) {
            break;
        }
    }
    tokio::time::sleep(Duration::from_millis(2500)).await;
    Ok(w)
}

/// GraphQL-Anfrage aus der Epic-Seite heraus; die Antwort kommt über den Adress-Anker (#…) zurück
async fn epic_via_webview(body: &Value) -> anyhow::Result<Value> {
    let app = APP.get().ok_or_else(|| anyhow::anyhow!("keine App"))?.clone();
    let _g = EPIC_LOCK.lock().await;
    let mut last = anyhow::anyhow!("Epic: keine Antwort");
    for attempt in 0..3 {
        let w = epic_window(&app).await?;
        let id = format!("{:x}", rand::random::<u64>());
        let script = format!(
            "(async()=>{{let out;try{{const r=await fetch('/graphql',{{method:'POST',headers:{{'content-type':'application/json'}},body:{body}}});out=r.status+'|'+await r.text();}}catch(e){{out='0|'+e}}window.location.hash='ludora-{id}='+encodeURIComponent(out);}})();",
            body = serde_json::to_string(&body.to_string())?
        );
        w.eval(&script)?;
        let marker = format!("ludora-{id}=");
        let mut got: Option<String> = None;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(150)).await;
            if let Ok(u) = w.url() {
                if let Some(frag) = u.fragment().filter(|f| f.starts_with(&marker)) {
                    got = Some(crate::covers::urlencoding_decode(&frag[marker.len()..]));
                    break;
                }
            }
        }
        let Some(text) = got else {
            last = anyhow::anyhow!("Epic: keine Antwort");
            continue;
        };
        let (status, rest) = text.split_once('|').unwrap_or(("0", ""));
        if status == "200" {
            return Ok(serde_json::from_str(rest)?);
        }
        last = anyhow::anyhow!(t_args("{0} antwortet mit {1}", &["store.epicgames.com", status]));
        // Cloudflare-Prüfung läuft evtl. noch: Seite neu laden und noch einmal
        if attempt < 2 {
            let _ = w.eval("window.location.href='https://store.epicgames.com/de/'");
            tokio::time::sleep(Duration::from_millis(4000)).await;
        }
    }
    Err(last)
}

pub fn launcher_for_store_name(name: &str) -> Option<&'static str> {
    let n = name.to_lowercase();
    let is = |re: &str| Regex::new(re).unwrap().is_match(&n);
    if is(r"origin|ea app|\bea\b") {
        Some("ea")
    } else if is(r"uplay|ubisoft") {
        Some("ubisoft")
    } else if is(r"blizzard|battle\.net") {
        Some("battlenet")
    } else if is("epic") {
        Some("epic")
    } else if is("^gog") {
        Some("gog")
    } else if n == "steam" {
        Some("steam")
    } else {
        None
    }
}

async fn cheap_stores() -> anyhow::Result<HashMap<String, String>> {
    if let Some(s) = CS_STATE.lock().stores.clone() {
        return Ok(s);
    }
    let list = get_json("https://www.cheapshark.com/api/1.0/stores", None).await?;
    let mut m = HashMap::new();
    for s in list.as_array().cloned().unwrap_or_default() {
        if let Some(l) = launcher_for_store_name(s["storeName"].as_str().unwrap_or("")) {
            if s["isActive"] != 0 {
                m.insert(id_s(&s["storeID"]), l.to_string());
            }
        }
    }
    CS_STATE.lock().stores = Some(m.clone());
    Ok(m)
}

fn id_s(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        v => v.to_string(),
    }
}

fn steam_header(appid: &Value) -> Option<String> {
    let a = id_s(appid);
    if a.is_empty() {
        None
    } else {
        Some(format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{a}/header.jpg"))
    }
}

pub fn from_cheapshark(by_id: &Value, stores: &HashMap<String, String>) -> Vec<Value> {
    let mut out = vec![];
    for g in by_id.as_object().map(|o| o.values().cloned().collect::<Vec<_>>()).unwrap_or_default() {
        let Some(title) = g["info"]["title"].as_str() else { continue };
        for d in g["deals"].as_array().cloned().unwrap_or_default() {
            let Some(l) = stores.get(&id_s(&d["storeID"])) else { continue };
            if !["ea", "ubisoft", "battlenet"].contains(&l.as_str()) {
                continue;
            }
            out.push(json!({
                "title": title,
                "image": steam_header(&g["info"]["steamAppID"]).map(Value::String).unwrap_or(g["info"]["thumb"].clone()),
                "store": store(l, format!("https://www.cheapshark.com/redirect?dealID={}", crate::net::enc(&id_s(&d["dealID"]))), None, None, None, None, 0)
            }));
        }
    }
    out
}

async fn cheapshark_by_ids(ids: &[String]) -> anyhow::Result<Vec<Value>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let stores = cheap_stores().await?;
    let mut out = vec![];
    for chunk in ids.chunks(25) {
        let j = get_json(&format!("https://www.cheapshark.com/api/1.0/games?ids={}", chunk.join(",")), None).await?;
        out.extend(from_cheapshark(&j, &stores));
    }
    Ok(out)
}

async fn cheapshark(o: &Opts) -> anyhow::Result<List> {
    if o.q.is_empty() || o.page > 0 {
        return Ok(List::default());
    }
    let list = get_json(&format!("https://www.cheapshark.com/api/1.0/games?title={}&limit=30", crate::net::enc(&o.q)), None).await?;
    let ids: Vec<String> = list.as_array().cloned().unwrap_or_default().iter().map(|x| id_s(&x["gameID"])).filter(|s| !s.is_empty()).collect();
    Ok(List { items: cheapshark_by_ids(&ids).await?, ..Default::default() })
}

async fn cheapshark_store(launcher: &str, o: &Opts) -> anyhow::Result<List> {
    let stores = cheap_stores().await?;
    let ids: Vec<String> = stores.iter().filter(|(_, l)| *l == launcher).map(|(id, _)| id.clone()).collect();
    if ids.is_empty() {
        return Ok(List::default());
    }
    let sort_by = match o.sort.as_str() {
        "price_asc" | "price_desc" => "Price",
        "new" => "Release",
        _ if !o.q.is_empty() => "Title",
        _ if o.deals => "Savings",
        _ => "Deal Rating",
    };
    let mut p: Vec<(&str, String)> = vec![("storeID", ids.join(",")), ("pageNumber", o.page.to_string()), ("pageSize", PAGE.to_string()), ("sortBy", sort_by.into())];
    if o.sort == "price_desc" || o.sort == "new" || (o.sort.is_empty() && o.deals && o.q.is_empty()) {
        p.push(("desc", if o.sort == "price_desc" || o.sort == "new" { "1" } else { "0" }.into()));
    }
    if !o.q.is_empty() {
        p.push(("title", o.q.clone()));
    }
    if o.deals {
        p.push(("onSale", "1".into()));
    }
    let list = get_json(&format!("https://www.cheapshark.com/api/1.0/deals?{}", crate::net::form(&p)), None).await?;
    let arr = list.as_array().cloned().unwrap_or_default();
    let items = arr
        .iter()
        .filter(|d| d["title"].is_string() && !d["dealID"].is_null())
        .map(|d| {
            let on_sale = d["isOnSale"] == "1" || d["isOnSale"] == 1;
            let savings = d["savings"].as_str().and_then(|s| s.parse::<f64>().ok()).or(d["savings"].as_f64()).unwrap_or(0.0);
            let mut st = store(launcher, format!("https://www.cheapshark.com/redirect?dealID={}", crate::net::enc(&id_s(&d["dealID"]))), None, None, None, None, if on_sale { savings.round() as i64 } else { 0 });
            st["onSale"] = json!(o.deals);
            json!({
                "title": d["title"],
                "image": steam_header(&d["steamAppID"]).map(Value::String).unwrap_or(d["thumb"].clone()),
                "imageFallback": d["thumb"],
                "store": st
            })
        })
        .collect();
    Ok(List { items, more: Some(arr.len() as i64 >= PAGE), total: None })
}

fn static_items() -> Vec<Value> {
    let bn = |title: &str, code: &str, url: &str| json!({ "title": title, "image": null, "store": store("battlenet", url.into(), Some(format!("battlenet://{code}")), None, None, None, 0) });
    let riot = |title: &str, url: &str| json!({ "title": title, "image": null, "store": store("riot", url.into(), None, Some(0.0), Some(t("Kostenlos")), None, 0) });
    let r = |title: &str, url: &str| json!({ "title": title, "image": null, "store": store("rockstar", url.into(), None, None, None, None, 0) });
    vec![
        bn("World of Warcraft", "WoW", "https://worldofwarcraft.blizzard.com/de-de/"),
        bn("Diablo IV", "Fen", "https://diablo4.blizzard.com/de-de/"),
        bn("Overwatch 2", "Pro", "https://overwatch.blizzard.com/de-de/"),
        bn("Hearthstone", "WTCG", "https://hearthstone.blizzard.com/de-de/"),
        bn("Diablo II: Resurrected", "OSI", "https://diablo2.blizzard.com/de-de/"),
        bn("Diablo III", "D3", "https://eu.diablo3.blizzard.com/de-de/"),
        bn("StarCraft II", "S2", "https://starcraft2.blizzard.com/de-de/"),
        bn("Heroes of the Storm", "Hero", "https://heroesofthestorm.blizzard.com/de-de/"),
        bn("Warcraft III: Reforged", "W3", "https://playwarcraft3.com/de-de/"),
        riot("League of Legends", "https://www.leagueoflegends.com/de-de/"),
        riot("VALORANT", "https://playvalorant.com/de-de/"),
        riot("Teamfight Tactics", "https://teamfighttactics.leagueoflegends.com/de-de/"),
        riot("Legends of Runeterra", "https://playruneterra.com/de-de/"),
        r("Grand Theft Auto V", "https://www.rockstargames.com/de/gta-v"),
        r("Red Dead Redemption 2", "https://www.rockstargames.com/de/reddeadredemption2"),
    ]
}

fn static_matches(q: &str) -> Vec<Value> {
    let n = norm_title(q);
    static_items().into_iter().filter(|s| q.is_empty() || norm_title(s["title"].as_str().unwrap_or("")).contains(&n)).collect()
}

/// Treffer aller Stores zu einem Spiel zusammenführen
pub fn merge(lists: &[Vec<Value>], q: &str) -> Vec<Value> {
    let nq = norm_title(q);
    let mut order: Vec<String> = vec![];
    let mut by: HashMap<String, (Value, Map<String, Value>, usize)> = HashMap::new();
    for list in lists {
        for (rank, item) in list.iter().enumerate() {
            let k = norm_title(item["title"].as_str().unwrap_or(""));
            if k.is_empty() {
                continue;
            }
            let launcher = item["store"]["launcher"].as_str().unwrap_or("").to_string();
            let e = by.entry(k.clone()).or_insert_with(|| {
                order.push(k.clone());
                (json!({ "key": k, "title": item["title"], "image": null, "imageFallback": null }), Map::new(), usize::MAX)
            });
            e.2 = e.2.min(rank);
            if !item["image"].is_null() && (e.0["image"].is_null() || launcher == "steam") {
                e.0["image"] = item["image"].clone();
                e.0["imageFallback"] = if item["imageFallback"].is_null() { Value::Null } else { item["imageFallback"].clone() };
            }
            if launcher == "steam" {
                e.0["title"] = item["title"].clone();
            }
            e.1.entry(launcher).or_insert(item["store"].clone());
        }
    }
    let mut games: Vec<(Value, usize)> = order
        .into_iter()
        .map(|k| {
            let (mut g, stores, rank) = by.remove(&k).unwrap();
            let prices: Vec<f64> = stores.values().filter_map(|s| s["price"].as_f64()).collect();
            let mut ls: Vec<&String> = stores.keys().collect();
            ls.sort_by_key(|l| ORDER.iter().position(|o| o == l).unwrap_or(99));
            g["stores"] = Value::Array(ls.iter().map(|l| stores[*l].clone()).collect());
            g["minPrice"] = prices.iter().cloned().fold(None, |a: Option<f64>, b| Some(a.map_or(b, |a| a.min(b)))).map_or(Value::Null, |p| json!(p));
            g["rank"] = json!(rank);
            (g, rank)
        })
        .collect();
    let score = |g: &Value, rank: usize| -> i64 {
        let k = g["key"].as_str().unwrap_or("");
        (if !nq.is_empty() && k == nq { -1000 } else if !nq.is_empty() && k.starts_with(&nq) { -500 } else { 0 }) + rank as i64
    };
    games.sort_by(|a, b| score(&a.0, a.1).cmp(&score(&b.0, b.1)).then(b.0["stores"].as_array().map_or(0, |x| x.len()).cmp(&a.0["stores"].as_array().map_or(0, |x| x.len()))));
    games.into_iter().map(|g| g.0).collect()
}

pub async fn query(opts: &Value) -> Value {
    let q: String = opts["q"].as_str().unwrap_or("").trim().chars().take(100).collect();
    let page = opts["page"].as_f64().unwrap_or(0.0).clamp(0.0, 1000.0) as i64;
    let st = opts["store"].as_str().filter(|s| ORDER.contains(s)).map(String::from);
    let deals = opts["deals"] == true;
    let sort = opts["sort"].as_str().filter(|s| ["price_asc", "price_desc", "new"].contains(s)).unwrap_or("").to_string();
    let key = format!("{}|{}|{}|{}|{}", st.as_deref().unwrap_or("all"), if deals { "deals" } else { "" }, sort, q.to_lowercase(), page);
    if let Some((at, v)) = RESULT_CACHE.lock().get(&key) {
        if now() - at < 10 * 60 * 1000 {
            return v.clone();
        }
    }
    let o = Opts { q: q.clone(), page, deals, sort: sort.clone() };
    let names: Vec<&str> = match st.as_deref() {
        None if deals => vec!["steam", "epic", "gog", "ubisoft", "battlenet"],
        None => vec!["steam", "epic", "gog", "cheapshark"],
        Some(s @ ("steam" | "epic" | "gog")) => vec![s],
        Some(s @ ("ea" | "ubisoft" | "battlenet")) => vec![s],
        _ => vec![],
    };
    let futs = names.iter().map(|n| {
        let o = &o;
        async move {
            match *n {
                "steam" => steam(o).await,
                "epic" => epic(o).await,
                "gog" => gog(o).await,
                "cheapshark" => cheapshark(o).await,
                "ea" => ea_from_steam(o).await,
                l => cheapshark_store(l, o).await,
            }
        }
    });
    let settled = futures::future::join_all(futs).await;
    let mut lists: Vec<List> = vec![];
    let mut errors = Map::new();
    let mut limited: Option<String> = None;
    let mut log = vec![];
    for (n, r) in names.iter().zip(settled) {
        match r {
            Ok(l) => {
                log.push(format!("{n} {}", l.items.len()));
                lists.push(l);
            }
            Err(e) => {
                if let Some(rl) = e.downcast_ref::<RateLimited>() {
                    limited = Some(rl.0.clone());
                }
                log.push(format!("{n} FEHLER ({e})"));
                errors.insert(n.to_string(), json!(e.to_string()));
            }
        }
    }
    crate::log::info(&format!("[shop] {}{}{} Seite {page}: {}", st.as_deref().unwrap_or("alle"), if deals { " Angebote" } else { "" }, if q.is_empty() { String::new() } else { format!(" \"{q}\"") }, log.join(", ")));
    if page == 0 && !deals {
        let sm: Vec<Value> = static_matches(&q).into_iter().filter(|x| st.as_deref().map_or(true, |s| x["store"]["launcher"] == s)).collect();
        if !sm.is_empty() {
            lists.push(List { items: sm, ..Default::default() });
        }
    }
    let needed: Vec<&str> = if st.is_some() { names.clone() } else { vec!["steam", "epic", "gog"] };
    if !needed.is_empty() && needed.iter().all(|n| errors.contains_key(*n)) && !lists.iter().any(|l| !l.items.is_empty()) {
        let msg = limited.unwrap_or_else(|| if st.is_some() { t("Dieser Store ist gerade nicht erreichbar. Bist du online?") } else { t("Die Stores sind gerade nicht erreichbar. Bist du online?") });
        return json!({ "ok": false, "error": msg, "errors": errors, "games": [], "more": false });
    }
    let raw: Vec<Vec<Value>> = lists.iter().map(|l| l.items.clone()).collect();
    let mut games = merge(&raw, &q);
    let best = |g: &Value| g["stores"].as_array().map_or(0, |s| s.iter().map(|x| x["discount"].as_i64().unwrap_or(0)).max().unwrap_or(0).max(0));
    if deals {
        games.retain(|g| best(g) > 0 || g["stores"].as_array().is_some_and(|s| s.iter().any(|x| x["onSale"] == true)));
        if q.is_empty() && sort.is_empty() {
            games.sort_by(|a, b| best(b).cmp(&best(a)));
        }
    }
    let more = lists.iter().any(|l| l.more == Some(true));
    let totals: Vec<f64> = lists.iter().filter_map(|l| l.total).filter(|t| *t > 0.0).collect();
    if sort == "price_asc" || sort == "price_desc" {
        let dir = if sort == "price_asc" { 1.0 } else { -1.0 };
        games.sort_by(|a, b| {
            let (pa, pb) = (a["minPrice"].as_f64(), b["minPrice"].as_f64());
            pa.is_none().cmp(&pb.is_none()).then_with(|| (dir * (pa.unwrap_or(0.0) - pb.unwrap_or(0.0))).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal))
        });
    }
    let total = if totals.is_empty() { Value::Null } else { json!(totals.iter().sum::<f64>()) };
    let value = json!({ "ok": true, "games": games, "errors": errors.clone(), "more": more, "total": total, "approx": st.is_none() && totals.len() > 1 });
    if errors.is_empty() {
        RESULT_CACHE.lock().insert(key, (now(), value.clone()));
    }
    value
}

async fn enrich(titles: &[String]) -> anyhow::Result<Vec<Value>> {
    let n = now();
    let mut ids: Vec<String> = vec![];
    let mut todo: Vec<(String, String)> = vec![];
    with_title_cache(|c| {
        for title in titles {
            let k = norm_title(title);
            match c.get(&k) {
                Some(e) if n - e["t"].as_i64().unwrap_or(0) < TITLE_TTL => ids.extend(e["ids"].as_array().cloned().unwrap_or_default().iter().map(id_s)),
                _ => todo.push((k, title.clone())),
            }
        }
    });
    let my = {
        let mut g = ENRICH_GEN.lock();
        *g += 1;
        *g
    };
    for (k, title) in todo.into_iter().take(8) {
        if *ENRICH_GEN.lock() != my {
            break;
        }
        match get_json(&format!("https://www.cheapshark.com/api/1.0/games?title={}&exact=1&limit=3", crate::net::enc(&title)), None).await {
            Ok(list) => {
                let found: Vec<String> = list.as_array().cloned().unwrap_or_default().iter().filter(|x| norm_title(x["external"].as_str().unwrap_or("")) == k).map(|x| id_s(&x["gameID"])).collect();
                with_title_cache(|c| {
                    c.insert(k, json!({ "t": n, "ids": found }));
                });
                ids.extend(found);
            }
            Err(_) => break,
        }
    }
    save_title_cache();
    let mut uniq = vec![];
    for i in ids {
        if !uniq.contains(&i) {
            uniq.push(i);
        }
    }
    cheapshark_by_ids(&uniq).await
}

pub async fn more(titles: &Value) -> Value {
    let list: Vec<String> = titles.as_array().cloned().unwrap_or_default().iter().take(60).map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).collect();
    match enrich(&list).await {
        Ok(items) => {
            let mut by: Map<String, Value> = Map::new();
            for it in items {
                let k = norm_title(it["title"].as_str().unwrap_or(""));
                let arr = by.entry(k).or_insert(json!([])).as_array_mut().unwrap();
                if !arr.iter().any(|s| s["launcher"] == it["store"]["launcher"]) {
                    arr.push(it["store"].clone());
                }
            }
            json!({ "ok": true, "stores": by })
        }
        Err(e) => json!({ "ok": false, "error": e.to_string(), "stores": {} }),
    }
}

pub fn is_allowed_url(u: &str) -> bool {
    let Ok(x) = reqwest::Url::parse(u) else { return false };
    x.scheme() == "https"
        && crate::re!(r"(?i)(^|\.)(steampowered\.com|gog\.com|epicgames\.com|ea\.com|ubisoft\.com|ubi\.com|blizzard\.com|battle\.net|playwarcraft3\.com|leagueoflegends\.com|playvalorant\.com|playruneterra\.com|riotgames\.com|rockstargames\.com|cheapshark\.com)$").is_match(x.host_str().unwrap_or(""))
}

pub fn is_allowed_uri(u: &str) -> bool {
    crate::re!(r"^(steam://store/\d+|com\.epicgames\.launcher://store/p/[\w-]+|battlenet://\w+)$").is_match(u)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn titles_and_prices() {
        assert_eq!(norm_title("DOOM™ Eternal – Standard Edition"), "doom eternal");
        assert_eq!(norm_title("Pokémon & Co"), "pokemon and co");
        assert_eq!(parse_price("1.299,99€"), Some(1299.99));
        assert_eq!(parse_price("Kostenlos"), Some(0.0));
        assert_eq!(parse_price("19,99 €"), Some(19.99));
    }
    #[test]
    fn steam_html() {
        let html = r#"<a href="https://x" data-ds-appid="10" data-price-final="999"><span class="title">Counter &amp; Strike</span><div class="discount_final_price">9,99€</div></a><a href="y" data-ds-packageid="1"><span class="title">Pack</span></a>"#;
        let r = parse_steam_results(html);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0]["title"], "Counter & Strike");
        assert_eq!(r[0]["store"]["price"], 9.99);
    }
    #[test]
    fn merging() {
        let a = vec![json!({ "title": "Game", "image": "e", "store": { "launcher": "epic", "price": 5.0 } })];
        let b = vec![json!({ "title": "GAME", "image": "s", "store": { "launcher": "steam", "price": 3.0 } })];
        let m = merge(&[a, b], "game");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0]["stores"][0]["launcher"], "steam");
        assert_eq!(m[0]["minPrice"], 3.0);
        assert_eq!(m[0]["image"], "s");
    }
    #[test]
    fn allowed() {
        assert!(is_allowed_url("https://store.steampowered.com/app/1/"));
        assert!(!is_allowed_url("https://evil.com/steampowered.com"));
        assert!(is_allowed_uri("steam://store/10"));
        assert!(!is_allowed_uri("steam://run/10"));
    }
}
