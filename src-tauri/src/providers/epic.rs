//! Epic Games

use async_trait::async_trait;
use base64::Engine;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::{steam::strip_nulls, Detected, Provider};
use crate::util::*;

pub fn epic_data_dir() -> PathBuf {
    if IS_MAC {
        return mac_support(&["Epic", "EpicGamesLauncher", "Data"]);
    }
    let pd = env("PROGRAMDATA");
    PathBuf::from(if pd.is_empty() { r"C:\ProgramData".to_string() } else { pd }).join("Epic").join("EpicGamesLauncher").join("Data")
}

fn catalog_paths() -> Vec<PathBuf> {
    let mut v = vec![epic_data_dir().join("Catalog").join("catcache.bin")];
    let local = env("LOCALAPPDATA");
    if !local.is_empty() {
        v.push(PathBuf::from(local).join("EpicGamesLauncher/Saved/Data/Catalog/catcache.bin"));
    }
    if IS_MAC {
        v.push(mac_support(&["Epic", "EpicGamesLauncher", "Saved", "Data", "Catalog", "catcache.bin"]));
    }
    v
}

fn images_of(item: &Value) -> (Vec<String>, Vec<String>) {
    let imgs = item["keyImages"].as_array().cloned().unwrap_or_default();
    let pick = |types: &[&str]| -> Option<String> {
        types.iter().find_map(|t| imgs.iter().find(|i| i["type"] == *t).and_then(|i| i["url"].as_str().map(String::from)))
    };
    (
        pick(&["DieselGameBoxTall", "OfferImageTall", "DieselStoreFrontTall"]).into_iter().collect(),
        pick(&["DieselGameBox", "OfferImageWide", "DieselStoreFrontWide", "Thumbnail"]).into_iter().collect(),
    )
}

fn is_game(item: &Value) -> bool {
    if item["mainGameItem"]["id"].as_str().is_some_and(|s| !s.is_empty()) {
        return false;
    }
    let cats: Vec<String> = item["categories"]
        .as_array()
        .map(|a| a.iter().map(|c| c["path"].as_str().or(c.as_str()).unwrap_or("").to_lowercase()).collect())
        .unwrap_or_default();
    if cats.iter().any(|c| c == "addons" || c.starts_with("addons/") || c == "digitalextras" || c == "plugins") {
        return false;
    }
    cats.iter().any(|c| c == "games") && !cats.iter().any(|c| c == "software")
}

#[derive(Clone)]
pub struct CatItem {
    pub item: Value,
    pub item_id: String,
    pub namespace: String,
    pub app_name: Option<String>,
    pub title: String,
    pub game: bool,
    pub covers: Vec<String>,
    pub wides: Vec<String>,
}

/// Alle Einträge aus dem lokalen Katalog-Cache (Base64-JSON)
pub async fn read_catalog() -> Vec<CatItem> {
    let mut raw = None;
    for f in catalog_paths() {
        if let Some(t) = read_text(&f).await {
            raw = Some(t);
            break;
        }
    }
    let Some(raw) = raw else { return vec![] };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(raw.trim()) else { return vec![] };
    let Ok(Value::Array(items)) = serde_json::from_slice::<Value>(&bytes) else { return vec![] };
    let clean = crate::re!(r"\?([\s:]|$)");
    items
        .into_iter()
        .filter(|it| it["id"].is_string() && it["title"].is_string())
        .map(|it| {
            let (covers, wides) = images_of(&it);
            let title = clean.replace_all(it["title"].as_str().unwrap(), "$1").trim().to_string();
            CatItem {
                item_id: it["id"].as_str().unwrap().to_string(),
                namespace: it["namespace"].as_str().unwrap_or("").to_string(),
                app_name: it["releaseInfo"].as_array().and_then(|r| r.iter().find_map(|x| x["appId"].as_str().filter(|s| !s.is_empty()).map(String::from))),
                title,
                game: is_game(&it),
                covers,
                wides,
                item: it,
            }
        })
        .collect()
}

fn platforms_of(item: &Value) -> Value {
    let list: Vec<String> = item["releaseInfo"]
        .as_array()
        .map(|r| r.iter().flat_map(|x| x["platform"].as_array().cloned().unwrap_or_default()).filter_map(|p| p.as_str().map(|s| s.to_lowercase())).collect())
        .unwrap_or_default();
    if list.is_empty() {
        return Value::Null;
    }
    json!({ "windows": list.iter().any(|x| x.starts_with("win")), "mac": list.iter().any(|x| x == "mac"), "linux": list.iter().any(|x| x == "linux") })
}

