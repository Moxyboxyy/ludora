//! GOG Galaxy-Datenbank (entspricht electron/lib/galaxy.js): besessene Spiele aller über Galaxy
//! verbundenen Plattformen, installierte GOG-Spiele (macOS) und laufende Downloads.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use crate::sqlite::{self, s};
use crate::util::*;

#[derive(Clone, Debug)]
pub struct Owned {
    pub release_key: String,
    pub platform: String,
    pub id: String,
    pub name: String,
    pub covers: Vec<String>,
    pub wides: Vec<String>,
}

static CACHE: Lazy<Mutex<Option<Vec<Owned>>>> = Lazy::new(|| Mutex::new(None));

pub fn db_path() -> PathBuf {
    if IS_MAC {
        return mac_shared(&["GOG.com", "Galaxy", "Storage", "galaxy-2.0.db"]);
    }
    let pd = env("PROGRAMDATA");
    PathBuf::from(if pd.is_empty() { r"C:\ProgramData".into() } else { pd }).join(r"GOG.com\Galaxy\storage\galaxy-2.0.db")
}

pub fn clear_cache() {
    *CACHE.lock() = None;
}

/// Installierte GOG-Spiele (macOS): [(id, Pfad)]
pub async fn read_installed() -> Vec<(String, Option<String>)> {
    tokio::task::spawn_blocking(|| {
        let Some(db) = sqlite::open(db_path()) else { return vec![] };
        if !db.tables().contains("InstalledBaseProducts") {
            return vec![];
        }
        let cols = db.columns("InstalledBaseProducts");
        let re = regex::Regex::new(r"(?i)path|location|directory").unwrap();
        let path_col = cols.iter().find(|c| re.is_match(c)).cloned();
        let sql = match &path_col {
            Some(c) => format!("SELECT productId AS id, \"{c}\" AS path FROM InstalledBaseProducts"),
            None => "SELECT productId AS id FROM InstalledBaseProducts".into(),
        };
        db.all(&sql).into_iter().filter_map(|r| Some((s(&r, "id")?, s(&r, "path")))).collect()
    })
    .await
    .unwrap_or_default()
}

fn read_owned_sync() -> Vec<Owned> {
    let Some(db) = sqlite::open(db_path()) else { return vec![] };
    let tables = db.tables();
    if !tables.contains("GamePieces") || !tables.contains("GamePieceTypes") {
        return vec![];
    }
    let mut keys: Vec<String> = Vec::new();
    if tables.contains("ProductPurchaseDates") {
        keys.extend(db.all("SELECT DISTINCT gameReleaseKey AS k FROM ProductPurchaseDates").iter().filter_map(|r| s(r, "k")));
    }
    if tables.contains("LibraryReleases") {
        keys.extend(db.all("SELECT DISTINCT releaseKey AS k FROM LibraryReleases").iter().filter_map(|r| s(r, "k")));
    }
    let mut seen = HashSet::new();
    keys.retain(|k| seen.insert(k.clone()));
    if keys.is_empty() {
        return vec![];
    }
    let mut hidden = HashSet::new();
    if tables.contains("ReleaseProperties") {
        let cols = db.columns("ReleaseProperties");
        let mut conds = vec![];
        if cols.contains("isDlc") {
            conds.push("isDlc = 1");
        }
        if cols.contains("isVisibleInLibrary") {
            conds.push("isVisibleInLibrary = 0");
        }
        if !conds.is_empty() {
            for r in db.all(&format!("SELECT releaseKey FROM ReleaseProperties WHERE {}", conds.join(" OR "))) {
                if let Some(k) = s(&r, "releaseKey") {
                    hidden.insert(k);
                }
            }
        }
    }
    let mut pieces: HashMap<String, HashMap<String, Value>> = HashMap::new();
    for r in db.all(
        "SELECT gp.releaseKey AS k, t.type AS type, gp.value AS value FROM GamePieces gp JOIN GamePieceTypes t ON t.id = gp.gamePieceTypeId WHERE t.type IN ('title', 'originalTitle', 'originalImages', 'images')",
    ) {
        let (Some(k), Some(ty)) = (s(&r, "k"), s(&r, "type")) else { continue };
        let v = s(&r, "value").and_then(|x| serde_json::from_str(&x).ok()).unwrap_or(Value::Null);
        pieces.entry(k).or_default().insert(ty, v);
    }
    let fix = |u: Option<&str>| -> Vec<String> {
        u.filter(|x| !x.is_empty()).map(|x| if x.starts_with("//") { format!("https:{x}") } else { x.to_string() }).into_iter().collect()
    };
    let mut out = Vec::new();
    for rk in keys {
        if hidden.contains(&rk) {
            continue;
        }
        let empty = HashMap::new();
        let p = pieces.get(&rk).unwrap_or(&empty);
        let name = p.get("title").and_then(|t| t["title"].as_str()).or_else(|| p.get("originalTitle").and_then(|t| t["title"].as_str()));
        let Some(name) = name.filter(|n| !n.is_empty()) else { continue };
        let img = p.get("images").filter(|v| !v.is_null()).or_else(|| p.get("originalImages")).cloned().unwrap_or(json!({}));
        let (platform, id) = match rk.find('_') {
            Some(i) if i > 0 => (rk[..i].to_string(), rk[i + 1..].to_string()),
            _ => (rk.clone(), rk.clone()),
        };
        out.push(Owned {
            platform,
            id,
            name: name.to_string(),
            covers: fix(img["verticalCover"].as_str()),
            wides: fix(img["background"].as_str()),
            release_key: rk,
        });
    }
    out
}

