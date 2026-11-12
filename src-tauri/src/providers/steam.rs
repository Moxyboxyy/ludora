//! Steam
//! Installiert: libraryfolders.vdf + appmanifest_*.acf; Bibliothek: lokaler Cache (appinfo.vdf,
//! librarycache, localconfig.vdf) oder – mit API-Key – die Steam Web API.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use super::{Detected, Provider};
use crate::util::*;
use crate::vdf::{self, get_ci, get_str};

const IGNORED_APPIDS: [&str; 8] = ["228980", "1070560", "1391110", "1628350", "250820", "1493710", "2180100", "2348590"];
static IGNORED_NAME: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^(Steamworks|Proton|Steam Linux Runtime|SteamVR)").unwrap());
static TEST_APP: Lazy<Regex> = Lazy::new(|| {
    crate::re!(r"(?i)(public test|test server|\bpts\b|playtest|\bbeta\b|unstable|experimental|dedicated server)").clone()
});
pub const STEAMID64_BASE: u64 = 76561197960265728;

static STEAM_PATH: Lazy<Mutex<Option<Option<PathBuf>>>> = Lazy::new(|| Mutex::new(None));

pub async fn find_steam_path() -> Option<PathBuf> {
    if let Some(c) = STEAM_PATH.lock().clone() {
        return c;
    }
    let found = if !IS_WIN {
        let h = home();
        let candidates = if IS_MAC {
            vec![mac_support(&["Steam"])]
        } else {
            vec![
                h.join(".steam").join("steam"),
                h.join(".local").join("share").join("Steam"),
                h.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"),
            ]
        };
        let mut f = None;
        for c in candidates {
            if exists(c.join("steamapps")).await {
                f = Some(c);
                break;
            }
        }
        f
    } else {
        let p = crate::reg::get_first_string(&[
            (r"HKCU\Software\Valve\Steam", "SteamPath"),
            (r"HKLM\SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
            (r"HKLM\SOFTWARE\Valve\Steam", "InstallPath"),
        ]);
        match p {
            Some(p) => Some(norm_path(&p)),
            None => {
                let fb = PathBuf::from(r"C:\Program Files (x86)\Steam");
                if exists(&fb).await { Some(fb) } else { None }
            }
        }
    };
    *STEAM_PATH.lock() = Some(found.clone());
    found
}

pub async fn library_folders(steam: &Path) -> Vec<PathBuf> {
    let mut folders = vec![steam.join("steamapps")];
    if let Some(text) = read_text(steam.join("steamapps").join("libraryfolders.vdf")).await {
        let v = vdf::parse(&text);
        if let Some(root) = get_ci(&v, "libraryfolders").and_then(|r| r.as_object()) {
            for entry in root.values() {
                let p = match entry {
                    Value::String(s) => Some(s.clone()),
                    other => get_str(other, "path"),
                };
                if let Some(p) = p.filter(|p| p.contains('/') || p.contains('\\')) {
                    let f = norm_path(&p).join("steamapps");
                    if !folders.contains(&f) {
                        folders.push(f);
                    }
                }
            }
        }
    }
    folders
}

/// SteamID64 des zuletzt angemeldeten Kontos (loginusers.vdf)
pub async fn find_steam_id(steam: &Path) -> Option<String> {
    let text = read_text(steam.join("config").join("loginusers.vdf")).await?;
    let v = vdf::parse(&text);
    let users = get_ci(&v, "users")?.as_object()?;
    users
        .iter()
        .find(|(_, u)| get_str(u, "MostRecent").as_deref() == Some("1"))
        .map(|(k, _)| k.clone())
        .or_else(|| users.keys().next().cloned())
}

// ---------- Bilder aus Steams Cache ----------

fn image_files(kind: &str) -> &'static [&'static str] {
    match kind {
        "tall" => &["library_600x900_2x.jpg", "library_600x900.jpg", "library_capsule.jpg"],
        "wide" => &["header.jpg", "library_header.jpg", "library_hero.jpg"],
        _ => &[],
    }
}