fn launcher_uri(ns: &str, item: &str, app: &str, action: &str) -> String {
    format!("com.epicgames.launcher://apps/{ns}%3A{item}%3A{app}?action={action}{}", if action == "launch" { "&silent=true" } else { "" })
}

// ---------- Update-Größe aus den Binär-Manifesten ----------

mod manifest {
    use flate2::read::ZlibDecoder;
    use std::collections::{HashMap, HashSet};
    use std::io::Read;

    const MAGIC: u32 = 0x44bec00c;

    fn u32le(d: &[u8], o: usize) -> Option<u32> {
        d.get(o..o + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap()))
    }
    fn i32le(d: &[u8], o: usize) -> Option<i32> {
        u32le(d, o).map(|x| x as i32)
    }

    fn body(file: &str) -> Option<Vec<u8>> {
        let b = std::fs::read(file).ok()?;
        if u32le(&b, 0)? != MAGIC {
            return None;
        }
        let header = u32le(&b, 4)? as usize;
        let csize = u32le(&b, 12)? as usize;
        let stored = *b.get(36)?;
        let data = b.get(header..header + csize)?;
        if stored & 1 == 1 {
            let mut out = Vec::new();
            ZlibDecoder::new(data).read_to_end(&mut out).ok()?;
            Some(out)
        } else {
            Some(data.to_vec())
        }
    }

    fn fstring(d: &[u8], o: usize) -> Option<(String, usize)> {
        let n = i32le(d, o)?;
        let o = o + 4;
        if n < 0 {
            let len = (-n as usize) * 2;
            let u: Vec<u16> = d.get(o..o + len)?.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            Some((String::from_utf16_lossy(&u).trim_end_matches('\0').to_string(), o + len))
        } else {
            let n = n as usize;
            Some((String::from_utf8_lossy(d.get(o..o + n)?).trim_end_matches('\0').to_string(), o + n))
        }
    }

    pub struct Parsed {
        chunk_size: HashMap<Vec<u8>, i64>,
        tags: Vec<Vec<String>>,
        parts: Vec<Vec<Vec<u8>>>,
    }

    pub fn parse(file: &str) -> Option<Parsed> {
        let d = body(file)?;
        let mut o = u32le(&d, 0)? as usize;
        let cdl_start = o;
        let cdl_size = u32le(&d, o)? as usize;
        let count = u32le(&d, o + 5)? as usize;
        o += 9;
        let guids: Vec<Vec<u8>> = (0..count).map(|i| d.get(o + i * 16..o + i * 16 + 16).map(|s| s.to_vec())).collect::<Option<_>>()?;
        o += 16 * count + 8 * count + 20 * count + count + 4 * count;
        let mut chunk_size = HashMap::new();
        for (i, g) in guids.iter().enumerate() {
            let v = i64::from_le_bytes(d.get(o + i * 8..o + i * 8 + 8)?.try_into().ok()?);
            chunk_size.insert(g.clone(), v);
        }
        o = cdl_start + cdl_size;
        let file_count = u32le(&d, o + 5)? as usize;
        o += 9;
        for _ in 0..2 * file_count {
            o = fstring(&d, o)?.1;
        }
        o += 21 * file_count;
        let mut tags = Vec::with_capacity(file_count);
        for _ in 0..file_count {
            let n = u32le(&d, o)? as usize;
            o += 4;
            let mut t = Vec::new();
            for _ in 0..n {
                let (s, no) = fstring(&d, o)?;
                t.push(s);
                o = no;
            }
            tags.push(t);
        }
        let mut parts = Vec::with_capacity(file_count);
        for _ in 0..file_count {
            let n = u32le(&d, o)? as usize;
            o += 4;
            let mut p = Vec::new();
            for _ in 0..n {
                let size = u32le(&d, o)? as usize;
                p.push(d.get(o + 4..o + 20)?.to_vec());
                o += size;
            }
            parts.push(p);
        }
        Some(Parsed { chunk_size, tags, parts })
    }

    /// Download-Größe alt -> neu (nur gewählte Install-Tags)
    pub fn update_size(old: Option<&str>, new: &str, selected: Option<&HashSet<String>>) -> Option<f64> {
        let next = parse(new)?;
        let prev = old.filter(|o| std::path::Path::new(o).exists()).and_then(parse);
        let wanted = |t: &Vec<String>| selected.map_or(true, |s| t.is_empty() || t.iter().any(|x| s.contains(x)));
        let mut need = HashSet::new();
        for (i, p) in next.parts.iter().enumerate() {
            if wanted(&next.tags[i]) {
                need.extend(p.iter().cloned());
            }
        }
        let mut total = 0f64;
        for g in need {
            if prev.as_ref().map_or(true, |p| !p.chunk_size.contains_key(&g)) {
                total += *next.chunk_size.get(&g).unwrap_or(&0) as f64;
            }
        }
        Some(total)
    }
}

