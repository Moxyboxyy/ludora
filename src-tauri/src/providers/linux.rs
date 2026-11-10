//! Linux: Heroic (Epic, GOG, Amazon) und Lutris (Battle.net, EA, Ubisoft, Rockstar, Rest)
//! (entspricht electron/providers/linux.js + lib/linuxLaunchers.js)

use async_trait::async_trait;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{Detected, Provider, P};
use crate::sqlite::{self, s};
use crate::util::*;

fn h() -> PathBuf {
    std::env::var("LUDORA_TEST_HOME").map(PathBuf::from).unwrap_or_else(|_| home())
}

fn read_json_sync(f: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(f).ok()?).ok()
}

pub fn heroic_dirs() -> Vec<PathBuf> {
    let cfg = std::env::var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|_| h().join(".config"));
    [cfg.join("heroic"), h().join(".var/app/com.heroicgameslauncher.hgl/config/heroic")].into_iter().filter(|p| p.exists()).collect()
}

pub fn heroic_command() -> Option<(String, Vec<String>)> {
    if h().join(".var/app/com.heroicgameslauncher.hgl").exists() {
        return Some(("flatpak".into(), vec!["run".into(), "com.heroicgameslauncher.hgl".into()]));
    }
    for p in ["/usr/bin/heroic", "/opt/Heroic/heroic", "/usr/local/bin/heroic"] {
        if Path::new(p).exists() {
            return Some((p.into(), vec![]));
        }
    }
    if heroic_dirs().is_empty() { None } else { Some(("heroic".into(), vec![])) }
}

fn runner(store: &str) -> &'static str {
    match store {
        "epic" => "legendary",
        "gog" => "gog",
        _ => "nile",
    }
}

fn library_entries(dir: &Path, store: &str) -> Vec<Value> {
    let files: &[&str] = match store {
        "epic" => &["store_cache/legendary_library.json", "lib-cache/library.json"],
        "gog" => &["store_cache/gog_library.json", "gog_store/library.json"],
        _ => &["store_cache/nile_library.json", "nile_store/library.json"],
    };
    for f in files {
        if let Some(j) = read_json_sync(&dir.join(f)) {
            let list = j["library"].as_array().or(j["games"].as_array()).or(j.as_array()).cloned().unwrap_or_default();
            if !list.is_empty() {
                return list;
            }
        }
    }
    vec![]
}

fn installed_map(dir: &Path, store: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    match store {
        "epic" => {
            if let Some(Value::Object(o)) = read_json_sync(&dir.join("legendaryConfig/legendary/installed.json")) {
                for (k, v) in o {
                    if v.is_object() && v["is_dlc"] != true {
                        out.insert(k, v["install_path"].as_str().unwrap_or("").to_string());
                    }
                }
            }
        }
        "gog" => {
            if let Some(j) = read_json_sync(&dir.join("gog_store/installed.json")) {
                for v in j["installed"].as_array().cloned().unwrap_or_default() {
                    if let Some(a) = v["appName"].as_str().map(String::from).or_else(|| v["appName"].as_u64().map(|x| x.to_string())) {
                        out.insert(a, v["install_path"].as_str().unwrap_or("").to_string());
                    }
                }
            }
        }
        _ => {
            if let Some(Value::Array(a)) = read_json_sync(&dir.join("nile_config/nile/installed.json")) {
                for v in a {
                    if let Some(id) = v["id"].as_str() {
                        out.insert(id.into(), v["path"].as_str().unwrap_or("").to_string());
                    }
                }
            }
        }
    }
    out
}