/// Pfad zu einem gecachten Bild (librarycache/<id>_x.jpg oder librarycache/<id>/[<hash>/]x.jpg)
pub async fn find_cached_image(appid: &str, kind: &str) -> Option<PathBuf> {
    let steam = find_steam_path().await?;
    if !appid.chars().all(|c| c.is_ascii_digit()) || image_files(kind).is_empty() {
        return None;
    }
    let cache = steam.join("appcache").join("librarycache");
    let dir = cache.join(appid);
    for name in image_files(kind) {
        let flat = cache.join(format!("{appid}_{name}"));
        if exists(&flat).await {
            return Some(flat);
        }
        let direct = dir.join(name);
        if exists(&direct).await {
            return Some(direct);
        }
    }
    for sub in list_dir(&dir).await {
        for name in image_files(kind) {
            let p = dir.join(&sub).join(name);
            if exists(&p).await {
                return Some(p);
            }
        }
    }
    None
}

fn steam_covers(appid: &str) -> (Value, Value) {
    (
        json!([format!("ghimg://steam/{appid}/tall"), format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_600x900.jpg")]),
        json!([format!("ghimg://steam/{appid}/wide"), format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/header.jpg")]),
    )
}

// ---------- Bibliothek ohne API-Key ----------

async fn read_local_config(steam: &Path, steam_id: &str) -> Map<String, Value> {
    let Ok(id) = steam_id.parse::<u64>() else { return Map::new() };
    let account = id.saturating_sub(STEAMID64_BASE);
    let Some(text) = read_text(steam.join("userdata").join(account.to_string()).join("config").join("localconfig.vdf")).await else {
        return Map::new();
    };
    let v = vdf::parse(&text);
    vdf::path(&v, &["UserLocalConfigStore", "Software", "Valve", "Steam", "apps"])
        .and_then(|a| a.as_object().cloned())
        .unwrap_or_default()
}

async fn owned_from_local_cache(steam: &Path, local_apps: &Map<String, Value>) -> anyhow::Result<Vec<(String, String, Option<u64>, Option<u64>)>> {
    let mut ids: HashSet<String> = HashSet::new();
    let re = crate::re!(r"^(\d+)(?:_|$)");
    for e in list_dir(steam.join("appcache").join("librarycache")).await {
        if let Some(c) = re.captures(&e) {
            ids.insert(c[1].to_string());
        }
    }
    ids.extend(local_apps.keys().cloned());
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let bytes = tokio::fs::read(steam.join("appcache").join("appinfo.vdf")).await?;
    let info = tokio::task::spawn_blocking(move || vdf::read_app_info(&bytes, Some(&ids)))
        .await?
        .map_err(anyhow::Error::msg)?;
    let mut out: Vec<_> = info
        .into_iter()
        .filter(|(_, i)| i.kind == "game" && !i.name.is_empty())
        .map(|(id, i)| (id, i.name, None, None))
        .collect();
    // Aufsteigend nach App-ID wie in der Electron-Version: bei gleichem Namen (z. B. alte und neue
    // Ausgabe) gewinnt dann dieselbe App-ID
    out.sort_by_key(|(id, ..)| id.parse::<u64>().unwrap_or(u64::MAX));
    Ok(out)
}

// ---------- Bibliothek mit API-Key ----------

async fn owned_from_api(key: &str, steam_id: &str) -> anyhow::Result<Vec<(String, String, Option<u64>, Option<u64>)>> {
    let url = format!(
        "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key={}&steamid={}&include_appinfo=1&include_played_free_games=1&format=json",
        crate::net::enc(key),
        crate::net::enc(steam_id)
    );
    let res = crate::net::client()
        .get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| anyhow::anyhow!(t_args("Steam-API nicht erreichbar ({0})", &[&if e.is_timeout() { t("Zeitüberschreitung") } else { e.to_string() }])))?;
    let st = res.status().as_u16();
    if st == 401 || st == 403 {
        anyhow::bail!(t("Steam-API-Key ungültig"));
    }
    if !res.status().is_success() {
        anyhow::bail!(t_args("Steam-API antwortet mit Fehler {0}", &[&st.to_string()]));
    }
    let j: Value = res.json().await?;
    let Some(list) = j["response"]["games"].as_array() else {
        anyhow::bail!(t("Keine Spiele von Steam erhalten – Spieldetails im Profil auf privat?"));
    };
    Ok(list
        .iter()
        .map(|g| {
            (
                g["appid"].as_u64().map(|x| x.to_string()).unwrap_or_default(),
                g["name"].as_str().unwrap_or("").to_string(),
                g["playtime_forever"].as_u64().filter(|x| *x > 0),
                g["rtime_last_played"].as_u64().filter(|x| *x > 0),
            )
        })
        .collect())
}

// ---------- Updates & Downloads ----------

const F_UPDATE_REQUIRED: u64 = 2;
const F_FULLY_INSTALLED: u64 = 4;
const F_UPDATE_RUNNING: u64 = 256;
const F_UPDATE_PAUSED: u64 = 512;
const F_UPDATE_STARTED: u64 = 1024;

/// Update-Zustand aus einem appmanifest (None = aktuell)
pub fn update_state(state: &Value) -> Value {
    let flags: u64 = get_str(state, "StateFlags").and_then(|s| s.parse().ok()).unwrap_or(0);
    let total: f64 = get_str(state, "BytesToDownload").and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let done: f64 = get_str(state, "BytesDownloaded").and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let progress = if total > 0.0 { json!((done / total).min(1.0)) } else { Value::Null };
    let installing = flags & F_FULLY_INSTALLED == 0;
    let mk = |st: &str| {
        let mut o = json!({ "state": st, "bytesDone": done, "bytesTotal": total, "firstInstall": installing });
        if !progress.is_null() {
            o["progress"] = progress.clone();
        }
        o
    };
    if flags & (F_UPDATE_RUNNING | F_UPDATE_STARTED) != 0 {
        return mk("downloading");
    }
    if flags & F_UPDATE_PAUSED != 0 {
        return mk("paused");
    }
    if flags & F_UPDATE_REQUIRED != 0 || (total > 0.0 && done < total) {
        return mk(if installing { "queued" } else { "available" });
    }
    Value::Null
}

pub async fn read_manifests(steam: &Path) -> Vec<(PathBuf, Value)> {
    let mut out = Vec::new();
    let re = crate::re!(r"(?i)^appmanifest_\d+\.acf$");
    for lib in library_folders(steam).await {
        for f in list_dir(&lib).await.into_iter().filter(|f| re.is_match(f)) {
            let Some(text) = read_text(lib.join(&f)).await else { continue };
            if let Some(st) = get_ci(&vdf::parse(&text), "AppState") {
                out.push((lib.clone(), st.clone()));
            }
        }
    }
    out
}

/// Pausiert Steam andere Downloads, solange dieses Spiel läuft? Pro Spiel (Eigenschaften → Updates →
/// Hintergrund-Downloads: 0 = wie global, 1 = immer erlauben, 2 = nie erlauben), sonst die globale Einstellung
/// „Downloads während des Spielens erlauben“ (config/config.vdf, fehlt = aus – Steams Voreinstellung).
/// Rückgabe: None = Steam lädt weiter, Some(true) = wegen der Einstellung des Spiels, Some(false) = wegen der globalen
pub async fn pauses_downloads_while(appid: &str) -> Option<bool> {
    let steam = find_steam_path().await?;
    let per_game = read_manifests(&steam)
        .await
        .into_iter()
        .find(|(_, m)| get_str(m, "appid").as_deref() == Some(appid))
        .and_then(|(_, m)| get_str(&m, "AllowOtherDownloadsWhileRunning"));
    match per_game.as_deref() {
        Some("1") => None,
        Some("2") => Some(true),
        _ => {
            let text = read_text(steam.join("config").join("config.vdf")).await;
            let allowed = text.map(|t| allows_downloads_during_gameplay(&vdf::parse(&t))).unwrap_or(false);
            if allowed { None } else { Some(false) }
        }
    }
}

/// Globale Steam-Einstellung „Downloads während des Spielens erlauben“ (irgendwo unter InstallConfigStore)
pub fn allows_downloads_during_gameplay(config: &Value) -> bool {
    fn find<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
        let o = v.as_object()?;
        o.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v).or_else(|| o.values().find_map(|c| find(c, key)))
    }
    find(config, "AllowDownloadsDuringGameplay").and_then(|v| v.as_str()) == Some("1")
}

/// Auswertung von logs/content_log.txt (Steams eigene Download-Rate, Zustände)
#[derive(Default, Debug)]
pub struct LogInfo {
    pub speed: Option<f64>,
    pub appid: Option<String>,
    pub bytes_done: Option<f64>,
    pub bytes_total: Option<f64>,
    pub finished: bool,
    pub states: HashMap<String, String>,
}

static PROGRESS_MEMO: Lazy<Mutex<Vec<(String, f64)>>> = Lazy::new(|| Mutex::new(Vec::new()));

fn log_ts(l: &str) -> Option<i64> {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\]").unwrap());
    let c = RE.captures(l)?;
    use chrono::TimeZone;
    let n = |i: usize| c[i].parse::<u32>().ok();
    let dt = chrono::Local
        .with_ymd_and_hms(c[1].parse().ok()?, n(2)?, n(3)?, n(4)?, n(5)?, n(6)?)
        .single()?;
    Some(dt.timestamp_millis())
}