static SIZE_CACHE: Lazy<Mutex<HashMap<String, Option<f64>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

async fn tags_from_log() -> HashMap<String, HashSet<String>> {
    let local = env("LOCALAPPDATA");
    let logs: Vec<PathBuf> = if IS_MAC {
        vec![home().join("Library/Logs/EpicGamesLauncher/EpicGamesLauncher.log"), mac_support(&["Epic", "EpicGamesLauncher", "Saved", "Logs", "EpicGamesLauncher.log"])]
    } else if local.is_empty() {
        vec![]
    } else {
        vec![PathBuf::from(local).join("EpicGamesLauncher/Saved/Logs/EpicGamesLauncher.log")]
    };
    let mut out = HashMap::new();
    for l in logs {
        if let Some(text) = read_text(&l).await {
            let re = crate::re!(r"CreateInstallRequest: (\S+) components=\d+ tags=\d+ \[([^\]]*)\]");
            for c in re.captures_iter(&text) {
                out.insert(c[1].to_string(), c[2].split(',').map(String::from).collect());
            }
            break;
        }
    }
    out
}

fn s(m: &Value, k: &str) -> String {
    m[k].as_str().unwrap_or("").to_string()
}

fn download_size(m: &Value, tags: &HashMap<String, HashSet<String>>) -> Option<f64> {
    let key = format!("{}|{}", s(m, "PendingManifestPath"), s(m, "AppVersionString"));
    if let Some(v) = SIZE_CACHE.lock().get(&key) {
        return *v;
    }
    let pending = s(m, "PendingManifestPath");
    let size = if !pending.is_empty() && std::path::Path::new(&pending).exists() {
        let app_id = format!("{}:{}:{}", s(m, "CatalogNamespace"), s(m, "CatalogItemId"), s(m, "AppName"));
        let complete = s(m, "CompleteManifestPath");
        manifest::update_size(if complete.is_empty() { None } else { Some(&complete) }, &pending, tags.get(&app_id))
    } else {
        None
    };
    SIZE_CACHE.lock().insert(key, size);
    size
}

/// Lag schon eine Version vor? (Während eines Updates liegt das .item nur unter Pending)
pub fn was_installed(m: &Value) -> bool {
    if m["CompleteVersion"].as_str().is_some_and(|v| !v.trim().is_empty()) {
        return true;
    }
    let p = s(m, "CompleteManifestPath");
    !p.is_empty() && std::path::Path::new(&p).exists()
}

async fn read_items(dir: PathBuf) -> Vec<Value> {
    let mut out = Vec::new();
    for f in list_dir(&dir).await.into_iter().filter(|f| f.to_lowercase().ends_with(".item")) {
        if let Some(m) = read_json(dir.join(&f)).await {
            if m["AppName"].is_string() {
                out.push(m);
            }
        }
    }
    out
}