/// Heroic-Spiele eines Stores
pub fn heroic_games(store: &str) -> Vec<Value> {
    let mut games: Vec<(String, Value)> = Vec::new();
    let https = |u: &Value| u.as_str().filter(|x| x.starts_with("https://")).map(String::from);
    for dir in heroic_dirs() {
        let installed = installed_map(&dir, store);
        for e in library_entries(&dir, store) {
            let app = e["app_name"].as_str().or(e["appName"].as_str()).map(String::from).or_else(|| e["id"].as_str().map(String::from)).unwrap_or_default();
            if app.is_empty() || e["is_dlc"] == true || e["install"]["is_dlc"] == true || games.iter().any(|(a, _)| *a == app) {
                continue;
            }
            let install_dir = installed.get(&app).cloned().or_else(|| if e["is_installed"] == true { Some(e["install"]["install_path"].as_str().unwrap_or("").to_string()) } else { None });
            let covers: Vec<String> = [https(&e["art_square"]), https(&e["art_cover"])].into_iter().flatten().collect();
            let wides: Vec<String> = https(&e["art_cover"]).into_iter().collect();
            games.push((app.clone(), json!({
                "nativeId": app, "name": e["title"].as_str().unwrap_or(&app),
                "installDir": install_dir.clone().filter(|d| !d.is_empty()),
                "status": if install_dir.is_some() { "installed" } else { "notInstalled" },
                "covers": covers,
                "wides": wides,
                "launch": uri(format!("heroic://launch?appName={}&runner={}", crate::net::enc(&app), runner(store))),
            })));
        }
        for (app, path) in installed {
            if games.iter().any(|(a, _)| *a == app) {
                continue;
            }
            games.push((app.clone(), json!({
                "nativeId": app,
                "name": Path::new(if path.is_empty() { &app } else { &path }).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(app.clone()),
                "installDir": if path.is_empty() { Value::Null } else { json!(path) }, "status": "installed", "covers": [],
                "launch": uri(format!("heroic://launch?appName={}&runner={}", crate::net::enc(&app), runner(store))),
            })));
        }
    }
    games
        .into_iter()
        .map(|(_, mut g)| {
            if g["status"] == "notInstalled" {
                g["launch"] = json!({ "type": "heroic" });
            }
            super::steam::strip_nulls(g)
        })
        .collect()
}

struct LutrisDir {
    data: PathBuf,
    cache: PathBuf,
}

fn lutris_dirs() -> Vec<LutrisDir> {
    let data = std::env::var("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|_| h().join(".local/share"));
    vec![
        LutrisDir { data: data.join("lutris"), cache: h().join(".cache/lutris") },
        LutrisDir { data: h().join(".var/app/net.lutris.Lutris/data/lutris"), cache: h().join(".var/app/net.lutris.Lutris/cache/lutris") },
    ]
    .into_iter()
    .filter(|d| d.data.join("pga.db").exists())
    .collect()
}

pub fn lutris_command() -> Option<(String, Vec<String>)> {
    if h().join(".var/app/net.lutris.Lutris").exists() {
        return Some(("flatpak".into(), vec!["run".into(), "net.lutris.Lutris".into()]));
    }
    for p in ["/usr/bin/lutris", "/usr/local/bin/lutris"] {
        if Path::new(p).exists() {
            return Some((p.into(), vec![]));
        }
    }
    if lutris_dirs().is_empty() { None } else { Some(("lutris".into(), vec![])) }
}

static LAUNCHER_APPS: Lazy<Vec<(&'static str, Regex)>> = Lazy::new(|| {
    vec![
        ("battlenet", Regex::new(r"(?i)^battle\.?net$").unwrap()),
        ("ea", Regex::new(r"(?i)^(ea app|ea desktop|origin)$").unwrap()),
        ("ubisoft", Regex::new(r"(?i)^(ubisoft connect|uplay)$").unwrap()),
        ("rockstar", Regex::new(r"(?i)^rockstar games launcher$").unwrap()),
        ("epic", Regex::new(r"(?i)^epic games( store| launcher)?$").unwrap()),
        ("gog", Regex::new(r"(?i)^gog galaxy$").unwrap()),
        ("amazon", Regex::new(r"(?i)^amazon games$").unwrap()),
    ]
});

pub fn launcher_of(row: &Map<String, Value>) -> &'static str {
    let svc = s(row, "service").unwrap_or_default().to_lowercase();
    let mapped = match svc.as_str() {
        "battlenet" => Some("battlenet"),
        "ea_app" | "origin" => Some("ea"),
        "ubisoft" | "ubisoftconnect" => Some("ubisoft"),
        "egs" => Some("epic"),
        "gog" => Some("gog"),
        "amazon" => Some("amazon"),
        "steam" => Some("steam"),
        _ => None,
    };
    if let Some(m) = mapped {
        return m;
    }
    let st = format!("{} {} {}", s(row, "installer_slug").unwrap_or_default(), s(row, "slug").unwrap_or_default(), s(row, "configpath").unwrap_or_default()).to_lowercase();
    let has = |re: &str| Regex::new(re).unwrap().is_match(&st);
    if has(r"battle-?net|blizzard") {
        "battlenet"
    } else if has(r"ea-app|origin|ea-desktop") {
        "ea"
    } else if has(r"ubisoft|uplay") {
        "ubisoft"
    } else if has("rockstar") {
        "rockstar"
    } else if has(r"epic-games|\begs\b") {
        "epic"
    } else {
        "lutris"
    }
}

