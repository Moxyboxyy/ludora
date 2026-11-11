//! Battle.net

use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::{galaxy, steam::strip_nulls, Detected, Provider};
use crate::protobuf as pb;
use crate::reg;
use crate::util::*;

const UID_TO_CODE: [(&str, &str); 21] = [
    ("wow", "WoW"), ("wow_classic", "WoWC"), ("wow_classic_era", "WoWC"), ("prometheus", "Pro"), ("hs_beta", "WTCG"),
    ("heroes", "Hero"), ("s1", "S1"), ("s2", "S2"), ("diablo3", "D3"), ("osi", "OSI"), ("fenris", "Fen"), ("anbs", "ANBS"),
    ("w3", "W3"), ("rtro", "RTRO"), ("wlby", "WLBY"), ("viper", "VIPR"), ("odin", "ODIN"), ("lazarus", "LAZR"),
    ("zeus", "ZEUS"), ("fore", "FORE"), ("auks", "AUKS"),
];

const UID_TO_NAME: [(&str, &str); 22] = [
    ("wow", "World of Warcraft"), ("wow_classic", "World of Warcraft Classic"), ("wow_classic_era", "World of Warcraft Classic Era"),
    ("wow_classic_anniversary", "World of Warcraft Classic Anniversary"), ("prometheus", "Overwatch 2"), ("hs_beta", "Hearthstone"),
    ("heroes", "Heroes of the Storm"), ("s1", "StarCraft Remastered"), ("s2", "StarCraft II"), ("diablo3", "Diablo III"),
    ("osi", "Diablo II: Resurrected"), ("fenris", "Diablo IV"), ("anbs", "Diablo Immortal"), ("w3", "Warcraft III: Reforged"),
    ("rtro", "Blizzard Arcade Collection"), ("wlby", "Crash Bandicoot 4: It’s About Time"), ("viper", "Call of Duty: Black Ops 4"),
    ("odin", "Call of Duty: Modern Warfare"), ("lazarus", "Call of Duty: Modern Warfare 2 Campaign Remastered"),
    ("zeus", "Call of Duty: Black Ops Cold War"), ("fore", "Call of Duty: Vanguard"), ("auks", "Call of Duty"),
];

fn code(uid: &str) -> Option<&'static str> {
    UID_TO_CODE.iter().find(|(u, _)| *u == uid).map(|(_, c)| *c)
}
fn uid_name(uid: &str) -> Option<&'static str> {
    UID_TO_NAME.iter().find(|(u, _)| *u == uid).map(|(_, n)| *n)
}

fn config_path() -> Option<PathBuf> {
    if IS_MAC {
        return Some(mac_support(&["Battle.net", "Battle.net.config"]));
    }
    let a = env("APPDATA");
    if a.is_empty() { None } else { Some(PathBuf::from(a).join("Battle.net").join("Battle.net.config")) }
}

fn agent_dir() -> PathBuf {
    if IS_MAC {
        return mac_shared(&["Battle.net", "Agent"]);
    }
    let pd = env("PROGRAMDATA");
    PathBuf::from(if pd.is_empty() { r"C:\ProgramData".into() } else { pd }).join("Battle.net").join("Agent")
}

async fn known_games() -> Vec<(String, Option<u64>)> {
    let Some(f) = config_path() else { return vec![] };
    let Some(cfg) = read_json(&f).await else { return vec![] };
    let Some(games) = cfg["Games"].as_object() else { return vec![] };
    games
        .iter()
        .filter(|(uid, v)| *uid != "battle_net" && v.is_object() && (v["LastPlayed"].is_string() || v["LastActioned"].is_string() || v["LastInstalled"].is_string()))
        .map(|(uid, v)| (uid.clone(), v["LastPlayed"].as_str().and_then(|s| s.parse().ok()).filter(|x: &u64| *x > 0)))
        .collect()
}

#[derive(Debug, Default)]
struct ProductState {
    install_path: Option<String>,
    installed: bool,
    playable: bool,
    update_complete: bool,
    progress: f64,
    total: f64,
    remaining: f64,
    in_progress: bool,
}