pub fn parse_content_log(text: &str, now: i64) -> LogInfo {
    static START: Lazy<Regex> = Lazy::new(|| Regex::new(r"AppID (\d+) update started : download (\d+)/(\d+)").unwrap());
    static STATE: Lazy<Regex> = Lazy::new(|| Regex::new(r"AppID (\d+) state changed : (.*)$").unwrap());
    static STATS: Lazy<Regex> = Lazy::new(|| Regex::new(r"stats: \(.*?\) .*?: (\d+) Bytes, (\d+) sec").unwrap());
    static RATE: Lazy<Regex> = Lazy::new(|| Regex::new(r"Current download rate: ([\d.]+) Mbps").unwrap());

    let lines: Vec<&str> = text.lines().collect();
    let mut info = LogInfo::default();
    let mut start_idx: Option<usize> = None;
    let mut total = 0f64;
    let mut initial = 0f64;
    for i in (0..lines.len()).rev() {
        if let Some(c) = START.captures(lines[i]) {
            start_idx = Some(i);
            info.appid = Some(c[1].to_string());
            initial = c[2].parse().unwrap_or(0.0);
            total = c[3].parse().unwrap_or(0.0);
            break;
        }
    }
    for l in &lines {
        if let Some(c) = STATE.captures(l) {
            info.states.insert(c[1].to_string(), c[2].to_string());
        }
    }
    let fin_re = info
        .appid
        .as_ref()
        .and_then(|a| Regex::new(&format!(r"AppID {a} (finished update|scheduler finished|update canceled|finished uninstall)")).ok());

    let mut done = initial;
    let mut batches: HashMap<i64, (f64, f64)> = HashMap::new();
    let from = start_idx.unwrap_or(0);
    for l in &lines[from..] {
        if start_idx.is_some() {
            if let Some(re) = &fin_re {
                if re.is_match(l) {
                    info.finished = true;
                }
            }
        }
        let Some(c) = STATS.captures(l) else { continue };
        let bytes: f64 = c[1].parse().unwrap_or(0.0);
        if start_idx.is_some() {
            done += bytes;
        }
        if let Some(ts) = log_ts(l) {
            let b = batches.entry(ts).or_insert((0.0, 0.0));
            b.0 += bytes;
            b.1 = b.1.max(c[2].parse().unwrap_or(0.0));
        }
    }

    // Geladene Bytes zusätzlich aus den Minuten-Raten hochrechnen
    let mut integrated = 0f64;
    let mut last_rate = 0f64;
    if let Some(si) = start_idx {
        if let Some(mut prev) = log_ts(lines[si]) {
            for l in &lines[si + 1..] {
                let Some(c) = RATE.captures(l) else { continue };
                let Some(ts) = log_ts(l) else { continue };
                if ts < prev {
                    continue;
                }
                last_rate = c[1].parse::<f64>().unwrap_or(0.0) * 1e6 / 8.0;
                integrated += last_rate * ((ts - prev) as f64 / 1000.0);
                prev = ts;
            }
            if !info.finished {
                integrated += last_rate * ((now - prev).clamp(0, 70_000) as f64 / 1000.0);
            }
        }
    }
    done = done.max(initial + integrated);
    if !info.finished && total > 0.0 {
        done = done.min(total * 0.99);
    }

    // Geschwindigkeit: jüngste Statistik-Runde, sonst "Current download rate"
    let last_t = batches.keys().copied().max().unwrap_or(0);
    if last_t > 0 && now - last_t < 90_000 {
        let (b, s) = batches[&last_t];
        info.speed = if s > 0.0 { Some(b / s) } else { None };
    }
    if info.speed.is_none() {
        for l in lines.iter().rev() {
            let Some(c) = RATE.captures(l) else { continue };
            let ts = log_ts(l);
            info.speed = Some(match ts {
                Some(ts) if now - ts < 150_000 => c[1].parse::<f64>().unwrap_or(0.0) * 1e6 / 8.0,
                _ => 0.0,
            });
            break;
        }
    }
    // Nie rückwärts
    if let Some(si) = start_idx {
        let key = format!("{}@{}", info.appid.clone().unwrap_or_default(), lines[si].chars().take(21).collect::<String>());
        let mut memo = PROGRESS_MEMO.lock();
        if let Some((_, v)) = memo.iter().find(|(k, _)| *k == key) {
            done = done.max(*v);
        }
        memo.retain(|(k, _)| *k != key);
        memo.push((key, done));
        if memo.len() > 20 {
            memo.remove(0);
        }
        if total > 0.0 {
            info.bytes_done = Some(done.min(total));
        }
    }
    if total > 0.0 {
        info.bytes_total = Some(total);
    }
    info
}