/// Wartende/laufende Downloads (Manifests\Pending), pro Hauptspiel zusammengefasst
async fn pending_updates() -> HashMap<String, Value> {
    let dir = epic_data_dir().join("Manifests");
    let main = read_items(dir.clone()).await;
    let pending = read_items(dir.join("Pending")).await;
    let mut out: HashMap<String, Value> = HashMap::new();
    if pending.is_empty() && !main.iter().any(|m| m["bIsIncompleteInstall"] == true) {
        return out;
    }
    let complete: HashSet<String> = main
        .iter()
        .filter(|m| m["bIsIncompleteInstall"] != true || was_installed(m))
        .chain(pending.iter().filter(|m| was_installed(m)))
        .map(|m| s(m, "AppName"))
        .collect();
    let tags = if pending.is_empty() { HashMap::new() } else { tags_from_log().await };
    let entries: Vec<&Value> = main
        .iter()
        .filter(|m| m["bIsIncompleteInstall"] == true && !pending.iter().any(|p| p["AppName"] == m["AppName"]))
        .chain(pending.iter())
        .collect();
    let mut parts: HashMap<String, Vec<String>> = HashMap::new();
    for m in entries {
        let app = s(m, "AppName");
        let main_app = m["MainGameAppName"].as_str().filter(|x| !x.is_empty()).unwrap_or(&app).to_string();
        let is_dlc = main_app != app;
        let size = download_size(m, &tags).filter(|x| *x > 0.0).unwrap_or_else(|| {
            if complete.contains(&app) { 0.0 } else { m["InstallSize"].as_f64().or_else(|| m["InstallSize"].as_str().and_then(|x| x.parse().ok())).unwrap_or(0.0) }
        });
        let cur = out.entry(main_app.clone()).or_insert_with(|| json!({ "state": "downloading", "ioMeasure": true, "bytesTotal": 0.0 }));
        cur["bytesTotal"] = json!(cur["bytesTotal"].as_f64().unwrap_or(0.0) + size);
        parts.entry(main_app.clone()).or_default().push(if is_dlc { s(m, "DisplayName") } else { "Spiel".into() });
        if !is_dlc && !complete.contains(&app) {
            cur["firstInstall"] = json!(true);
        }
    }
    for (k, u) in out.iter_mut() {
        let p = &parts[k];
        let dlc: Vec<&String> = p.iter().filter(|x| *x != "Spiel").collect();
        if !dlc.is_empty() {
            u["detail"] = json!(if p.iter().any(|x| x == "Spiel") {
                format!("inkl. {} Zusatzinhalt{}", dlc.len(), if dlc.len() > 1 { "e" } else { "" })
            } else {
                dlc.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
            });
        }
        if u["bytesTotal"].as_f64() == Some(0.0) {
            u.as_object_mut().unwrap().remove("bytesTotal");
        }
    }
    out
}

/// Epics Download-Manager-Zustand (Format undokumentiert -> bekannte Feldnamen suchen)
pub fn read_download_state_json(data: &Value) -> HashMap<String, Value> {
    let mut out = HashMap::new();
    fn num(o: &Map<String, Value>, re: &Regex) -> Option<f64> {
        o.iter().find_map(|(k, v)| if re.is_match(k) && !v.is_boolean() { v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())) } else { None })
    }
    let re_p = crate::re!(r"(?i)^(progress|percent(age)?|downloadProgress|totalProgress)$");
    let re_d = crate::re!(r"(?i)^(bytesDownloaded|downloadedBytes|bytesDone|currentBytes|downloaded)$");
    let re_t = crate::re!(r"(?i)^(bytesTotal|totalBytes|downloadSize|totalDownloadSize|bytesToDownload)$");
    let re_s = crate::re!(r"(?i)^(downloadSpeed|downloadRate|bytesPerSecond|speed|rate)$");
    let re_e = crate::re!(r"(?i)^(eta|etaSeconds|timeRemaining|remainingTime|secondsRemaining)$");
    fn walk(v: &Value, depth: usize, f: &mut dyn FnMut(&Map<String, Value>)) {
        if depth > 6 {
            return;
        }
        match v {
            Value::Array(a) => a.iter().for_each(|x| walk(x, depth + 1, f)),
            Value::Object(o) => {
                f(o);
                for x in o.values() {
                    if x.is_object() || x.is_array() {
                        walk(x, depth + 1, f);
                    }
                }
            }
            _ => {}
        }
    }
    walk(data, 0, &mut |o| {
        let app = ["AppName", "appName", "ArtifactId", "artifactId"]
            .iter()
            .find_map(|k| o.get(*k).and_then(|v| v.as_str()).map(String::from))
            .or_else(|| ["AppId", "appId"].iter().find_map(|k| o.get(*k).and_then(|v| v.as_str()).map(|s| s.rsplit(':').next().unwrap_or("").to_string())));
        let Some(app) = app.filter(|a| !a.is_empty()) else { return };
        let mut progress = num(o, re_p);
        if let Some(p) = progress {
            if p > 1.0 {
                progress = Some(p / 100.0);
            }
        }
        let done = num(o, re_d);
        let total = num(o, re_t);
        let speed = num(o, re_s);
        let eta = num(o, re_e);
        if [progress, done, speed, eta].iter().any(|x| x.is_some()) {
            let p = progress.map(|p| p.clamp(0.0, 1.0)).or_else(|| match (total, done) {
                (Some(t), Some(d)) if t > 0.0 => Some(d / t),
                _ => None,
            });
            out.insert(app, strip_nulls(json!({ "progress": p, "bytesDone": done, "bytesTotal": total, "speed": speed, "eta": eta })));
        }
    });
    out
}

