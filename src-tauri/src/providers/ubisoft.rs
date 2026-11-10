//! Ubisoft Connect (entspricht electron/providers/ubisoft.js)

use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use super::{galaxy, Detected, Provider};
use crate::protobuf as pb;
use crate::reg;
use crate::util::*;

const INSTALLS_KEY: &str = r"HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs";
const ASSETS: &str = "https://ubistatic3-a.akamaihd.net/orbit/uplay_launcher_3_0/assets/";

fn launcher_dir() -> PathBuf {
    PathBuf::from(
        reg::get_string(r"HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher", "InstallDir")
            .unwrap_or_else(|| r"C:\Program Files (x86)\Ubisoft\Ubisoft Game Launcher".into()),
    )
}

async fn find_ubisoft_exe() -> Option<PathBuf> {
    let b = launcher_dir();
    first_existing(&[b.join("UbisoftConnect.exe"), b.join("upc.exe")]).await
}

fn yaml_value(yaml: &str, key: &str) -> Option<String> {
    let re = Regex::new(&format!(r"(?m)^\s{{2}}{}:\s*(.+?)\s*$", regex::escape(key))).ok()?;
    re.captures(yaml).map(|c| c[1].trim_matches(|ch| ch == '"' || ch == '\'').to_string())
}

/// "l1" / "GAMENAME" -> Text aus localizations.default
fn localize(yaml: &str, value: Option<String>) -> Option<String> {
    let v = value?;
    if !Regex::new(r"^(l\d+|[A-Z_]+)$").unwrap().is_match(&v) {
        return Some(v);
    }
    let block = Regex::new(r"(?m)^localizations:\s*\n\s+default:\s*\n((?:[ \t]{4,}.*\n?)+)").unwrap().captures(yaml)?;
    let re = Regex::new(&format!(r"(?m)^\s+{}:\s*(.+?)\s*$", regex::escape(&v))).ok()?;
    re.captures(&block[1]).map(|c| c[1].trim_matches(|ch| ch == '"' || ch == '\'').to_string())
}

/// configurations: Spiel-ID -> (Name, Bild)
pub fn read_configurations(buf: &[u8]) -> HashMap<u64, (String, Option<String>)> {
    let mut map = HashMap::new();
    let Some(top) = pb::decode(buf) else { return map };
    let img = Regex::new(r"(?i)\.(jpe?g|png)$").unwrap();
    let start = Regex::new(r"(?m)^\s+start_game:").unwrap();
    for f in top {
        let Some(msg) = pb::decode(f.bytes) else { continue };
        let (Some(id), Some(y)) = (pb::int(&msg, 1), pb::bytes(&msg, 3)) else { continue };
        let yaml = String::from_utf8_lossy(y);
        if !start.is_match(&yaml) {
            continue;
        }
        let Some(name) = localize(&yaml, yaml_value(&yaml, "name")) else { continue };
        let thumb = localize(&yaml, yaml_value(&yaml, "thumb_image")).filter(|t| img.is_match(t));
        map.insert(id, (name, thumb));
    }
    map
}

/// Ownership-Datei: Kopf unbekannter Länge + Protobuf -> (id, launchId, isAddon)
pub fn read_ownership(buf: &[u8]) -> Vec<(u64, u64, bool)> {
    for off in 0..buf.len().min(2048) {
        if buf[off] != 0x0a {
            continue;
        }
        let Some(top) = pb::decode_from(buf, off) else { continue };
        let products: Vec<_> = top.iter().filter(|f| f.field == 1 && f.wire == 2).collect();
        if (products.len() as f64) < top.len() as f64 * 0.3 {
            continue;
        }
        let mut out = Vec::new();
        let mut ok = true;
        for p in products {
            let Some(m) = pb::decode(p.bytes) else { ok = false; break };
            if let Some(id) = pb::int(&m, 1) {
                out.push((id, pb::int(&m, 2).filter(|x| *x != 0).unwrap_or(id), pb::int(&m, 6) == Some(1)));
            }
        }
        if ok && !out.is_empty() {
            return out;
        }
    }
    vec![]
}