async fn steam_log_info(steam: &Path) -> LogInfo {
    let file = steam.join("logs").join("content_log.txt");
    let res = tokio::task::spawn_blocking(move || -> Option<String> {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(file).ok()?;
        let size = f.metadata().ok()?.len();
        let len = size.min(256 * 1024);
        f.seek(SeekFrom::Start(size - len)).ok()?;
        let mut buf = vec![0u8; len as usize];
        f.read_exact(&mut buf).ok()?;
        Some(String::from_utf8_lossy(&buf).into_owned())
    })
    .await
    .ok()
    .flatten();
    match res {
        Some(t) => parse_content_log(&t, chrono::Utc::now().timestamp_millis()),
        None => LogInfo::default(),
    }
}

/// Nur Update-Zustände (für die Download-Ansicht)
pub async fn updates() -> Vec<Value> {
    let Some(steam) = find_steam_path().await else { return vec![] };
    let raw: Vec<(String, Value)> = read_manifests(&steam)
        .await
        .into_iter()
        .map(|(_, st)| (get_str(&st, "appid").unwrap_or_default(), update_state(&st)))
        .filter(|(_, u)| !u.is_null())
        .collect();
    if raw.is_empty() {
        return vec![];
    }
    let log = steam_log_info(&steam).await;
    let fully_installed_only = crate::re!(r"^Fully Installed,?\s*$");
    let mut list: Vec<(String, Value)> = Vec::new();
    for (id, mut u) in raw {
        if let Some(st) = log.states.get(&id) {
            if (st.contains("Uninstalled") || st.contains("Uninstalling")) && !st.contains("Fully Installed") {
                continue;
            }
            if u["state"] == "downloading" && !st.contains("Update Running") {
                u["state"] = json!(if st.contains("Update Paused") || st.contains("Suspended") || st.contains("Canceled") {
                    "paused"
                } else if st.contains("Update Queued") {
                    "queued"
                } else {
                    "available"
                });
            }
            if fully_installed_only.is_match(st.trim()) {
                continue;
            }
        }
        list.push((id, u));
    }
    let running: Vec<usize> = list.iter().enumerate().filter(|(_, (_, u))| u["state"] == "downloading").map(|(i, _)| i).collect();
    if !running.is_empty() {
        let ti = running.iter().copied().find(|&i| Some(&list[i].0) == log.appid.as_ref()).unwrap_or(running[0]);
        let (id, orig) = list[ti].clone();
        let mut u = orig.clone();
        if log.appid.as_ref() == Some(&id) && !log.finished {
            if let Some(bt) = log.bytes_total {
                u["bytesTotal"] = json!(bt);
                let same = orig["bytesTotal"].as_f64() == Some(bt);
                let done = log.bytes_done.unwrap_or(0.0).max(if same { orig["bytesDone"].as_f64().unwrap_or(0.0) } else { 0.0 });
                u["bytesDone"] = json!(done);
                u["progress"] = json!((done / bt).min(1.0));
            }
        }
        if let Some(sp) = log.speed {
            let remaining = u["bytesTotal"].as_f64().map(|t| (t - u["bytesDone"].as_f64().unwrap_or(0.0)).max(0.0));
            u["speed"] = json!(sp);
            u["eta"] = match remaining {
                Some(r) if sp > 0.0 => json!(r / sp),
                _ => Value::Null,
            };
            u["source"] = json!("Steam");
        }
        list[ti].1 = u;
    }
    list.into_iter().map(|(id, u)| json!({ "nativeId": id, "update": u })).collect()
}