static LUTRIS_CACHE: Lazy<Mutex<Option<(std::time::Instant, Vec<Map<String, Value>>)>>> = Lazy::new(|| Mutex::new(None));

pub fn clear_cache() {
    *LUTRIS_CACHE.lock() = None;
}

fn lutris_rows() -> Vec<Map<String, Value>> {
    if let Some((t, rows)) = LUTRIS_CACHE.lock().as_ref() {
        if t.elapsed().as_secs() < 5 {
            return rows.clone();
        }
    }
    let mut rows = Vec::new();
    for d in lutris_dirs() {
        let Some(db) = sqlite::open(d.data.join("pga.db")) else { continue };
        if !db.tables().contains("games") {
            continue;
        }
        let cols = db.columns("games");
        let pick: Vec<String> = ["id", "name", "slug", "installer_slug", "runner", "directory", "installed", "lastplayed", "playtime", "service", "service_id", "configpath", "hidden"]
            .iter()
            .filter(|c| cols.contains(**c))
            .map(|c| format!("\"{c}\""))
            .collect();
        rows.extend(db.all(&format!("SELECT {} FROM games", pick.join(", "))));
    }
    *LUTRIS_CACHE.lock() = Some((std::time::Instant::now(), rows.clone()));
    rows
}

/// Bild eines Lutris-Spiels ('cover' hochkant, 'banner' breit)
pub fn lutris_image(slug: &str, kind: &str) -> Option<PathBuf> {
    if !Regex::new(r"(?i)^[a-z0-9._-]+$").unwrap().is_match(slug) {
        return None;
    }
    let sub = if kind == "banner" { "banners" } else { "coverart" };
    let mut dirs = lutris_dirs();
    dirs.push(LutrisDir { data: h().join(".local/share/lutris"), cache: h().join(".cache/lutris") });
    for d in dirs {
        for base in [&d.data, &d.cache] {
            for ext in ["jpg", "png"] {
                let f = base.join(sub).join(format!("{slug}.{ext}"));
                if f.exists() {
                    return Some(f);
                }
            }
        }
    }
    None
}

pub fn lutris_games(launcher: &str) -> Vec<Value> {
    let num = |r: &Map<String, Value>, k: &str| sqlite::f(r, k).unwrap_or(0.0);
    lutris_rows()
        .iter()
        .filter(|r| num(r, "installed") == 1.0 && num(r, "hidden") != 1.0)
        .filter(|r| !LAUNCHER_APPS.iter().any(|(_, re)| re.is_match(&s(r, "name").unwrap_or_default())))
        .filter(|r| launcher_of(r) == launcher)
        .map(|r| {
            let slug = s(r, "slug");
            let id = s(r, "id").unwrap_or_default();
            let covers: Vec<String> = slug.iter().map(|x| format!("ghimg://lutris/{}/cover", crate::net::enc(x))).collect();
            let wides: Vec<String> = slug.iter().map(|x| format!("ghimg://lutris/{}/banner", crate::net::enc(x))).collect();
            super::steam::strip_nulls(json!({
                "nativeId": format!("lutris-{id}"), "name": s(r, "name"), "installDir": s(r, "directory"), "status": "installed",
                "covers": covers,
                "wides": wides,
                "playtimeMin": if num(r, "playtime") > 0.0 { json!((num(r, "playtime") * 60.0).round()) } else { Value::Null },
                "lastPlayed": if num(r, "lastplayed") > 0.0 { json!(num(r, "lastplayed")) } else { Value::Null },
                "launch": uri(format!("lutris:rungameid/{id}")),
            }))
        })
        .collect()
}

pub fn lutris_launcher_app(launcher: &str) -> Option<Value> {
    let re = &LAUNCHER_APPS.iter().find(|(id, _)| *id == launcher)?.1;
    let r = lutris_rows().into_iter().find(|x| sqlite::f(x, "installed") == Some(1.0) && re.is_match(&s(x, "name").unwrap_or_default()))?;
    Some(uri(format!("lutris:rungameid/{}", s(&r, "id")?)))
}

fn cmd_launch(c: Option<(String, Vec<String>)>) -> Option<Value> {
    c.map(|(cmd, args)| json!({ "type": "exe", "target": cmd, "args": args }))
}

struct LinuxProvider {
    id: &'static str,
    name: &'static str,
    color: &'static str,
    accent: &'static str,
    store: Option<&'static str>,
    heroic: bool,
}