/// Zustand jedes Spiels aus product.db (Protobuf)
async fn read_product_db() -> HashMap<String, ProductState> {
    let Ok(buf) = tokio::fs::read(agent_dir().join("product.db")).await else { return HashMap::new() };
    let mut out = HashMap::new();
    let Some(top) = pb::decode(&buf) else { return out };
    for p in top.iter().filter(|f| f.field == 1 && f.wire == 2) {
        let Some(m) = pb::decode(p.bytes) else { continue };
        let (Some(uid), Some(state)) = (pb::string(&m, 1), pb::bytes(&m, 4)) else { continue };
        let install_path = pb::bytes(&m, 3).and_then(pb::decode).and_then(|s| pb::string(&s, 1));
        let Some(s) = pb::decode(state) else { continue };
        let sub = |n: u64| pb::bytes(&s, n).and_then(pb::decode).unwrap_or_default();
        let base = sub(1);
        let job = sub(2);
        let upd = sub(4);
        let prog = upd.iter().find(|f| f.field == 2 && f.wire == 1).map(|f| f64::from_le_bytes(f.bytes.try_into().unwrap_or([0; 8]))).unwrap_or(0.0);
        out.insert(uid, ProductState {
            install_path,
            installed: pb::int(&base, 1) == Some(1),
            playable: pb::int(&base, 2) == Some(1),
            update_complete: pb::int(&base, 3) == Some(1),
            progress: prog,
            total: pb::int(&upd, 4).unwrap_or(0) as f64,
            remaining: pb::int(&upd, 5).unwrap_or(0) as f64,
            in_progress: pb::int(&base, 5) == Some(1) || pb::int(&job, 2) == Some(1),
        });
    }
    out
}

async fn bnet_updates() -> HashMap<String, Value> {
    let cfg = match config_path() { Some(f) => read_json(&f).await.unwrap_or(Value::Null), None => Value::Null };
    let paused = |uid: &str| cfg["Games"][uid]["UserPausedUpdate"] == "true";
    let mut out: HashMap<String, (Value, bool, bool)> = HashMap::new();
    for (uid, s) in read_product_db().await {
        if matches!(uid.as_str(), "agent" | "battle.net" | "bna") || (s.installed && s.update_complete) {
            continue;
        }
        let running = s.total > 0.0 && s.remaining > 0.0;
        let started = s.in_progress || cfg["Games"][&uid]["Resumable"] == "true";
        let initializing = !running && !s.playable && started;
        if !s.installed && !running && !initializing {
            continue;
        }
        let mut u = json!({
            "state": if running || initializing { if paused(&uid) { "paused" } else { "downloading" } } else { "available" },
            "firstInstall": !s.installed,
        });
        if running {
            u["progress"] = json!(s.progress);
            u["bytesTotal"] = json!(s.total);
            u["bytesDone"] = json!(s.total - s.remaining);
        } else if initializing {
            if s.progress > 0.0 {
                u["progress"] = json!(s.progress);
            } else if !paused(&uid) {
                u["detail"] = json!(t("Initialisieren …"));
            }
        }
        let p = paused(&uid);
        out.insert(uid, (u, initializing && !p, running && !p));
    }
    let any_running = out.values().any(|(_, _, r)| *r);
    let last = |uid: &str| cfg["Games"][uid]["LastActioned"].as_str().and_then(|x| x.parse::<u64>().ok()).unwrap_or(0);
    let mut inits: Vec<String> = out.iter().filter(|(_, (_, i, _))| *i).map(|(k, _)| k.clone()).collect();
    inits.sort_by(|a, b| last(b).cmp(&last(a)));
    for (i, uid) in inits.iter().enumerate() {
        if any_running || i > 0 {
            let u = &mut out.get_mut(uid).unwrap().0;
            u["state"] = json!("queued");
            u.as_object_mut().unwrap().remove("detail");
        }
    }
    out.into_iter().map(|(k, (u, _, _))| (k, u)).collect()
}

pub async fn find_battlenet_exe() -> Option<PathBuf> {
    if IS_MAC {
        return first_existing(&[PathBuf::from("/Applications/Battle.net.app"), home().join("Applications/Battle.net.app")]).await;
    }
    let pf86 = { let x = env("ProgramFiles(x86)"); if x.is_empty() { r"C:\Program Files (x86)".into() } else { x } };
    let pf = { let x = env("ProgramFiles"); if x.is_empty() { r"C:\Program Files".into() } else { x } };
    first_existing(&[PathBuf::from(pf86).join(r"Battle.net\Battle.net.exe"), PathBuf::from(pf).join(r"Battle.net\Battle.net.exe")]).await
}

fn bnet_launch(bnet: &Option<PathBuf>, code: Option<&str>, fallback: &str) -> Value {
    match (bnet, code) {
        (Some(b), Some(c)) => exe_launch(Some(b), &[&format!("--exec=launch {c}")]).unwrap(),
        _ => uri(format!("battlenet://{}", code.unwrap_or(fallback))),
    }
}