async fn download_state() -> HashMap<String, Value> {
    let dir = epic_data_dir().join("DownloadManager");
    let re = crate::re!(r"(?i)^DownloadState.*\.json$");
    let mut out = HashMap::new();
    for f in list_dir(&dir).await.into_iter().filter(|f| re.is_match(f)) {
        if let Some(j) = read_json(dir.join(&f)).await {
            out.extend(read_download_state_json(&j));
        }
    }
    out
}

pub async fn find_epic_exe() -> Option<PathBuf> {
    if IS_MAC {
        return first_existing(&[PathBuf::from("/Applications/Epic Games Launcher.app"), home().join("Applications/Epic Games Launcher.app")]).await;
    }
    let pf86 = { let x = env("ProgramFiles(x86)"); if x.is_empty() { r"C:\Program Files (x86)".to_string() } else { x } };
    let pf = { let x = env("ProgramFiles"); if x.is_empty() { r"C:\Program Files".to_string() } else { x } };
    let rel = r"Epic Games\Launcher\Portal\Binaries";
    first_existing(&[
        PathBuf::from(&pf86).join(rel).join(r"Win64\EpicGamesLauncher.exe"),
        PathBuf::from(&pf86).join(rel).join(r"Win32\EpicGamesLauncher.exe"),
        PathBuf::from(&pf).join(rel).join(r"Win64\EpicGamesLauncher.exe"),
    ])
    .await
}

pub struct Epic;

#[async_trait]
impl Provider for Epic {
    fn id(&self) -> &str { "epic" }
    fn name(&self) -> &str { "Epic Games" }
    fn color(&self) -> &str { "#2a2a2a" }
    fn accent(&self) -> &str { "#f5f5f5" }
    fn platforms(&self) -> &[&str] { &["win32", "darwin"] }
    fn processes(&self) -> &[&str] { &["EpicGamesLauncher", "EpicWebHelper"] }
    fn processes_mac(&self) -> &[&str] { &["EpicGamesLauncher", "Epic Games Launcher", "EpicWebHelper"] }