#[async_trait]
impl Provider for LinuxProvider {
    fn id(&self) -> &str { self.id }
    fn name(&self) -> &str { self.name }
    fn color(&self) -> &str { self.color }
    fn accent(&self) -> &str { self.accent }
    fn platforms(&self) -> &[&str] { &["linux"] }
    fn processes(&self) -> &[&str] { if self.heroic { &["heroic"] } else { &["lutris"] } }
    fn via(&self) -> Option<&str> { Some(if self.heroic { "Heroic" } else { "Lutris" }) }

    async fn detect(&self) -> anyhow::Result<Detected> {
        let (id, heroic) = (self.id, self.heroic);
        let games = tokio::task::spawn_blocking(move || {
            if !heroic {
                return lutris_games(id);
            }
            let client = cmd_launch(heroic_command());
            let mut games: Vec<Value> = heroic_games(id)
                .into_iter()
                .filter_map(|mut g| {
                    if g["launch"]["type"] == "heroic" {
                        g["launch"] = client.clone()?;
                    }
                    Some(g)
                })
                .collect();
            let seen: HashSet<String> = games.iter().map(|g| g["name"].as_str().unwrap_or("").to_lowercase()).collect();
            games.extend(lutris_games(id).into_iter().filter(|g| !seen.contains(&g["name"].as_str().unwrap_or("").to_lowercase())));
            games
        })
        .await?;
        Ok(games.into())
    }
    async fn client(&self) -> Option<Value> {
        if self.heroic {
            cmd_launch(heroic_command())
        } else {
            lutris_launcher_app(self.id).or_else(|| cmd_launch(lutris_command()))
        }
    }
    fn store(&self) -> Option<Value> {
        self.store.map(|s| json!({ "type": "url", "target": s }))
    }
}

pub fn providers() -> Vec<P> {
    let mk = |id, name, color, accent, store, heroic| -> P { Arc::new(LinuxProvider { id, name, color, accent, store, heroic }) };
    vec![
        mk("epic", "Epic Games", "#2a2a2a", "#f5f5f5", Some("https://store.epicgames.com/"), true),
        mk("gog", "GOG", "#3b1f4f", "#c79bff", Some("https://www.gog.com/games"), true),
        mk("amazon", "Amazon Games", "#1a2330", "#ff9900", Some("https://gaming.amazon.com/home"), true),
        mk("battlenet", "Battle.net", "#0b1a2e", "#148eff", Some("https://shop.battle.net/"), false),
        mk("ea", "EA app", "#3a0d12", "#ff4747", Some("https://www.ea.com/games"), false),
        mk("ubisoft", "Ubisoft Connect", "#0e1a3a", "#5aa0ff", Some("https://store.ubisoft.com/"), false),
        mk("rockstar", "Rockstar", "#2a2306", "#fcaf17", Some("https://store.rockstargames.com/"), false),
        mk("lutris", "Lutris", "#2a1a0d", "#ff9c2a", None, false),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heroic_und_lutris() {
        let dir = std::env::temp_dir().join(format!("ludora-linux-{}", std::process::id()));
        let heroic = dir.join(".config/heroic");
        std::fs::create_dir_all(heroic.join("store_cache")).unwrap();
        std::fs::create_dir_all(heroic.join("legendaryConfig/legendary")).unwrap();
        std::fs::write(heroic.join("store_cache/legendary_library.json"), r#"{"library":[{"app_name":"Fortnite","title":"Fortnite","art_cover":"https://x/c.jpg"},{"app_name":"Hades","title":"Hades"}]}"#).unwrap();
        std::fs::write(heroic.join("legendaryConfig/legendary/installed.json"), r#"{"Hades":{"install_path":"/games/Hades"}}"#).unwrap();
        std::env::set_var("LUDORA_TEST_HOME", &dir);
        std::env::remove_var("XDG_CONFIG_HOME");
        let g = heroic_games("epic");
        let hades = g.iter().find(|x| x["name"] == "Hades").unwrap();
        assert_eq!(hades["status"], "installed");
        assert_eq!(hades["installDir"], "/games/Hades");
        let fort = g.iter().find(|x| x["name"] == "Fortnite").unwrap();
        assert_eq!(fort["status"], "notInstalled");
        assert_eq!(fort["launch"]["type"], "heroic");
        std::env::remove_var("LUDORA_TEST_HOME");
        let _ = std::fs::remove_dir_all(dir);

        let mut row = Map::new();
        row.insert("service".into(), json!("ea_app"));
        assert_eq!(launcher_of(&row), "ea");
        let mut row = Map::new();
        row.insert("installer_slug".into(), json!("battlenet-standard"));
        assert_eq!(launcher_of(&row), "battlenet");
    }
}