/// Update im Hintergrund: "vom Nutzer pausiert" aus der Konfiguration nehmen und Battle.net unsichtbar starten
async fn background_update(game: &Value) -> Option<Value> {
    let exe = find_battlenet_exe().await?;
    let names = vec!["Battle.net".to_string()];
    let mut changed = false;
    if let Some(cfg_file) = config_path() {
        if let Some(raw) = read_text(&cfg_file).await {
            if let Ok(mut cfg) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) {
                let id = game["nativeId"].as_str().unwrap_or("");
                if cfg["Games"][id]["UserPausedUpdate"] == "true" {
                    if crate::running::is_process_running(&names).await {
                        if IS_WIN {
                            let _ = crate::running::hidden_command("taskkill").args(["/IM", "Battle.net.exe", "/F"]).status();
                        } else {
                            let _ = std::process::Command::new("osascript").args(["-e", "quit app \"Battle.net\""]).status();
                        }
                        for _ in 0..20 {
                            if !crate::running::is_process_running(&names).await {
                                break;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        }
                    }
                    cfg["Games"][id]["UserPausedUpdate"] = json!("false");
                    // Battle.net schreibt die Datei mit 4 Leerzeichen Einrückung
                    let mut buf = Vec::new();
                    let fmt = serde_json::ser::PrettyFormatter::with_indent(b"    ");
                    let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
                    let _ = serde::Serialize::serialize(&cfg, &mut ser);
                    let mut out = String::from_utf8(buf).unwrap_or_default();
                    if raw.contains("\r\n") {
                        out = out.replace('\n', "\r\n");
                    }
                    changed = tokio::fs::write(&cfg_file, out).await.is_ok();
                }
            }
        }
    }
    if changed || !crate::running::is_process_running(&names).await {
        let ok = if IS_MAC {
            crate::running::spawn_detached("open", &["-g".into(), "-a".into(), exe.to_string_lossy().into_owned()], None)
        } else {
            crate::running::spawn_detached(&exe.to_string_lossy(), &[], exe.parent().and_then(|p| p.to_str()))
        };
        if ok.is_err() {
            return None;
        }
    }
    Some(json!({ "type": "none" }))
}

// ---------- Lokale Schnittstelle des Battle.net-Agents ----------

pub mod agent {
    use once_cell::sync::Lazy;
    use parking_lot::Mutex;
    use serde_json::{json, Value};

    static AUTH: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

    fn port() -> u16 {
        std::fs::read_to_string(super::agent_dir().join("Agent.dat"))
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .filter(|n: &u16| *n > 0)
            .unwrap_or(1120)
    }

    async fn request(method: &str, path: &str, body: Option<&Value>, with_auth: bool) -> (u16, Option<Value>) {
        let url = format!("http://127.0.0.1:{}{path}", port());
        let m = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
        let mut r = crate::net::local().request(m, url).timeout(std::time::Duration::from_millis(2500));
        if with_auth {
            if let Some(a) = AUTH.lock().clone() {
                r = r.header("authorization", a);
            }
        }
        if let Some(b) = body {
            r = r.json(b);
        }
        match r.send().await {
            Ok(res) => {
                let st = res.status().as_u16();
                let text = res.text().await.unwrap_or_default();
                (st, if text.is_empty() { Some(json!({})) } else { serde_json::from_str(&text).ok() })
            }
            Err(_) => (0, None),
        }
    }

    async fn ensure_auth() -> bool {
        if AUTH.lock().is_some() {
            return true;
        }
        let (st, j) = request("GET", "/agent", None, false).await;
        if st == 200 {
            if let Some(a) = j.as_ref().and_then(|j| j["authorization"].as_str()) {
                *AUTH.lock() = Some(a.to_string());
                return true;
            }
        }
        false
    }

    async fn call(method: &str, path: &str, body: Option<&Value>) -> Option<(u16, Option<Value>)> {
        if !ensure_auth().await {
            return None;
        }
        let mut r = request(method, path, body, true).await;
        if r.0 == 401 || r.0 == 403 {
            *AUTH.lock() = None;
            if !ensure_auth().await {
                return None;
            }
            r = request(method, path, body, true).await;
        }
        Some(r)
    }

    fn first(v: &Value) -> f64 {
        match v {
            Value::Array(a) => a.first().and_then(|x| x.as_f64()).unwrap_or(0.0),
            x => x.as_f64().unwrap_or(0.0),
        }
    }