    async fn detect(&self) -> anyhow::Result<Detected> {
        let dir = epic_data_dir().join("Manifests");
        let catalog = read_catalog().await;
        let by_item: HashMap<&str, &CatItem> = catalog.iter().map(|c| (c.item_id.as_str(), c)).collect();
        let by_app: HashMap<&str, &CatItem> = catalog.iter().filter_map(|c| c.app_name.as_deref().map(|a| (a, c))).collect();
        let pending = pending_updates().await;

        let mut items = read_items(dir.clone()).await;
        let mut have: HashSet<String> = items.iter().map(|m| s(m, "AppName")).collect();
        for m in read_items(dir.join("Pending")).await {
            let app = s(&m, "AppName");
            if !have.contains(&app) && was_installed(&m) {
                have.insert(app);
                items.push(m);
            }
        }
        let mut games = Vec::new();
        let mut installed_apps = HashSet::new();
        let mut installed_names = HashSet::new();
        for m in &items {
            let app = s(m, "AppName");
            if let Some(main) = m["MainGameAppName"].as_str() {
                if !main.is_empty() && main != app {
                    continue;
                }
            }
            let cats: Vec<String> = m["AppCategories"].as_array().map(|a| a.iter().filter_map(|c| c.as_str().map(|x| x.to_lowercase())).collect()).unwrap_or_default();
            if !cats.is_empty() && !cats.iter().any(|c| c == "games" || c == "applications") {
                continue;
            }
            if cats.iter().any(|c| c == "addons" || c == "plugins") {
                continue;
            }
            let ns = m["CatalogNamespace"].as_str().or(m["MainGameCatalogNamespace"].as_str()).unwrap_or("").to_string();
            let item = m["CatalogItemId"].as_str().or(m["MainGameCatalogItemId"].as_str()).unwrap_or("").to_string();
            let cat = by_item.get(item.as_str()).or_else(|| by_app.get(app.as_str()));
            installed_apps.insert(app.clone());
            if !item.is_empty() {
                installed_apps.insert(item.clone());
            }
            let name = m["DisplayName"].as_str().filter(|x| !x.is_empty()).unwrap_or(&app).to_string();
            installed_names.insert(normalize(&name));
            let target = if !ns.is_empty() && !item.is_empty() {
                launcher_uri(&ns, &item, &app, "launch")
            } else {
                format!("com.epicgames.launcher://apps/{app}?action=launch&silent=true")
            };
            let size = m["InstallSize"].as_f64().filter(|x| *x > 0.0);
            games.push(strip_nulls(json!({
                "nativeId": app, "epicItem": if item.is_empty() { Value::Null } else { json!(item) }, "name": name,
                "installDir": m["InstallLocation"], "sizeBytes": size, "status": "installed",
                "update": pending.get(&app).cloned().unwrap_or(Value::Null),
                "covers": cat.map(|c| c.covers.clone()).unwrap_or_default(), "wides": cat.map(|c| c.wides.clone()).unwrap_or_default(),
                "launch": uri(target),
            })));
            // "update": null soll erhalten bleiben (Oberfläche erwartet das Feld)
            if let Some(g) = games.last_mut() {
                if g.get("update").is_none() {
                    g["update"] = Value::Null;
                }
            }
        }
        let test = crate::re!(r"(?i)(\bbeta\b|experimental|playtest|public test|test server)");
        let mut seen = HashSet::new();
        for c in &catalog {
            let Some(app) = &c.app_name else { continue };
            if !c.game || c.namespace.is_empty() || test.is_match(&c.title) {
                continue;
            }
            if installed_apps.contains(app) || installed_apps.contains(&c.item_id) {
                continue;
            }
            let key = normalize(&c.title);
            if installed_names.contains(&key) || !seen.insert(key) {
                continue;
            }
            games.push(strip_nulls(json!({
                "nativeId": app, "epicItem": c.item_id, "name": c.title, "status": "notInstalled",
                "platforms": platforms_of(&c.item), "covers": c.covers, "wides": c.wides,
                "launch": uri(launcher_uri(&c.namespace, &c.item_id, app, "install")),
            })));
        }
        Ok(games.into())
    }

    async fn updates(&self) -> Option<Vec<Value>> {
        let pending = pending_updates().await;
        let live = if pending.is_empty() { HashMap::new() } else { download_state().await };
        Some(
            pending
                .into_iter()
                .map(|(id, mut u)| {
                    if let Some(l) = live.get(&id) {
                        for (k, v) in l.as_object().unwrap() {
                            u[k] = v.clone();
                        }
                        u["source"] = json!("Epic");
                        if l.get("progress").is_some() || l.get("bytesDone").is_some() {
                            u.as_object_mut().unwrap().remove("ioMeasure");
                        }
                    }
                    json!({ "nativeId": id, "update": u })
                })
                .collect(),
        )
    }

    async fn client(&self) -> Option<Value> {
        exe_launch(find_epic_exe().await.as_deref(), &[]).or_else(|| Some(uri("com.epicgames.launcher://store")))
    }
    fn store(&self) -> Option<Value> {
        Some(uri("com.epicgames.launcher://store"))
    }
    fn has_background_update(&self) -> bool {
        true
    }
    async fn background_update(&self, _game: &Value) -> Option<Value> {
        exe_launch(find_epic_exe().await.as_deref(), if IS_MAC { &[] } else { &["-silent"] })
    }
    fn update_page(&self, game: &Value) -> Option<Value> {
        Some(uri(game["launch"]["target"].as_str().unwrap_or("").replace("&silent=true", "")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_state_felder() {
        let j = json!({ "Downloads": [{ "AppName": "Fortnite", "Progress": 45, "BytesDownloaded": 10, "TotalBytes": 100, "DownloadRate": 5 }] });
        let m = read_download_state_json(&j);
        assert_eq!(m["Fortnite"]["progress"], 0.45);
        assert_eq!(m["Fortnite"]["speed"], 5.0);
    }

    #[test]
    fn war_installiert() {
        assert!(was_installed(&json!({ "CompleteVersion": "1.0" })));
        assert!(!was_installed(&json!({ "CompleteVersion": " " })));
    }
}