async fn read_library() -> Vec<(u64, String, Option<String>)> {
    let cache = launcher_dir().join("cache");
    let Ok(cfg) = tokio::fs::read(cache.join("configuration").join("configurations")).await else { return vec![] };
    let configs = read_configurations(&cfg);
    if configs.is_empty() {
        return vec![];
    }
    let dir = cache.join("ownership");
    let mut files: Vec<(String, std::time::SystemTime)> = Vec::new();
    for f in list_dir(&dir).await {
        let t = tokio::fs::metadata(dir.join(&f)).await.and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
        files.push((f, t));
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    let Some((newest, _)) = files.first() else { return vec![] };
    let Ok(own) = tokio::fs::read(dir.join(newest)).await else { return vec![] };
    let steam_ver = Regex::new(r"(?i)\[?\bsteam\]?\s*$").unwrap();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (id, launch_id, addon) in read_ownership(&own) {
        if addon {
            continue;
        }
        let Some((name, thumb)) = configs.get(&id) else { continue };
        if steam_ver.is_match(name) || !seen.insert(normalize(name)) {
            continue;
        }
        out.push((launch_id, name.clone(), thumb.as_ref().map(|t| format!("{ASSETS}{t}"))));
    }
    out
}

pub struct Ubisoft;

#[async_trait]
impl Provider for Ubisoft {
    fn id(&self) -> &str { "ubisoft" }
    fn name(&self) -> &str { "Ubisoft Connect" }
    fn color(&self) -> &str { "#0e1a3a" }
    fn accent(&self) -> &str { "#5aa0ff" }
    fn processes(&self) -> &[&str] { &["upc", "UbisoftConnect"] }

    async fn detect(&self) -> anyhow::Result<Detected> {
        let uninstall = reg::uninstall_entries();
        let mut games: Vec<Value> = reg::sub_keys(INSTALLS_KEY)
            .into_iter()
            .filter_map(|e| {
                let dir = norm_path(&reg::val_str(&e.values, "InstallDir")?);
                let un = uninstall.iter().find(|u| u.name.to_lowercase() == format!("uplay install {}", e.name));
                let name = un
                    .and_then(|u| reg::val_str(&u.values, "DisplayName"))
                    .unwrap_or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
                Some(json!({
                    "nativeId": e.name, "name": name, "installDir": dir.to_string_lossy(), "status": "installed", "covers": [],
                    "launch": uri(format!("uplay://launch/{}/0", e.name)),
                }))
            })
            .collect();
        let ids: HashSet<String> = games.iter().map(|g| g["nativeId"].as_str().unwrap_or("").to_string()).collect();
        let names: HashSet<String> = games.iter().map(|g| normalize(g["name"].as_str().unwrap_or(""))).collect();
        for (id, name, thumb) in read_library().await {
            if ids.contains(&id.to_string()) || names.contains(&normalize(&name)) {
                continue;
            }
            games.push(json!({
                "nativeId": id.to_string(), "name": name, "status": "notInstalled", "covers": [],
                "ubisoftThumb": thumb, "launch": uri(format!("uplay://launch/{id}/0")),
            }));
        }
        let games = galaxy::add_owned(games, &["uplay", "ubisoft"], |o| {
            if o.id.chars().all(|c| c.is_ascii_digit()) { Some(uri(format!("uplay://launch/{}/0", o.id))) } else { None }
        })
        .await;
        Ok(games.into())
    }

    async fn client(&self) -> Option<Value> {
        exe_launch(find_ubisoft_exe().await.as_deref(), &[])
    }
    fn store(&self) -> Option<Value> {
        Some(json!({ "type": "url", "target": "https://store.ubisoft.com/de/home" }))
    }
}

#[allow(dead_code)]
fn _unused(_: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn konfiguration_und_besitz() {
        let yaml = "version: 2\nroot:\n  name: l1\n  thumb_image: abc.jpg\n  start_game:\n    online: 1\nlocalizations:\n  default:\n    l1: Far Cry 6\n";
        let mut entry = pb::Writer::default();
        entry.uint(1, 5266).bytes(3, yaml.as_bytes());
        let mut top = pb::Writer::default();
        top.bytes(1, &entry.buf);
        let c = read_configurations(&top.buf);
        assert_eq!(c[&5266].0, "Far Cry 6");
        assert_eq!(c[&5266].1.as_deref(), Some("abc.jpg"));

        let mut prod = pb::Writer::default();
        prod.uint(1, 5266).uint(2, 5267);
        let mut own = pb::Writer::default();
        own.bytes(1, &prod.buf);
        let mut file = vec![0xde, 0xad, 0x00];
        file.extend(&own.buf);
        assert_eq!(read_ownership(&file), vec![(5266, 5267, false)]);
    }
}