    /// Antwort von GET /update/<uid> -> Ludoras Download-Format
    pub fn parse_update(j: &Value) -> Option<Value> {
        if !j.is_object() {
            return None;
        }
        let rate = j["download_rate"].as_f64().unwrap_or(0.0);
        if j["download_complete"] == true && j["patch_application_complete"] != false && rate <= 0.0 {
            return None;
        }
        let total = first(&j["download_total"]);
        let current = first(&j["download_current"]);
        let remaining = j["download_remaining"].as_f64().unwrap_or(0.0);
        let progress = j["progress"].as_f64().or(if total > 0.0 { Some(current / total) } else { None });
        if progress.is_none() && total == 0.0 {
            return None;
        }
        let paused = j["paused"] == true || j["state"] == "paused";
        let eta = j["estimated_time_in_sec"].as_f64().filter(|x| *x > 0.0).or(if rate > 0.0 && remaining > 0.0 { Some(remaining / rate) } else { None });
        Some(super::strip_nulls(json!({
            "state": if paused { "paused" } else { "downloading" },
            "progress": progress.map(|p| p.clamp(0.0, 1.0)),
            "bytesDone": if current > 0.0 { json!(current) } else { Value::Null },
            "bytesTotal": if total > 0.0 { json!(total) } else { Value::Null },
            "speed": rate, "eta": eta, "source": "Battle.net",
        })))
    }

    pub async fn update_status(uid: &str) -> Option<Value> {
        let (st, j) = call("GET", &format!("/update/{}", crate::net::enc(uid)), None).await?;
        if st != 200 {
            return None;
        }
        parse_update(&j?)
    }

    pub async fn start_update(uid: &str) -> bool {
        let _ = call("POST", &format!("/game/{}", crate::net::enc(uid)), Some(&json!({ "branch": "" }))).await;
        matches!(call("POST", "/update", Some(&json!({ "priority": { "insert_at_head": true, "value": 900 }, "uid": uid }))).await, Some((200, _)))
    }