pub async fn read_owned() -> Vec<Owned> {
    if let Some(c) = CACHE.lock().clone() {
        return c;
    }
    let list = tokio::task::spawn_blocking(read_owned_sync).await.unwrap_or_default();
    *CACHE.lock() = Some(list.clone());
    list
}

/// Besessene Spiele bestimmter Plattformen ('gog', 'uplay', 'battlenet' …)
pub async fn owned_for(platforms: &[&str]) -> Vec<Owned> {
    read_owned().await.into_iter().filter(|o| platforms.contains(&o.platform.as_str())).collect()
}

/// Besessene, nicht installierte Spiele aus Galaxy ergänzen; make_launch None = überspringen
pub async fn add_owned(mut games: Vec<Value>, platforms: &[&str], make_launch: impl Fn(&Owned) -> Option<Value>) -> Vec<Value> {
    let mut have: HashSet<String> = games.iter().map(|g| normalize(g["name"].as_str().unwrap_or(""))).collect();
    for o in owned_for(platforms).await {
        let key = normalize(&o.name);
        if key.is_empty() || have.contains(&key) {
            continue;
        }
        let Some(launch) = make_launch(&o) else { continue };
        have.insert(key);
        games.push(json!({
            "nativeId": format!("galaxy:{}", o.release_key), "name": o.name, "status": "notInstalled",
            "covers": o.covers, "wides": o.wides, "launch": launch,
        }));
    }
    games
}

/// Zahl als Anteil 0..1 deuten (GOG speichert je nach Version Bytes, Prozent oder Anteil)
pub fn as_fraction(v: Option<f64>, size: f64) -> Option<f64> {
    let v = v?;
    if !v.is_finite() || v < 0.0 {
        return None;
    }
    if v <= 1.0 {
        return Some(v);
    }
    if size > 100.0 && v <= size {
        return Some(v / size);
    }
    if v <= 100.0 {
        return Some(v / 100.0);
    }
    None
}

/// Laufende Installationen/Updates aus Galaxys jobs.db: productId -> update
pub async fn read_jobs() -> HashMap<String, Value> {
    tokio::task::spawn_blocking(|| {
        let mut out = HashMap::new();
        let file = db_path().parent().map(|d| d.join("jobs.db")).unwrap_or_default();
        let Some(db) = sqlite::open(file) else { return out };
        let tables = db.tables();
        for (table, kind) in [("InstallProductJobs", "install"), ("UpdateProductJobs", "update")] {
            if !tables.contains(table) {
                continue;
            }
            for r in db.all(&format!("SELECT * FROM \"{table}\"")) {
                let size = sqlite::f(&r, "downloadSize").unwrap_or(0.0);
                let progress = as_fraction(sqlite::f(&r, "overallDownloadProgress").or_else(|| sqlite::f(&r, "downloadProgress")), size);
                let dl = as_fraction(sqlite::f(&r, "downloadProgress"), size);
                let verifying = sqlite::f(&r, "isVerifying").unwrap_or(0.0) != 0.0;
                let u = super::steam::strip_nulls(json!({
                    "state": "downloading", "progress": progress,
                    "bytesTotal": if size > 0.0 { json!(size) } else { Value::Null },
                    "bytesDone": match dl { Some(d) if size > 0.0 => json!((d * size).round()), _ => Value::Null },
                    "firstInstall": kind == "install",
                    "detail": if verifying { json!(t("Überprüfen")) } else { Value::Null },
                    "source": "GOG Galaxy",
                }));
                if let Some(id) = s(&r, "productId") {
                    out.insert(id, u);
                }
            }
        }
        out
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    #[test]
    fn anteile() {
        use super::as_fraction;
        assert_eq!(as_fraction(Some(0.5), 0.0), Some(0.5));
        assert_eq!(as_fraction(Some(50.0), 0.0), Some(0.5));
        assert_eq!(as_fraction(Some(500.0), 1000.0), Some(0.5));
        assert_eq!(as_fraction(Some(-1.0), 0.0), None);
    }
}
