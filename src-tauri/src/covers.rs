//! Cover-Bilder und Plattform-Kompatibilität (compat.js).

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::util::*;

const NEGATIVE_TTL: i64 = 3 * 24 * 3600 * 1000;

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ---------- Zwischenspeicher ----------

struct JsonFile {
    file: PathBuf,
    data: Option<Map<String, Value>>,
}

impl JsonFile {
    fn new(name: &str) -> Self {
        JsonFile { file: crate::paths::data_dir().join(name), data: None }
    }
    fn get(&mut self) -> &mut Map<String, Value> {
        if self.data.is_none() {
            self.data = Some(std::fs::read_to_string(&self.file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default());
        }
        self.data.as_mut().unwrap()
    }
    fn save(&mut self) {
        if let Some(d) = &self.data {
            if let Some(p) = self.file.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            let _ = std::fs::write(&self.file, serde_json::to_string(d).unwrap_or_default());
        }
    }
}

static CACHE: Lazy<Mutex<JsonFile>> = Lazy::new(|| Mutex::new(JsonFile::new("covers.json")));
static CHECK: Lazy<Mutex<JsonFile>> = Lazy::new(|| Mutex::new(JsonFile::new("cover-check.json")));
static COMPAT: Lazy<Mutex<JsonFile>> = Lazy::new(|| Mutex::new(JsonFile::new("compat-cache.json")));

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().filter(|s| !s.is_empty()).map(String::from)).collect()).unwrap_or_default()
}

/// { covers, wides } aus Cache-Eintrag/Funden (None = nichts)
pub fn to_images(x: &Value) -> Option<(Vec<String>, Vec<String>)> {
    if x.is_null() {
        return None;
    }
    if let Some(urls) = x["urls"].as_array() {
        let u = strs(&Value::Array(urls.clone()));
        let first = u.first()?.clone();
        return Some((vec![first.clone()], vec![u.get(1).cloned().unwrap_or(first)]));
    }
    let covers = strs(&x["covers"]);
    let wides = strs(&x["wides"]);
    if covers.is_empty() && wides.is_empty() {
        return None;
    }
    let w = if wides.is_empty() { covers.clone() } else { wides };
    Some((covers, w))
}

fn imgs_json(c: &(Vec<String>, Vec<String>)) -> Value {
    json!({ "covers": c.0, "wides": c.1 })
}

/// Gecachte Cover beim Scan eintragen (ohne Netz)
pub fn apply_cached(games: &mut [Value]) {
    let mut c = CACHE.lock();
    let cache = c.get();
    for g in games.iter_mut() {
        let id = g["id"].as_str().unwrap_or("").to_string();
        let entry = cache.get(&id).cloned().unwrap_or(Value::Null);
        if entry["repaired"] == true {
            if let Some((cv, wd)) = to_images(&entry) {
                let mut nc = cv;
                nc.extend(strs(&g["covers"]));
                let mut nw = wd;
                nw.extend(strs(&g["wides"]));
                g["covers"] = json!(nc);
                g["wides"] = json!(nw);
            }
            continue;
        }
        if !strs(&g["covers"]).is_empty() || !strs(&g["wides"]).is_empty() {
            continue;
        }
        if let Some(hit) = to_images(&entry) {
            g["covers"] = json!(hit.0);
            g["wides"] = json!(hit.1);
        }
    }
}

/// Spiele, für die noch gesucht werden muss
pub fn needs_lookup(games: &[Value]) -> Vec<Value> {
    let mut c = CACHE.lock();
    let cache = c.get();
    let t = now();
    games
        .iter()
        .filter(|g| {
            if !strs(&g["covers"]).is_empty() || !strs(&g["wides"]).is_empty() {
                return false;
            }
            match cache.get(g["id"].as_str().unwrap_or("")) {
                None => true,
                Some(hit) => to_images(hit).is_none() && t - hit["at"].as_i64().unwrap_or(0) > NEGATIVE_TTL,
            }
        })
        .cloned()
        .collect()
}

pub fn clear_misses() {
    let mut c = CACHE.lock();
    c.get().retain(|_, v| to_images(v).is_some());
    c.save();
}

/// Eigenes Cover (vom Nutzer gewählt) – hat immer Vorrang
pub fn set_custom(id: &str, url: &str) -> Value {
    let mut c = CACHE.lock();
    c.get().insert(id.into(), json!({ "covers": [url], "wides": [url], "repaired": true, "custom": true, "at": now() }));
    c.save();
    json!({ "covers": [url], "wides": [url] })
}

// ---------- Quellen ----------