    pub async fn wait_until_available(ms: u64) -> bool {
        let end = std::time::Instant::now() + std::time::Duration::from_millis(ms);
        while std::time::Instant::now() < end {
            *AUTH.lock() = None;
            if ensure_auth().await {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        false
    }

    pub async fn start_uninstall(uid: &str) -> bool {
        matches!(call("POST", "/uninstall", Some(&json!({ "run_compaction": true, "uid": uid }))).await, Some((200, _)))
    }

    pub async fn uninstall_status(uid: &str) -> Option<Value> {
        match call("GET", &format!("/uninstall/{}", crate::net::enc(uid)), None).await? {
            (200, j) => j,
            _ => None,
        }
    }

    pub async fn pause_update(uid: &str) -> bool {
        matches!(call("DELETE", &format!("/update/{}", crate::net::enc(uid)), None).await, Some((200, _)))
    }

    pub async fn available() -> bool {
        ensure_auth().await
    }
}

pub struct BattleNet;

#[async_trait]
impl Provider for BattleNet {
    fn id(&self) -> &str { "battlenet" }
    fn name(&self) -> &str { "Battle.net" }
    fn color(&self) -> &str { "#0b1a2e" }
    fn accent(&self) -> &str { "#148eff" }
    fn platforms(&self) -> &[&str] { &["win32", "darwin"] }
    fn processes(&self) -> &[&str] { &["Battle.net"] }
    fn processes_mac(&self) -> &[&str] { &["Battle.net"] }
    fn update_wait_ms(&self) -> u64 { 60_000 }

    async fn detect(&self) -> anyhow::Result<Detected> {
        let bnet = find_battlenet_exe().await;
        let pending = bnet_updates().await;
        let mut games = Vec::new();
        if IS_MAC {
            for (uid, s) in read_product_db().await {
                if !s.installed || matches!(uid.as_str(), "agent" | "battle.net" | "bna") {
                    continue;
                }
                games.push(strip_nulls(json!({
                    "nativeId": uid, "name": uid_name(&uid).unwrap_or(&uid), "installDir": s.install_path, "status": "installed",
                    "covers": [], "update": pending.get(&uid), "launch": bnet_launch(&bnet, code(&uid), &uid),
                })));
            }
        }
        let bn_re = crate::re!(r"(?i)Blizzard Uninstaller|Battle\.net");
        for e in reg::uninstall_entries() {
            let v = &e.values;
            let un = reg::val_str(v, "UninstallString").unwrap_or_default();
            if !bn_re.is_match(&un) || reg::val_str(v, "DisplayName").is_some_and(|n| n.eq_ignore_ascii_case("Battle.net")) {
                continue;
            }
            let uid = get_arg(&un, "uid").unwrap_or_default().to_lowercase();
            if uid.is_empty() || uid == "battle.net" || uid == "bna" {
                continue;
            }
            let mut g = json!({
                "nativeId": uid, "name": reg::val_str(v, "DisplayName").unwrap_or_else(|| e.name.clone()),
                "installDir": v.get("InstallLocation"), "status": "installed", "covers": [],
                "update": pending.get(&uid), "launch": bnet_launch(&bnet, code(&uid), &uid),
            });
            if g["update"].is_null() {
                g["update"] = Value::Null;
            }
            games.push(g);
        }
        let mut uids: HashSet<String> = games.iter().filter_map(|g| g["nativeId"].as_str().map(String::from)).collect();
        for (uid, last) in known_games().await {
            let Some(name) = uid_name(&uid) else { continue };
            if !uids.insert(uid.clone()) {
                continue;
            }
            games.push(strip_nulls(json!({
                "nativeId": uid, "name": name, "status": "notInstalled", "lastPlayed": last, "covers": [],
                "launch": bnet_launch(&bnet, code(&uid), &uid),
            })));
        }
        // Kontobibliothek (optional, über die Battle.net-Anmeldung in den Einstellungen)
        let mut warning = None;
        if crate::settings::get_bool("bnetAccountLibrary", false) {
            let (acc, w) = crate::accounts::library("battlenet").await;
            warning = w;
            for a in acc {
                let name = a["name"].as_str().unwrap_or("").to_string();
                let best = UID_TO_NAME.iter().map(|(u, n)| (*u, similarity(n, &name))).max_by(|a, b| a.1.total_cmp(&b.1));
                let uid = best.filter(|(_, s)| *s >= 0.75).map(|(u, _)| u.to_string());
                if uid.as_ref().is_some_and(|u| uids.contains(u)) {
                    continue;
                }
                if games.iter().any(|g| similarity(g["name"].as_str().unwrap_or(""), &name) >= 0.9) {
                    continue;
                }
                let c = uid.as_deref().and_then(code);
                if let Some(u) = &uid {
                    uids.insert(u.clone());
                }
                let launch = match (&bnet, c) {
                    (Some(b), Some(c)) => exe_launch(Some(b), &[&format!("--exec=launch {c}")]).unwrap(),
                    (Some(b), None) => exe_launch(Some(b), &[]).unwrap(),
                    _ => uri("battlenet://"),
                };
                games.push(json!({
                    "nativeId": uid.unwrap_or_else(|| format!("acc:{}", a["titleId"].as_str().map(String::from).unwrap_or_else(|| a["titleId"].to_string()).replace("null", &name))),
                    "name": name, "status": "notInstalled", "covers": [], "launch": launch,
                }));
            }
        }
        let b2 = bnet.clone();
        let games = galaxy::add_owned(games, &["battlenet"], move |o| {
            let c = code(&o.id.to_lowercase());
            Some(match (&b2, c) {
                (Some(b), Some(c)) => exe_launch(Some(b), &[&format!("--game={c}")]).unwrap(),
                _ => uri(format!("battlenet://{}", c.unwrap_or(&o.id))),
            })
        })
        .await;
        Ok(Detected { games, warning })
    }

    async fn updates(&self) -> Option<Vec<Value>> {
        Some(bnet_updates().await.into_iter().map(|(id, u)| json!({ "nativeId": id, "update": u })).collect())
    }
    async fn client(&self) -> Option<Value> {
        exe_launch(find_battlenet_exe().await.as_deref(), &[])
    }
    fn store(&self) -> Option<Value> {
        Some(json!({ "type": "url", "target": "https://shop.battle.net/de-de" }))
    }
    fn has_background_update(&self) -> bool {
        true
    }
    async fn background_update(&self, game: &Value) -> Option<Value> {
        background_update(game).await
    }
    fn update_page(&self, game: &Value) -> Option<Value> {
        let args = game["launch"]["args"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
        let re = crate::re!(r"launch\s+(\S+)");
        re.captures(&args).map(|c| uri(format!("battlenet://{}", &c[1])))
    }
    fn uninstall_page(&self, game: &Value) -> Option<Value> {
        self.update_page(game)
    }
    async fn pause_download(&self, game: &Value) -> Option<bool> {
        Some(agent::pause_update(game["nativeId"].as_str().unwrap_or("")).await)
    }
    async fn resume_download(&self, game: &Value) -> Option<bool> {
        Some(background_update(game).await.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::agent::parse_update;
    use serde_json::json;

    #[test]
    fn agent_antwort() {
        let u = parse_update(&json!({ "download_total": [1000], "download_current": [250], "download_rate": 50, "download_remaining": 750 })).unwrap();
        assert_eq!(u["progress"], 0.25);
        assert_eq!(u["eta"], 15.0);
        assert!(parse_update(&json!({ "download_complete": true })).is_none());
    }
}
