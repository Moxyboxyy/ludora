//! Chat-Verlauf für Riot/Epic (Steam hat einen eigenen Verlauf auf dem Server). Datei chat-log.json.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::path::PathBuf;

struct Log {
    file: Option<PathBuf>,
    data: Option<Map<String, Value>>,
    dirty: bool,
}

static LOG: Lazy<Mutex<Log>> = Lazy::new(|| Mutex::new(Log { file: None, data: None, dirty: false }));

pub fn init(file: PathBuf) {
    let mut l = LOG.lock();
    l.file = Some(file);
    l.data = None;
}

fn load(l: &mut Log) -> &mut Map<String, Value> {
    if l.data.is_none() {
        let d = l.file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default();
        l.data = Some(d);
    }
    l.data.as_mut().unwrap()
}

fn schedule_save() {
    {
        let mut l = LOG.lock();
        if l.dirty {
            return;
        }
        l.dirty = true;
    }
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let mut l = LOG.lock();
        l.dirty = false;
        if let (Some(f), Some(d)) = (l.file.clone(), l.data.clone()) {
            let _ = std::fs::write(f, serde_json::to_string(&Value::Object(d)).unwrap_or_default());
        }
    });
}

pub fn add(key: &str, msg: &Value) -> bool {
    {
        let mut l = LOG.lock();
        let d = load(&mut l);
        let list = d.entry(key.to_string()).or_insert(json!([])).as_array_mut().unwrap();
        let ts = msg["ts"].as_i64().unwrap_or_else(super::now);
        let from_me = msg["fromMe"] == true;
        let text = msg["text"].as_str().unwrap_or("").to_string();
        if list.iter().any(|m| m["ts"].as_i64() == Some(ts) && m["text"].as_str() == Some(&text) && (m["fromMe"] == true) == from_me) {
            return false;
        }
        list.push(json!({ "fromMe": from_me, "text": text, "ts": ts }));
        if list.len() > 200 {
            let n = list.len() - 200;
            list.drain(0..n);
        }
    }
    schedule_save();
    true
}

pub fn list(key: &str) -> Vec<Value> {
    let mut l = LOG.lock();
    load(&mut l).get(key).and_then(|v| v.as_array().cloned()).unwrap_or_default()
}