async fn get_json(url: &str, auth: Option<&str>) -> Option<Value> {
    let mut r = crate::net::client().get(url).timeout(Duration::from_secs(10));
    if let Some(a) = auth {
        r = r.header("authorization", a);
    }
    let res = r.send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.json().await.ok()
}

fn steam_cdn(id: &str) -> (Vec<String>, Vec<String>) {
    (
        vec![format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{id}/library_600x900.jpg")],
        vec![format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{id}/header.jpg")],
    )
}

/// Bilder aus dem Steam-Store (richtige Links auch bei neuen Spielen)
async fn steam_assets(appid: &str) -> Option<(Vec<String>, Vec<String>)> {
    let input = json!({
        "ids": [{ "appid": appid.parse::<u64>().ok()? }],
        "context": { "language": "german", "country_code": "DE", "steam_realm": 1 },
        "data_request": { "include_assets": true },
    });
    let data = get_json(&format!("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json={}", crate::net::enc(&input.to_string())), None).await?;
    let a = &data["response"]["store_items"][0]["assets"];
    let fmt = a["asset_url_format"].as_str()?;
    let url = |f: &Value| f.as_str().map(|f| format!("https://shared.akamai.steamstatic.com/store_item_assets/{}", fmt.replace("${FILENAME}", f)));
    to_images(&json!({
        "covers": [url(&a["library_capsule_2x"]), url(&a["library_capsule"])],
        "wides": [url(&a["header"]), url(&a["main_capsule"])],
    }))
}

async fn from_steam_app(g: &Value) -> Option<(Vec<String>, Vec<String>)> {
    let id = g["nativeId"].as_str()?;
    if g["provider"] != "steam" || !id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    steam_assets(id).await
}

async fn from_gog(g: &Value) -> Option<(Vec<String>, Vec<String>)> {
    if g["provider"] != "gog" {
        return None;
    }
    let id = g["nativeId"].as_str()?;
    let mut covers = vec![];
    let mut wides = vec![];
    if let Some(v2) = get_json(&format!("https://api.gog.com/v2/games/{id}?locale=de-DE"), None).await {
        if let Some(b) = v2["_links"]["boxArtImage"]["href"].as_str() {
            covers.push(b.to_string());
        }
    }
    if let Some(p) = get_json(&format!("https://api.gog.com/products/{id}"), None).await {
        if let Some(w) = p["images"]["logo2x"].as_str().or(p["images"]["background"].as_str()) {
            wides.push(if w.starts_with("//") { format!("https:{w}") } else { w.to_string() });
        }
    }
    to_images(&json!({ "covers": covers, "wides": wides }))
}

async fn from_steamgriddb(g: &Value) -> Option<(Vec<String>, Vec<String>)> {
    let key = crate::settings::get_str("steamGridDbKey", "").trim().to_string();
    if key.is_empty() {
        return None;
    }
    let auth = format!("Bearer {key}");
    let base = "https://www.steamgriddb.com/api/v2";
    let name = g["name"].as_str()?;
    let search = get_json(&format!("{base}/search/autocomplete/{}", crate::net::enc(name)), Some(&auth)).await?;
    let best = search["data"].as_array()?.iter().map(|d| (d, similarity(d["name"].as_str().unwrap_or(""), name))).max_by(|a, b| a.1.total_cmp(&b.1))?;
    if best.1 < 0.75 {
        return None;
    }
    let id = best.0["id"].to_string();
    let (u1, u2) = (
        format!("{base}/grids/game/{id}?dimensions=600x900&types=static&nsfw=false"),
        format!("{base}/grids/game/{id}?dimensions=460x215,920x430&types=static&nsfw=false"),
    );
    let (tall, wide) = tokio::join!(get_json(&u1, Some(&auth)), get_json(&u2, Some(&auth)));
    let first = |v: Option<Value>| v.and_then(|x| x["data"][0]["url"].as_str().map(String::from));
    to_images(&json!({ "covers": [first(tall)], "wides": [first(wide)] }))
}

async fn from_steam_store(g: &Value) -> Option<(Vec<String>, Vec<String>)> {
    let name = g["name"].as_str()?;
    let term: String = name.chars().filter(|c| !matches!(c, '™' | '®' | '©')).collect();
    let data = get_json(&format!("https://store.steampowered.com/api/storesearch/?term={}&cc=de&l=german", crate::net::enc(&term)), None).await?;
    let best = data["items"]
        .as_array()?
        .iter()
        .filter(|i| i["type"] == "app")
        .map(|i| (i, similarity(i["name"].as_str().unwrap_or(""), name)))
        .max_by(|a, b| a.1.total_cmp(&b.1))?;
    if best.1 < 0.8 {
        return None;
    }
    let id = best.0["id"].to_string();
    Some(steam_assets(&id).await.unwrap_or_else(|| steam_cdn(&id)))
}

/// Microsoft Store / Xbox-Katalog (hilft bei VALORANT, Blizzard, Ubisoft)
async fn from_ms_store(g: &Value) -> Option<(Vec<String>, Vec<String>)> {
    let name = g["name"].as_str()?;
    let q: String = name.chars().filter(|c| !matches!(c, '™' | '®' | '©')).collect();
    let sug = get_json(&format!("https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest?market=DE&languages=de-DE&query={}&productFamilyNames=Games&platformdependencyname=windows.desktop", crate::net::enc(&q)), None).await?;
    let items: Vec<&Value> = sug["ResultSets"].as_array()?.iter().flat_map(|r| r["Suggests"].as_array().map(|a| a.iter().collect::<Vec<_>>()).unwrap_or_default()).collect();
    let best = items.into_iter().map(|i| (i, similarity(i["Title"].as_str().unwrap_or(""), name))).max_by(|a, b| a.1.total_cmp(&b.1))?;
    if best.1 < 0.8 {
        return None;
    }
    let fix = |u: Option<&str>| u.map(|u| if u.starts_with("//") { format!("https:{u}") } else { u.to_string() });
    let id = best.0["Metas"].as_array().and_then(|m| m.iter().find(|x| x["Key"] == "BigCatalogId")).and_then(|x| x["Value"].as_str());
    if let Some(id) = id {
        if let Some(p) = get_json(&format!("https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds={id}&market=DE&languages=de-DE"), None).await {
            let imgs = p["Products"][0]["LocalizedProperties"][0]["Images"].as_array().cloned().unwrap_or_default();
            let pick = |kinds: &[&str]| kinds.iter().find_map(|k| imgs.iter().find(|i| i["ImagePurpose"] == *k).and_then(|i| i["Uri"].as_str()));
            if let Some(r) = to_images(&json!({
                "covers": [fix(pick(&["Poster", "BoxArt"]))],
                "wides": [fix(pick(&["SuperHeroArt", "TitledHeroArt", "Hero", "BrandedKeyArt"]))],
            })) {
                return Some(r);
            }
        }
    }
    to_images(&json!({ "covers": [fix(best.0["ImageUrl"].as_str())] }))
}

async fn head_ok(u: &str) -> bool {
    let c = crate::net::client();
    if c.head(u).timeout(Duration::from_secs(8)).send().await.map(|r| r.status().is_success()).unwrap_or(false) {
        return true;
    }
    // Manche Bild-Server (z. B. Microsoft, Epic) beantworten HEAD nicht – dann das erste Byte holen
    c.get(u).header("Range", "bytes=0-0").timeout(Duration::from_secs(8)).send().await.map(|r| r.status().is_success()).unwrap_or(false)
}

async fn from_epic_store(g: &Value) -> Option<(Vec<String>, Vec<String>)> {
    let name: String = g["name"].as_str()?.chars().filter(|c| !matches!(c, '™' | '®' | '©')).collect();
    crate::shop::epic_images(name.trim()).await
}

/// Shop: Cover einer bekannten Steam-App (feste Einträge wie GTA V oder Overwatch 2, die die Titelsuche nicht sicher findet)
pub async fn steam_app_images(appid: &str) -> Option<(Vec<String>, Vec<String>)> {
    if appid.is_empty() || !appid.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let key = format!("steamapp:{appid}");
    let cached = CACHE.lock().get().get(&key).cloned();
    if let Some(r) = cached.as_ref().and_then(to_images) {
        return Some(r);
    }
    let mut found = steam_assets(appid).await;
    if found.is_none() {
        let (covers, wides) = steam_cdn(appid);
        if head_ok(&wides[0]).await {
            found = Some((covers, wides));
        }
    }
    if let Some(r) = &found {
        let mut c = CACHE.lock();
        let mut e = imgs_json(r);
        e["at"] = json!(now());
        c.get().insert(key, e);
        c.save();
    }
    found
}

/// Shop: Vorschaubild der offiziellen Spieleseite (og:image / twitter:image) – für Spiele, die es in keinem
/// großen Store gibt (z. B. World of Warcraft, Hearthstone, StarCraft II). Fehlschläge nur einen Tag merken.
pub async fn page_image(page: &str) -> Option<(Vec<String>, Vec<String>)> {
    if !page.starts_with("https://") {
        return None;
    }
    let key = format!("page:{page}");
    let cached = CACHE.lock().get().get(&key).cloned();
    if let Some(hit) = cached {
        if let Some(r) = to_images(&hit) {
            return Some(r);
        }
        if now() - hit["at"].as_i64().unwrap_or(0) < 24 * 3600 * 1000 {
            return None;
        }
    }
    let found = async {
        let res = crate::net::client()
            .get(page)
            .header("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
            .header("accept-language", "de-DE,de;q=0.9,en;q=0.8")
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .ok()?;
        if !res.status().is_success() {
            return None;
        }
        let html = res.text().await.ok()?;
        let img = og_image(&html)?;
        if head_ok(&img).await { Some((vec![], vec![img])) } else { None }
    }
    .await;
    let mut c = CACHE.lock();
    let mut e = found.as_ref().map(imgs_json).unwrap_or(json!({}));
    e["at"] = json!(now());
    c.get().insert(key, e);
    c.save();
    found
}

/// og:image bzw. twitter:image aus HTML (Attribute in beliebiger Reihenfolge)
pub fn og_image(html: &str) -> Option<String> {
    for tag in crate::re!(r"(?is)<meta\b[^>]*>").find_iter(html) {
        let t = tag.as_str();
        if !crate::re!(r#"(?i)(property|name)\s*=\s*["'](og:image(:secure_url)?|twitter:image(:src)?)["']"#).is_match(t) {
            continue;
        }
        let Some(c) = crate::re!(r#"(?i)content\s*=\s*["']([^"']+)["']"#).captures(t) else { continue };
        let url = c[1].trim().replace("&amp;", "&");
        let url = if url.starts_with("//") { format!("https:{url}") } else { url };
        if url.starts_with("https://") {
            return Some(url);
        }
    }
    None
}

/// Cover zu einem Spieltitel (Shop: Spiele ohne eigenes Bild); Treffer und Fehlschläge werden gemerkt
pub async fn find_by_title(title: &str) -> Option<(Vec<String>, Vec<String>)> {
    let key = format!("title:{}", title.to_lowercase());
    let cached = CACHE.lock().get().get(&key).cloned();
    if let Some(hit) = cached {
        if let Some(r) = to_images(&hit) {
            return Some(r);
        }
        if now() - hit["at"].as_i64().unwrap_or(0) < NEGATIVE_TTL {
            return None;
        }
    }
    let g = json!({ "name": title });
    let mut found = None;
    for f in [3usize, 5, 4, 2] {
        if let Some(r) = source(f, &g).await.and_then(|r| to_images(&imgs_json(&r))) {
            found = Some(r);
            break;
        }
    }
    let mut c = CACHE.lock();
    let mut e = found.as_ref().map(imgs_json).unwrap_or(json!({}));
    e["at"] = json!(now());
    c.get().insert(key, e);
    c.save();
    found
}

async fn from_ubisoft(g: &Value) -> Option<(Vec<String>, Vec<String>)> {
    let t = g["ubisoftThumb"].as_str()?;
    if head_ok(t).await { Some((vec![], vec![t.to_string()])) } else { None }
}

async fn source(i: usize, g: &Value) -> Option<(Vec<String>, Vec<String>)> {
    match i {
        0 => from_steam_app(g).await,
        1 => from_gog(g).await,
        2 => from_steamgriddb(g).await,
        3 => from_steam_store(g).await,
        4 => from_ms_store(g).await,
        5 => from_epic_store(g).await,
        _ => from_ubisoft(g).await,
    }
}

/// Anzahl der Quellen in source()
const SOURCES: usize = 7;

async fn lookup(g: &Value) -> Option<(Vec<String>, Vec<String>)> {
    for i in 0..SOURCES {
        if let Some(r) = source(i, g).await.and_then(|r| to_images(&imgs_json(&r))) {
            return Some(r);
        }
    }
    None
}

/// Cover für alle Spiele suchen (4 gleichzeitig); on_found(id, bilder) sofort bei jedem Treffer
pub async fn resolve_missing(games: Vec<Value>, on_found: Arc<dyn Fn(String, Value) + Send + Sync>) {
    let queue = Arc::new(Mutex::new(games));
    let mut workers = Vec::new();
    for _ in 0..4 {
        let q = queue.clone();
        let cb = on_found.clone();
        workers.push(tokio::spawn(async move {
            let mut n = 0;
            loop {
                let Some(g) = q.lock().pop() else { break };
                let imgs = lookup(&g).await;
                let id = g["id"].as_str().unwrap_or("").to_string();
                {
                    let mut c = CACHE.lock();
                    let mut entry = imgs.as_ref().map(imgs_json).unwrap_or(json!({}));
                    entry["at"] = json!(now());
                    c.get().insert(id.clone(), entry);
                    n += 1;
                    if n % 10 == 0 {
                        c.save();
                    }
                }
                if let Some(i) = imgs {
                    cb(id, imgs_json(&i));
                }
            }
        }));
    }
    futures::future::join_all(workers).await;
    CACHE.lock().save();
}

/// Reparatur: kein Bild hat geladen -> alle Quellen erneut, nur wirklich erreichbare Bilder nehmen
pub async fn repair(g: &Value) -> Option<Value> {
    let tried: Vec<String> = strs(&g["covers"]).into_iter().chain(strs(&g["wides"])).collect();
    let id = g["id"].as_str().unwrap_or("").to_string();
    for i in 0..SOURCES {
        let Some((cv, wd)) = source(i, g).await else { continue };
        let mut covers = vec![];
        let mut wides = vec![];
        for u in cv {
            if !tried.contains(&u) && head_ok(&u).await {
                covers.push(u);
            }
        }
        for u in wd {
            if !tried.contains(&u) && head_ok(&u).await {
                wides.push(u);
            }
        }
        if let Some(mut good) = to_images(&json!({ "covers": covers, "wides": wides })) {
            // Kein Hochformat zu finden: lieber das Querformat (zugeschnitten) als nur Initialen
            if good.0.is_empty() {
                good.0 = good.1.clone();
            }
            let mut c = CACHE.lock();
            let mut e = imgs_json(&good);
            e["repaired"] = json!(true);
            e["at"] = json!(now());
            c.get().insert(id, e);
            c.save();
            return Some(imgs_json(&good));
        }
    }
    let mut c = CACHE.lock();
    c.get().insert(id, json!({ "covers": [], "wides": [], "repaired": true, "at": now() }));
    c.save();
    None
}

// ---------- Prüfung aller Cover ----------

static URL_OK: Lazy<Mutex<HashMap<String, bool>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub fn clear_url_cache() {
    URL_OK.lock().clear();
}

pub fn custom_cover_dir() -> PathBuf {
    crate::paths::data_dir().join("custom-covers")
}

/// Lädt dieses Bild? (kennt auch ghimg://)
pub async fn cover_url_ok(url: &str) -> bool {
    if let Some(v) = URL_OK.lock().get(url) {
        return *v;
    }
    let ok = if let Some(rest) = url.strip_prefix("ghimg://steam/") {
        let mut p = rest.split('/');
        let (a, k) = (p.next().unwrap_or(""), p.next().unwrap_or(""));
        crate::providers::steam::find_cached_image(a, k).await.is_some()
    } else if let Some(rest) = url.strip_prefix("ghimg://lutris/") {
        let mut p = rest.split('/');
        let (s, k) = (p.next().unwrap_or(""), p.next().unwrap_or(""));
        crate::providers::linux::lutris_image(&urlencoding_decode(s), k).is_some()
    } else if let Some(rest) = url.strip_prefix("ghimg://custom/") {
        let name = urlencoding_decode(rest.split('?').next().unwrap_or(""));
        let base = std::path::Path::new(&name).file_name().map(|n| n.to_owned()).unwrap_or_default();
        custom_cover_dir().join(base).exists()
    } else if url.starts_with("https://") {
        match crate::net::client().head(url).timeout(Duration::from_secs(8)).send().await {
            Ok(r) => r.status().is_success() && r.headers().get("content-type").and_then(|c| c.to_str().ok()).unwrap_or("image").starts_with("image"),
            Err(_) => false,
        }
    } else {
        false
    };
    URL_OK.lock().insert(url.to_string(), ok);
    ok
}

pub fn urlencoding_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Jedes Cover prüfen, Fehlschläge reparieren, Bericht schreiben (6 gleichzeitig)
pub async fn check_all(games: Vec<Value>, on_update: Arc<dyn Fn(String, Value) + Send + Sync>) {
    const TTL: i64 = 7 * 24 * 3600 * 1000;
    let t = now();
    let state = CHECK.lock().get().clone();
    let queue = Arc::new(Mutex::new(games.clone()));
    let results: Arc<Mutex<HashMap<String, (String, String)>>> = Arc::new(Mutex::new(HashMap::new()));
    let mut workers = Vec::new();
    for _ in 0..6 {
        let (q, st, res, cb) = (queue.clone(), state.clone(), results.clone(), on_update.clone());
        workers.push(tokio::spawn(async move {
            loop {
                let Some(mut g) = q.lock().pop() else { break };
                let id = g["id"].as_str().unwrap_or("").to_string();
                let urls: Vec<String> = strs(&g["covers"]).into_iter().chain(strs(&g["wides"])).collect();
                // v2: das Hochformat-Cover muss selbst laden – ein funktionierendes Querformat reicht nicht
                // (sonst bleiben z. B. Steam-Spiele ohne alte CDN-Grafik beim Platzhalter)
                let key = format!("v3|{}", urls.join("|"));
                if let Some(prev) = st.get(&id) {
                    if prev["key"] == key.as_str() && t - prev["at"].as_i64().unwrap_or(0) < TTL {
                        res.lock().insert(id, (prev["result"].as_str().unwrap_or("ok").to_string(), key));
                        continue;
                    }
                }
                let tall = strs(&g["covers"]);
                let mut ok = false;
                for u in if tall.is_empty() { &urls } else { &tall } {
                    if cover_url_ok(u).await {
                        ok = true;
                        break;
                    }
                }
                let r = if ok {
                    "ok"
                } else if let Some(fixed) = repair(&g).await {
                    g["covers"] = fixed["covers"].clone();
                    g["wides"] = fixed["wides"].clone();
                    cb(id.clone(), fixed);
                    "repaired"
                } else if g["iconUrl"].is_string() {
                    "icon"
                } else {
                    "none"
                };
                let k2: Vec<String> = strs(&g["covers"]).into_iter().chain(strs(&g["wides"])).collect();
                res.lock().insert(id, (r.to_string(), format!("v3|{}", k2.join("|"))));
            }
        }));
    }
    futures::future::join_all(workers).await;
    let res = results.lock().clone();
    {
        let mut c = CHECK.lock();
        let m = c.get();
        for (id, (r, key)) in &res {
            m.insert(id.clone(), json!({ "key": key, "result": r, "at": t }));
        }
        c.save();
    }
    // Bericht (wie cover-report.json der Electron-Version)
    let mut report: Map<String, Value> = Map::new();
    for g in &games {
        let p = g["provider"].as_str().unwrap_or("").to_string();
        let r = report.entry(p).or_insert_with(|| json!({ "spiele": 0, "mitCover": 0, "repariert": [], "nurSymbol": [], "ohneBild": [] }));
        r["spiele"] = json!(r["spiele"].as_u64().unwrap_or(0) + 1);
        let name = g["name"].as_str().unwrap_or("").to_string();
        match res.get(g["id"].as_str().unwrap_or("")).map(|x| x.0.as_str()) {
            Some("ok") => r["mitCover"] = json!(r["mitCover"].as_u64().unwrap_or(0) + 1),
            Some("repaired") => {
                r["mitCover"] = json!(r["mitCover"].as_u64().unwrap_or(0) + 1);
                r["repariert"].as_array_mut().unwrap().push(json!(name));
            }
            Some("icon") => r["nurSymbol"].as_array_mut().unwrap().push(json!(name)),
            Some("none") => r["ohneBild"].as_array_mut().unwrap().push(json!(format!("{name} ({})", if g["status"] == "notInstalled" { "nicht installiert" } else { "installiert" }))),
            _ => {}
        }
    }
    let rep = json!({ "erstellt": chrono::Utc::now().to_rfc3339(), "launcher": report });
    let _ = std::fs::write(crate::paths::data_dir().join("cover-report.json"), serde_json::to_string_pretty(&rep).unwrap_or_default());
}

// ---------- Läuft das Spiel hier? ----------

/// { windows, mac, linux, deck } -> läuft auf os? (None = unbekannt)
pub fn runs_on(p: &Value, os: &str, provider: &str) -> Option<bool> {
    if !p.is_object() {
        return None;
    }
    let b = |k: &str| p[k].as_bool();
    match os {
        "win32" => match b("windows") { Some(false) => Some(false), Some(true) => Some(true), None => None },
        "darwin" => b("mac"),
        "linux" => {
            if b("linux") == Some(true) {
                return Some(true);
            }
            if provider != "steam" {
                return if b("windows") != Some(false) { Some(true) } else { None };
            }
            match p["deck"].as_u64() {
                Some(1) => return Some(false),
                Some(2) | Some(3) => return Some(true),
                _ => {}
            }
            if b("windows") == Some(true) { None } else if b("linux") == Some(false) { Some(false) } else { None }
        }
        _ => None,
    }
}

pub fn rate(g: &mut Value) {
    if g["status"] != "notInstalled" {
        g["runsHere"] = json!(true);
        return;
    }
    let r = runs_on(&g["platforms"], crate::ipc::platform(), g["provider"].as_str().unwrap_or(""));
    match r {
        Some(x) => g["runsHere"] = json!(x),
        None => {
            if let Some(o) = g.as_object_mut() {
                o.remove("runsHere");
            }
        }
    }
}

/// Bekannte Plattformen eintragen; liefert die Spiele, für die noch gefragt werden muss
pub fn compat_apply_cached(games: &mut [Value]) -> Vec<Value> {
    const TTL: i64 = 30 * 24 * 3600 * 1000;
    let mut c = COMPAT.lock();
    let cache = c.get().clone();
    drop(c);
    let mut missing = vec![];
    for g in games.iter_mut() {
        let prov = g["provider"].as_str().unwrap_or("");
        if g["status"] == "notInstalled" && g["platforms"].is_null() && (prov == "steam" || prov == "gog") {
            let key = format!("{prov}:{}", g["nativeId"].as_str().unwrap_or(""));
            match cache.get(&key) {
                Some(hit) if now() - hit["at"].as_i64().unwrap_or(0) < TTL => {
                    if !hit["p"].is_null() {
                        g["platforms"] = hit["p"].clone();
                    }
                }
                _ => missing.push(g.clone()),
            }
        }
        rate(g);
    }
    missing
}

async fn steam_platforms(ids: &[String]) -> Option<HashMap<String, Value>> {
    let mut out = HashMap::new();
    for chunk in ids.chunks(100) {
        let input = json!({
            "ids": chunk.iter().filter_map(|a| a.parse::<u64>().ok()).map(|a| json!({ "appid": a })).collect::<Vec<_>>(),
            "context": { "language": "english", "country_code": "US", "steam_realm": 1 },
            "data_request": { "include_platforms": true },
        });
        let d = get_json(&format!("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json={}", crate::net::enc(&input.to_string())), None).await?;
        for it in d["response"]["store_items"].as_array().cloned().unwrap_or_default() {
            let p = &it["platforms"];
            let Some(appid) = it["appid"].as_u64() else { continue };
            if !p.is_object() {
                continue;
            }
            out.insert(appid.to_string(), json!({
                "windows": p["windows"] == true, "mac": p["mac"] == true, "linux": p["steamos_linux"] == true,
                "deck": p["steam_deck_compat_category"].as_u64().unwrap_or(0),
            }));
        }
    }
    Some(out)
}

async fn gog_platforms(ids: &[String]) -> Option<HashMap<String, Value>> {
    let mut out = HashMap::new();
    for chunk in ids.chunks(50) {
        let d = get_json(&format!("https://api.gog.com/products?ids={}", chunk.join(",")), None).await?;
        for it in d.as_array().cloned().unwrap_or_default() {
            let c = &it["content_system_compatibility"];
            let id = it["id"].as_u64().map(|x| x.to_string());
            if let (Some(id), true) = (id, c.is_object()) {
                out.insert(id, json!({ "windows": c["windows"] == true, "mac": c["osx"] == true, "linux": c["linux"] == true }));
            }
        }
    }
    Some(out)
}

/// Fehlende Plattformen abfragen; on_update(spiel) für jedes geänderte Spiel
pub async fn compat_fetch_missing(missing: Vec<Value>, on_update: Arc<dyn Fn(Value) + Send + Sync>) {
    for prov in ["steam", "gog"] {
        let list: Vec<Value> = missing.iter().filter(|g| g["provider"] == prov).cloned().collect();
        if list.is_empty() {
            continue;
        }
        let ids: Vec<String> = list.iter().filter_map(|g| g["nativeId"].as_str().map(String::from)).collect();
        let found = if prov == "steam" { steam_platforms(&ids).await } else { gog_platforms(&ids).await };
        let Some(found) = found else {
            crate::log::warn(&format!("[compat] {prov} nicht erreichbar"));
            continue;
        };
        let mut changed = vec![];
        {
            let mut c = COMPAT.lock();
            let m = c.get();
            for mut g in list {
                let id = g["nativeId"].as_str().unwrap_or("").to_string();
                let p = found.get(&id).cloned().unwrap_or(Value::Null);
                m.insert(format!("{prov}:{id}"), json!({ "p": p, "at": now() }));
                if p.is_null() {
                    continue;
                }
                g["platforms"] = p;
                rate(&mut g);
                changed.push(g);
            }
            c.save();
        }
        for g in changed {
            on_update(g);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bilder_und_kompatibilitaet() {
        assert!(to_images(&json!({ "covers": [], "wides": [] })).is_none());
        assert_eq!(to_images(&json!({ "urls": ["a", "b"] })), Some((vec!["a".into()], vec!["b".into()])));
        assert_eq!(to_images(&json!({ "covers": ["a"] })), Some((vec!["a".into()], vec!["a".into()])));
        let p = json!({ "windows": true, "mac": false, "linux": false, "deck": 3 });
        assert_eq!(runs_on(&p, "win32", "steam"), Some(true));
        assert_eq!(runs_on(&p, "darwin", "steam"), Some(false));
        assert_eq!(runs_on(&p, "linux", "steam"), Some(true));
        assert_eq!(runs_on(&json!({ "windows": true }), "linux", "epic"), Some(true));
        assert_eq!(urlencoding_decode("a%20b%2Fc"), "a b/c");
    }
}

fn mime_for(p: &std::path::Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn respond(bytes: Vec<u8>, mime: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .header("content-type", mime)
        .header("access-control-allow-origin", "*")
        .header("cache-control", "max-age=300")
        .body(bytes)
        .unwrap()
}

fn not_found() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder().status(404).body(Vec::new()).unwrap()
}

fn file_response(p: Option<PathBuf>) -> Option<tauri::http::Response<Vec<u8>>> {
    let p = p?;
    let bytes = std::fs::read(&p).ok()?;
    Some(respond(bytes, mime_for(&p)))
}

/// ghimg://<quelle>/<pfad> (macOS/Linux) bzw. http://ghimg.localhost/<quelle>/<pfad> (Windows)
pub fn split_ghimg(uri: &str) -> Option<(String, String)> {
    let rest = uri.strip_prefix("ghimg://").or_else(|| uri.strip_prefix("http://ghimg.localhost/")).or_else(|| uri.strip_prefix("https://ghimg.localhost/"))?;
    let mut rest = rest.split(['?', '#']).next().unwrap_or("");
    // Windows (WebView2): Tauri reicht http://ghimg.localhost/x als ghimg://localhost/x weiter
    if let Some(r) = rest.strip_prefix("localhost/") {
        rest = r;
    }
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    Some((host.to_string(), path.to_string()))
}

#[cfg(test)]
mod ghimg_tests {
    #[test]
    fn all_url_forms() {
        for u in ["ghimg://steam/10/tall", "http://ghimg.localhost/steam/10/tall", "ghimg://localhost/steam/10/tall", "https://ghimg.localhost/steam/10/tall?x=1"] {
            assert_eq!(super::split_ghimg(u), Some(("steam".to_string(), "10/tall".to_string())), "{u}");
        }
    }
}

/// Bilder für das ghimg-Protokoll ausliefern
pub async fn serve_ghimg(uri: String) -> tauri::http::Response<Vec<u8>> {
    let Some((host, path)) = split_ghimg(&uri) else { return not_found() };
    let mut parts = path.splitn(2, '/');
    let a = urlencoding_decode(parts.next().unwrap_or(""));
    let b = parts.next().unwrap_or("").to_string();
    let res = match host.as_str() {
        "steam" => file_response(crate::providers::steam::find_cached_image(&a, &b).await),
        "riot" => {
            let id = urlencoding_decode(&path);
            if crate::re!(r"(?i)^[a-z0-9_.-]+$").is_match(&id) {
                let base = if IS_MAC { PathBuf::from("/Users/Shared") } else { { let pd = env("PROGRAMDATA"); PathBuf::from(if pd.is_empty() { "C:\\ProgramData".to_string() } else { pd }) } };
                let f = base.join("Riot Games").join("Metadata").join(&id).join(format!("{id}.ico"));
                file_response(Some(f).filter(|f| f.exists()))
            } else {
                None
            }
        }
        "lutris" => file_response(crate::providers::linux::lutris_image(&a, &b)),
        "launcher" => crate::icons::launcher_icon(&urlencoding_decode(&path)).await.map(|png| respond(png, "image/png")),
        "custom" => {
            let name = std::path::Path::new(&urlencoding_decode(&path)).file_name().map(|n| n.to_owned());
            file_response(name.map(|n| custom_cover_dir().join(n)).filter(|f| f.exists()))
        }
        "icon" => crate::icons::game_icon(&urlencoding_decode(&path)).await.map(|png| respond(png, "image/png")),
        _ => None,
    };
    res.unwrap_or_else(not_found)
}