pub async fn find_steam_exe() -> Option<PathBuf> {
    if IS_MAC {
        let p = PathBuf::from("/Applications/Steam.app");
        return if exists(&p).await { Some(p) } else { None };
    }
    if !IS_WIN {
        return None;
    }
    let exe = find_steam_path().await?.join("steam.exe");
    if exists(&exe).await { Some(exe) } else { None }
}

pub struct Steam;

#[async_trait]
impl Provider for Steam {
    fn id(&self) -> &str { "steam" }
    fn name(&self) -> &str { "Steam" }
    fn color(&self) -> &str { "#1b2838" }
    fn accent(&self) -> &str { "#66c0f4" }
    fn platforms(&self) -> &[&str] { &["win32", "darwin", "linux"] }
    fn processes(&self) -> &[&str] { &["steam", "steamwebhelper"] }
    fn processes_mac(&self) -> &[&str] { &["Steam", "steam_osx", "Steam Helper"] }

    async fn detect(&self) -> anyhow::Result<Detected> {
        *STEAM_PATH.lock() = None;
        let Some(steam) = find_steam_path().await else { return Ok(Detected::default()) };
        let exe = find_steam_exe().await;
        let mut games: Vec<(String, Value)> = Vec::new();
        for (lib, st) in read_manifests(&steam).await {
            let appid = get_str(&st, "appid").unwrap_or_default();
            let name = get_str(&st, "name").unwrap_or_else(|| format!("App {appid}"));
            if IGNORED_APPIDS.contains(&appid.as_str()) || IGNORED_NAME.is_match(&name) || games.iter().any(|(i, _)| *i == appid) {
                continue;
            }
            let (covers, wides) = steam_covers(&appid);
            let launch = match (&exe, IS_WIN) {
                (Some(e), true) => exe_launch(Some(e), &["-silent", "-applaunch", &appid]).unwrap(),
                _ => uri(format!("steam://rungameid/{appid}")),
            };
            let size = get_str(&st, "SizeOnDisk").and_then(|s| s.parse::<u64>().ok()).filter(|x| *x > 0);
            games.push((appid.clone(), json!({
                "nativeId": appid, "name": name,
                "installDir": lib.join("common").join(get_str(&st, "installdir").unwrap_or_default()).to_string_lossy(),
                "sizeBytes": size, "status": "installed", "update": update_state(&st),
                "covers": covers, "wides": wides, "launch": launch,
            })));
        }

        let configured = crate::settings::get_str("steamId", "").trim().to_string();
        let steam_id = if configured.is_empty() { find_steam_id(&steam).await.unwrap_or_default() } else { configured };
        let local_apps = read_local_config(&steam, &steam_id).await;
        let stats = |appid: &str| -> (Option<u64>, Option<u64>) {
            let Some(a) = local_apps.get(appid) else { return (None, None) };
            let min = get_str(a, "Playtime").or_else(|| get_str(a, "playtime")).and_then(|s| s.parse::<u64>().ok()).filter(|x| *x > 0);
            let last = get_str(a, "LastPlayed").and_then(|s| s.parse::<u64>().ok()).filter(|x| *x > 0);
            (min, last)
        };

        let mut warning = None;
        let key = crate::settings::get_str("steamApiKey", "").trim().to_string();
        let owned = if !key.is_empty() && !steam_id.is_empty() {
            match owned_from_api(&key, &steam_id).await {
                Ok(o) => o,
                Err(e) => {
                    warning = Some(e.to_string());
                    owned_from_local_cache(&steam, &local_apps).await.unwrap_or_default()
                }
            }
        } else {
            match owned_from_local_cache(&steam, &local_apps).await {
                Ok(o) => o,
                Err(e) => {
                    warning = Some(e.to_string());
                    vec![]
                }
            }
        };

        for (id, g) in games.iter_mut() {
            let (m, l) = stats(id);
            if let Some(m) = m { g["playtimeMin"] = json!(m); }
            if let Some(l) = l { g["lastPlayed"] = json!(l); }
        }
        for (appid, name, play, last) in owned {
            if let Some((_, g)) = games.iter_mut().find(|(i, _)| *i == appid) {
                if let Some(p) = play { g["playtimeMin"] = json!(p); }
                if let Some(l) = last { g["lastPlayed"] = json!(l); }
                continue;
            }
            if IGNORED_APPIDS.contains(&appid.as_str()) || IGNORED_NAME.is_match(&name) || TEST_APP.is_match(&name) {
                continue;
            }
            let (covers, wides) = steam_covers(&appid);
            let (m, l) = stats(&appid);
            let mut g = json!({
                "nativeId": appid, "name": if name.is_empty() { format!("App {appid}") } else { name.clone() },
                "status": "notInstalled", "covers": covers, "wides": wides,
                "launch": uri(format!("steam://install/{appid}")),
            });
            if let Some(x) = play.or(m) { g["playtimeMin"] = json!(x); }
            if let Some(x) = last.or(l) { g["lastPlayed"] = json!(x); }
            games.push((appid, g));
        }
        Ok(Detected { games: games.into_iter().map(|(_, g)| strip_nulls(g)).collect(), warning })
    }

