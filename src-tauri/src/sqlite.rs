//! Fremde SQLite-Datenbanken (GOG Galaxy, Amazon, Lutris) nur lesen – ohne sie zu sperren.
//! Wie in der Electron-Version (sql.js) wird eine Kopie im Speicher geöffnet, damit der Launcher
//! ungestört weiterschreiben kann.

use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::Path;

pub struct Db {
    conn: Connection,
}

/// Datenbank als Kopie öffnen; None, wenn die Datei fehlt oder kaputt ist
pub fn open(file: impl AsRef<Path>) -> Option<Db> {
    let bytes = std::fs::read(file.as_ref()).ok()?;
    let tmp = std::env::temp_dir().join(format!("ludora-db-{}-{}.sqlite", std::process::id(), uuid::Uuid::new_v4()));
    std::fs::write(&tmp, &bytes).ok()?;
    let conn = Connection::open_with_flags(&tmp, OpenFlags::SQLITE_OPEN_READ_ONLY).ok();
    // Datei sofort wieder löschen (unter Linux/macOS bleibt sie offen lesbar; unter Windows erst beim Schließen)
    let conn = conn?;
    let db = Db { conn };
    #[cfg(not(windows))]
    let _ = std::fs::remove_file(&tmp);
    #[cfg(windows)]
    TEMP_FILES.lock().push(tmp);
    Some(db)
}

#[cfg(windows)]
static TEMP_FILES: once_cell::sync::Lazy<parking_lot::Mutex<Vec<std::path::PathBuf>>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(Vec::new()));

#[cfg(windows)]
impl Drop for Db {
    fn drop(&mut self) {
        // Verbindung ist nach drop geschlossen -> alte Kopien aufräumen
        let mut list = TEMP_FILES.lock();
        list.retain(|p| std::fs::remove_file(p).is_err() && p.exists());
    }
}

fn to_json(v: rusqlite::types::ValueRef) -> Value {
    use rusqlite::types::ValueRef::*;
    match v {
        Null => Value::Null,
        Integer(i) => Value::from(i),
        Real(f) => Value::from(f),
        Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        Blob(b) => Value::String(String::from_utf8_lossy(b).into_owned()),
    }
}

impl Db {
    /// SELECT als Liste von Objekten
    pub fn all(&self, sql: &str) -> Vec<Map<String, Value>> {
        let Ok(mut stmt) = self.conn.prepare(sql) else { return vec![] };
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let Ok(mut rows) = stmt.query([]) else { return vec![] };
        let mut out = Vec::new();
        while let Ok(Some(r)) = rows.next() {
            let mut m = Map::new();
            for (i, n) in names.iter().enumerate() {
                m.insert(n.clone(), r.get_ref(i).map(to_json).unwrap_or(Value::Null));
            }
            out.push(m);
        }
        out
    }

    pub fn tables(&self) -> HashSet<String> {
        self.all("SELECT name FROM sqlite_master WHERE type='table'")
            .into_iter()
            .filter_map(|r| r.get("name").and_then(|v| v.as_str()).map(String::from))
            .collect()
    }

    pub fn columns(&self, table: &str) -> HashSet<String> {
        self.all(&format!("PRAGMA table_info(\"{}\")", table.replace('"', "")))
            .into_iter()
            .filter_map(|r| r.get("name").and_then(|v| v.as_str()).map(String::from))
            .collect()
    }
}

/// Zeilenwert als String (Zahlen werden zu Text)
pub fn s(row: &Map<String, Value>, key: &str) -> Option<String> {
    match row.get(key)? {
        Value::String(x) if !x.is_empty() => Some(x.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub fn f(row: &Map<String, Value>, key: &str) -> Option<f64> {
    match row.get(key)? {
        Value::Number(n) => n.as_f64(),
        Value::String(x) => x.parse().ok(),
        _ => None,
    }
}
