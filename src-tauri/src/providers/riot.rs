//! Riot Games (entspricht electron/providers/riot.js + lib/riotClient.js)

use async_trait::async_trait;
use base64::Engine;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::{Detected, Provider};
use crate::reg;
use crate::util::*;

fn riot_dir() -> PathBuf {
    if IS_MAC {
        return mac_shared(&["Riot Games"]);
    }
    let pd = env("PROGRAMDATA");
    PathBuf::from(if pd.is_empty() { r"C:\ProgramData".into() } else { pd }).join("Riot Games")
}

const PRODUCTS: [(&str, &str, bool, bool); 3] = [
    ("league_of_legends", "League of Legends", true, true),
    ("valorant", "VALORANT", true, false),
    ("bacon", "Legends of Runeterra", true, false),
];

async fn installed_from_metadata() -> Vec<(String, String, String)> {
    let meta = riot_dir().join("Metadata");
    let re = Regex::new(r"^([a-z0-9_]+)\.(live|pbe)$").unwrap();
    let dir_re = Regex::new(r#"product_install_full_path:\s*"?([^"\n]+)"?"#).unwrap();
    let mut out = vec![];
    for id in list_dir(&meta).await {
        let Some(c) = re.captures(&id) else { continue };
        if &c[1] == "riot_client" {
            continue;
        }
        let Some(yaml) = read_text(meta.join(&id).join(format!("{id}.product_settings.yaml"))).await else { continue };
        if let Some(d) = dir_re.captures(&yaml) {
            let dir = d[1].trim().to_string();
            if exists(&dir).await {
                out.push((c[1].to_string(), c[2].to_string(), dir));
            }
        }
    }
    out
}

pub async fn find_client(from_uninstall: Option<&str>) -> Option<PathBuf> {
    if let Some(u) = from_uninstall {
        if exists(u).await {
            return Some(PathBuf::from(u));
        }
    }
    if let Some(info) = read_json(riot_dir().join("RiotClientInstalls.json")).await {
        for k in ["rc_default", "rc_live"] {
            if let Some(p) = info[k].as_str() {
                if exists(p).await {
                    return Some(PathBuf::from(p));
                }
            }
        }
    }
    let fallbacks = if IS_MAC {
        vec![mac_shared(&["Riot Games", "Riot Client.app"]), PathBuf::from("/Applications/Riot Client.app")]
    } else {
        vec![PathBuf::from(r"C:\Riot Games\Riot Client\RiotClientServices.exe")]
    };
    first_existing(&fallbacks).await
}

async fn riot_update(product_id: &str) -> Value {
    let Some(s) = read_json(riot_dir().join("Metadata").join(product_id).join(format!("{product_id}.update-status.json"))).await else {
        return Value::Null;
    };
    if s["status"]["updateRequired"] == true {
        return json!({ "state": "available", "detail": t("Pflicht-Update") });
    }
    if s["status"]["updateAvailable"] == true {
        return json!({ "state": "available" });
    }
    Value::Null
}

// ---------- Lokale Schnittstelle des Riot Client ----------

pub mod client {
    use super::*;

    pub fn client_dir() -> PathBuf {
        if IS_MAC {
            return home().join("Library/Application Support/Riot Games/Riot Client");
        }
        let l = env("LOCALAPPDATA");
        (if l.is_empty() { home().join("AppData").join("Local") } else { PathBuf::from(l) }).join("Riot Games").join("Riot Client")
    }

    fn start_time_from_name(name: &str) -> Option<i64> {
        let re = Regex::new(r"^(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)").unwrap();
        let c = re.captures(name)?;
        use chrono::TimeZone;
        let n = |i: usize| c[i].parse::<u32>().ok();
        Some(chrono::Local.with_ymd_and_hms(c[1].parse().ok()?, n(2)?, n(3)?, n(4)?, n(5)?, n(6)?).single()?.timestamp_millis())
    }

    /// Letzter Status je Produkt aus einem Log-Text: id -> (status, progress, t)
    pub fn parse_log(text: &str, start: Option<i64>) -> HashMap<String, (String, f64, Option<i64>)> {
        let re = Regex::new(r"^(\d+(?:\.\d+)?)\|.*?HandleProductPatchlineStatusUpdate: productId: ([\w-]+), patchlineId: ([\w-]+), status: (\w+), progress: ([\d.]+)").unwrap();
        let mut out = HashMap::new();
        for l in text.lines() {
            if let Some(c) = re.captures(l) {
                let secs: f64 = c[1].parse().unwrap_or(0.0);
                out.insert(
                    format!("{}.{}", &c[2], &c[3]),
                    (c[4].to_string(), (c[5].parse::<f64>().unwrap_or(0.0) / 100.0).clamp(0.0, 1.0), start.map(|s| s + (secs * 1000.0) as i64)),
                );
            }
        }
        out
    }

    /// Laufende Riot-Downloads: "valorant.live" -> update
    pub async fn live_updates() -> HashMap<String, Value> {
        let dir = client_dir().join("Logs").join("Riot Client Logs");
        let mut newest: Option<(String, std::time::SystemTime, u64)> = None;
        for n in list_dir(&dir).await.into_iter().filter(|n| n.ends_with(".log")) {
            if let Ok(m) = tokio::fs::metadata(dir.join(&n)).await {
                let t = m.modified().unwrap_or(std::time::UNIX_EPOCH);
                if newest.as_ref().map_or(true, |x| t > x.1) {
                    newest = Some((n, t, m.len()));
                }
            }
        }
        let Some((name, mtime, size)) = newest else { return HashMap::new() };
        let now = chrono::Utc::now().timestamp_millis();
        let mt = mtime.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        if now - mt > 10 * 60 * 1000 {
            return HashMap::new();
        }
        let file = dir.join(&name);
        let text = tokio::task::spawn_blocking(move || -> Option<String> {
            use std::io::{Read, Seek, SeekFrom};
            let mut f = std::fs::File::open(file).ok()?;
            let len = size.min(512 * 1024);
            f.seek(SeekFrom::Start(size - len)).ok()?;
            let mut buf = vec![0; len as usize];
            f.read_exact(&mut buf).ok()?;
            Some(String::from_utf8_lossy(&buf).into_owned())
        })
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
        let mut out = HashMap::new();
        for (id, (st, progress, t)) in parse_log(&text, start_time_from_name(&name)) {
            if st != "Updating" && st != "DependencyUpdate" {
                continue;
            }
            if t.map_or(false, |t| now - t > 120_000) {
                continue;
            }
            out.insert(id, json!({ "state": "downloading", "progress": progress, "source": "Riot" }));
        }
        out
    }

    /// lockfile: Port + Passwort der lokalen Schnittstelle
    pub fn read_lockfile() -> Option<(u16, String, String)> {
        let text = std::fs::read_to_string(client_dir().join("Config").join("lockfile")).ok()?;
        let parts: Vec<&str> = text.trim().split(':').collect();
        let port = parts.get(2)?.parse().ok()?;
        let pw = parts.get(3)?.to_string();
        if pw.is_empty() {
            return None;
        }
        Some((port, pw, parts.get(4).map(|s| s.to_string()).unwrap_or_else(|| "https".into())))
    }

    pub async fn api(method: &str, path: &str, body: Option<Value>) -> (u16, String) {
        let Some((port, pw, proto)) = read_lockfile() else { return (0, String::new()) };
        let auth = base64::engine::general_purpose::STANDARD.encode(format!("riot:{pw}"));
        let m = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
        let mut r = crate::net::local()
            .request(m, format!("{proto}://127.0.0.1:{port}{path}"))
            .header("authorization", format!("Basic {auth}"))
            .timeout(std::time::Duration::from_secs(4));
        if let Some(b) = body {
            r = r.json(&b);
        }
        match r.send().await {
            Ok(res) => (res.status().as_u16(), res.text().await.unwrap_or_default()),
            Err(_) => (0, String::new()),
        }
    }

    /// Update eines Produkts ("league_of_legends.live") in die Warteschlange stellen
    pub async fn queue_patch(install_id: &str) -> bool {
        let (product, patchline) = install_id.rsplit_once('.').unwrap_or((install_id, "live"));
        let p = format!("/patch-proxy/v2/queue-patch/products/{}/patchlines/{}", crate::net::enc(product), crate::net::enc(patchline));
        let (st, _) = api("PUT", &p, Some(json!({}))).await;
        (200..300).contains(&st)
    }

    pub fn has_api() -> bool {
        read_lockfile().is_some()
    }
}

pub struct Riot;

#[async_trait]
impl Provider for Riot {
    fn id(&self) -> &str { "riot" }
    fn name(&self) -> &str { "Riot Games" }
    fn color(&self) -> &str { "#2b0d0f" }
    fn accent(&self) -> &str { "#ff4655" }
    fn platforms(&self) -> &[&str] { &["win32", "darwin"] }
    fn processes(&self) -> &[&str] { &["RiotClientUx", "Riot Client"] }
    fn processes_mac(&self) -> &[&str] { &["Riot Client", "RiotClientUx"] }

    async fn detect(&self) -> anyhow::Result<Detected> {
        let mut games = Vec::new();
        let mut installed = HashSet::new();
        let mut from_uninstall: Option<String> = None;
        for e in reg::uninstall_entries() {
            let v = &e.values;
            let un = reg::val_str(v, "UninstallString").unwrap_or_default();
            if !un.to_lowercase().contains("riotclientservices.exe") {
                continue;
            }
            let Some(product) = get_arg(&un, "uninstall-product") else { continue };
            let patchline = get_arg(&un, "uninstall-patchline").unwrap_or_else(|| "live".into());
            if product.eq_ignore_ascii_case("riot_client") || reg::val_str(v, "DisplayName").map_or(false, |n| n.eq_ignore_ascii_case("Riot Client")) {
                continue;
            }
            let client = clean_exe_path(&un);
            from_uninstall = Some(client.clone());
            installed.insert(product.clone());
            let id = format!("{product}.{patchline}");
            let mut g = json!({
                "nativeId": id, "name": reg::val_str(v, "DisplayName").unwrap_or_else(|| product.clone()),
                "installDir": v.get("InstallLocation"), "status": "installed", "covers": [],
                "iconUrl": format!("ghimg://riot/{id}"), "update": riot_update(&id).await,
                "launch": { "type": "exe", "target": client, "args": [format!("--launch-product={product}"), format!("--launch-patchline={patchline}")] },
            });
            if g["installDir"].is_null() {
                g.as_object_mut().unwrap().remove("installDir");
            }
            games.push(g);
        }
        let client = find_client(from_uninstall.as_deref()).await;
        if let (true, Some(c)) = (IS_MAC, &client) {
            for (product, patchline, dir) in installed_from_metadata().await {
                if !installed.insert(product.clone()) {
                    continue;
                }
                let id = format!("{product}.{patchline}");
                games.push(json!({
                    "nativeId": id, "name": PRODUCTS.iter().find(|p| p.0 == product).map(|p| p.1).unwrap_or(&product),
                    "installDir": dir, "status": "installed", "covers": [], "update": riot_update(&id).await,
                    "launch": { "type": "exe", "target": c.to_string_lossy(), "args": [format!("--launch-product={product}"), format!("--launch-patchline={patchline}")] },
                }));
            }
        }
        if let Some(c) = &client {
            for (id, name, win, mac) in PRODUCTS {
                if installed.contains(id) {
                    continue;
                }
                games.push(json!({
                    "nativeId": format!("{id}.live"), "name": name, "status": "notInstalled",
                    "platforms": { "windows": win, "mac": mac, "linux": false }, "covers": [],
                    "iconUrl": format!("ghimg://riot/{id}.live"),
                    "launch": { "type": "exe", "target": c.to_string_lossy(), "args": [format!("--launch-product={id}"), "--launch-patchline=live"] },
                }));
            }
        }
        Ok(games.into())
    }

    async fn updates(&self) -> Option<Vec<Value>> {
        let mut map: HashMap<String, Value> = HashMap::new();
        for id in list_dir(riot_dir().join("Metadata")).await {
            if !id.ends_with(".live") {
                continue;
            }
            let u = riot_update(&id).await;
            if !u.is_null() {
                map.insert(id, u);
            }
        }
        for (id, live) in client::live_updates().await {
            if id.starts_with("riot_client.") {
                continue;
            }
            let mut base = map.remove(&id).unwrap_or(json!({}));
            for (k, v) in live.as_object().unwrap() {
                base[k] = v.clone();
            }
            map.insert(id, base);
        }
        Some(map.into_iter().map(|(id, u)| json!({ "nativeId": id, "update": u })).collect())
    }

    async fn client(&self) -> Option<Value> {
        exe_launch(find_client(None).await.as_deref(), &[])
    }
    fn store(&self) -> Option<Value> {
        Some(json!({ "type": "url", "target": "https://www.riotgames.com/de" }))
    }
    fn has_background_update(&self) -> bool {
        true
    }
    /// Update über die lokale Schnittstelle des Riot Client; läuft er nicht, unsichtbar starten
    async fn background_update(&self, game: &Value) -> Option<Value> {
        let id = game["nativeId"].as_str().unwrap_or("");
        if client::queue_patch(id).await {
            return Some(json!({ "type": "none" }));
        }
        let c = find_client(None).await?;
        if !client::has_api() {
            let cs = c.to_string_lossy().into_owned();
            let _ = if IS_MAC {
                crate::running::spawn_detached("open", &["-g".into(), "-a".into(), cs], None)
            } else {
                crate::running::spawn_detached(&cs, &[], None)
            };
            for _ in 0..20 {
                if client::has_api() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
        for _ in 0..5 {
            if client::queue_patch(id).await {
                return Some(json!({ "type": "none" }));
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn log_zeilen() {
        let t = "12.5|INFO| HandleProductPatchlineStatusUpdate: productId: valorant, patchlineId: live, status: Updating, progress: 42.0\n";
        let m = super::client::parse_log(t, Some(1000));
        let (st, p, ts) = &m["valorant.live"];
        assert_eq!(st, "Updating");
        assert!((p - 0.42).abs() < 1e-9);
        assert_eq!(*ts, Some(13500));
    }
}