    async fn updates(&self) -> Option<Vec<Value>> {
        Some(updates().await)
    }

    async fn client(&self) -> Option<Value> {
        exe_launch(find_steam_exe().await.as_deref(), &[]).or_else(|| Some(uri("steam://open/main")))
    }
    fn store(&self) -> Option<Value> {
        Some(uri("steam://store"))
    }
    fn has_background_update(&self) -> bool {
        true
    }
    /// Steam nur im Tray starten
    async fn background_update(&self, _game: &Value) -> Option<Value> {
        let exe = find_steam_exe().await;
        if IS_WIN {
            exe_launch(exe.as_deref(), &["-silent"])
        } else if exe.is_some() {
            exe_launch(exe.as_deref(), &[])
        } else {
            Some(uri("steam://open/downloads"))
        }
    }
    fn update_page(&self, game: &Value) -> Option<Value> {
        Some(uri(format!("steam://nav/games/details/{}", game["nativeId"].as_str().unwrap_or(""))))
    }
    async fn downloads_page(&self, _game: &Value) -> Option<Value> {
        Some(uri("steam://open/downloads"))
    }
    fn uninstall(&self, game: &Value) -> Option<Value> {
        Some(uri(format!("steam://uninstall/{}", game["nativeId"].as_str().unwrap_or(""))))
    }
}

