//! Einstellungen als JSON (settings.json im Datenordner) – gleiches Format wie die Electron-Version.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{Map, Value};
use std::path::PathBuf;

struct Store {
    file: PathBuf,
    cache: Option<Map<String, Value>>,
}

static STORE: Lazy<Mutex<Store>> = Lazy::new(|| {
    Mutex::new(Store { file: crate::paths::data_dir().join("settings.json"), cache: None })
});

/// Für Tests: eigene Datei verwenden
pub fn init_file(file: PathBuf) {
    let mut s = STORE.lock();
    s.file = file;
    s.cache = None;
}

fn load(s: &mut Store) -> &mut Map<String, Value> {
    if s.cache.is_none() {
        let map = std::fs::read_to_string(&s.file)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        s.cache = Some(map);
    }
    s.cache.as_mut().unwrap()
}

pub fn get_all() -> Map<String, Value> {
    let mut s = STORE.lock();
    load(&mut s).clone()
}

pub fn get(key: &str) -> Option<Value> {
    let mut s = STORE.lock();
    load(&mut s).get(key).cloned().filter(|v| !v.is_null())
}

pub fn get_str(key: &str, fallback: &str) -> String {
    get(key).and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| fallback.to_string())
}

pub fn get_bool(key: &str, fallback: bool) -> bool {
    get(key).and_then(|v| v.as_bool()).unwrap_or(fallback)
}

/// Felder übernehmen und sofort speichern
pub fn set(patch: Map<String, Value>) -> Map<String, Value> {
    let mut s = STORE.lock();
    let file = s.file.clone();
    let map = load(&mut s);
    for (k, v) in patch {
        map.insert(k, v);
    }
    let out = map.clone();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&file, serde_json::to_string_pretty(&out).unwrap_or_default());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn liest_und_schreibt_wie_electron() {
        let dir = std::env::temp_dir().join(format!("ludora-settings-{}", std::process::id()));
        let file = dir.join("settings.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&file, r#"{ "language": "de", "favorites": ["steam:1"] }"#).unwrap();
        init_file(file.clone());
        assert_eq!(get_str("language", "en"), "de");
        assert_eq!(get_str("fehlt", "x"), "x");
        let mut p = Map::new();
        p.insert("closeToTray".into(), json!(false));
        set(p);
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(saved["language"], "de");
        assert_eq!(saved["closeToTray"], false);
        assert_eq!(saved["favorites"][0], "steam:1");
        let _ = std::fs::remove_dir_all(dir);
    }
}
