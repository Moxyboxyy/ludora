//! Eigene Spiele – manual-games.json im Datenordner.

use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::Path;

use super::{Detected, Provider};

fn store_file() -> std::path::PathBuf {
    crate::paths::data_dir().join("manual-games.json")
}

pub fn load() -> Vec<Value> {
    std::fs::read_to_string(store_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok())
        .unwrap_or_default()
}

fn save(list: &[Value]) {
    let f = store_file();
    if let Some(d) = f.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(f, serde_json::to_string_pretty(list).unwrap_or_default());
}

pub fn add(name: &str, exe: &str, args: &str) -> Value {
    let mut list = load();
    let stem = Path::new(exe).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let entry = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "name": if name.trim().is_empty() { stem } else { name.to_string() },
        "exe": exe,
        "args": args,
    });
    list.push(entry.clone());
    save(&list);
    entry
}

pub fn remove(id: &str) {
    let list: Vec<Value> = load().into_iter().filter(|g| g["id"] != id).collect();
    save(&list);
}

/// "a \"b c\" d" -> ["a", "b c", "d"]
pub fn split_args(s: &str) -> Vec<String> {
    let re = crate::re!(r#"(?:[^\s"]+|"[^"]*")+"#);
    re.find_iter(s).map(|m| m.as_str().trim_matches('"').to_string()).collect()
}

pub struct Manual;

#[async_trait]
impl Provider for Manual {
    fn id(&self) -> &str { "manual" }
    fn name(&self) -> &str { "Eigene Spiele" }
    fn color(&self) -> &str { "#1f2a24" }
    fn accent(&self) -> &str { "#7ee2a8" }
    fn platforms(&self) -> &[&str] { &["win32", "darwin", "linux"] }
    fn has_client(&self) -> bool { false }

    async fn detect(&self) -> anyhow::Result<Detected> {
        Ok(load()
            .into_iter()
            .map(|g| {
                let exe = g["exe"].as_str().unwrap_or("").to_string();
                let dir = Path::new(&exe).parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
                json!({
                    "nativeId": g["id"], "name": g["name"], "installDir": dir,
                    "status": if Path::new(&exe).exists() { "installed" } else { "missing" },
                    "covers": [], "removable": true,
                    "launch": { "type": "exe", "target": exe, "args": split_args(g["args"].as_str().unwrap_or("")), "cwd": dir },
                })
            })
            .collect::<Vec<_>>()
            .into())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn argumente() {
        assert_eq!(super::split_args(r#"-w "C:\My Games" -x"#), vec!["-w", r"C:\My Games", "-x"]);
        assert!(super::split_args("").is_empty());
    }
}