/// null-Felder entfernen (wie undefined in JS – die Oberfläche prüft oft auf Vorhandensein)
pub fn strip_nulls(mut v: Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.retain(|_, x| !x.is_null());
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_beim_spielen() {
        let cfg = |v: &str| vdf::parse(&format!("\"InstallConfigStore\" {{ \"Software\" {{ \"Valve\" {{ \"Steam\" {{ \"DownloadThrottleKbps\" \"0\" \"AllowDownloadsDuringGameplay\" \"{v}\" }} }} }} }}"));
        assert!(allows_downloads_during_gameplay(&cfg("1")));
        assert!(!allows_downloads_during_gameplay(&cfg("0")));
        assert!(!allows_downloads_during_gameplay(&vdf::parse("\"InstallConfigStore\" { \"Software\" { } }")));
    }

    #[test]
    fn manifest_zustaende() {
        let st = |f: &str, total: &str, done: &str| json!({ "StateFlags": f, "BytesToDownload": total, "BytesDownloaded": done });
        assert!(update_state(&st("4", "0", "0")).is_null());
        assert_eq!(update_state(&st("6", "2285833174", "0"))["state"], "available");
        assert_eq!(update_state(&st("1030", "100", "50"))["state"], "downloading");
        assert_eq!(update_state(&st("1030", "100", "50"))["progress"], 0.5);
        assert_eq!(update_state(&st("2", "100", "0"))["state"], "queued");
        assert_eq!(update_state(&st("516", "100", "10"))["state"], "paused");
    }

    #[test]
    fn content_log() {
        let text = "[2026-11-10 16:54:11] AppID 227300 update started : download 0/1000, store 0/0\n\
                    [2026-11-10 16:54:12] AppID 227300 state changed : Fully Installed,Update Queued,Update Running,\n\
                    [2026-11-10 16:54:41] stats: (SteamCache, 1) host: 300 Bytes, 30 sec (5 Mbps)\n";
        use chrono::TimeZone;
        let now = chrono::Local.with_ymd_and_hms(2026, 11, 10, 16, 54, 50).unwrap().timestamp_millis();
        let i = parse_content_log(text, now);
        assert_eq!(i.appid.as_deref(), Some("227300"));
        assert_eq!(i.bytes_total, Some(1000.0));
        assert_eq!(i.bytes_done, Some(300.0));
        assert_eq!(i.speed, Some(10.0));
        assert!(i.states["227300"].contains("Update Running"));
    }
}
