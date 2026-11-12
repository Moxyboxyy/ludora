//! Eigene Launcher (custom-launchers.json im Datenordner): Name, optional das Launcher-Programm und ein
//! Spieleordner. Spiele kommen aus dem Ordner (jeder Unterordner = ein Spiel) und aus den eigenen Spielen,
//! die diesem Launcher zugeordnet sind. Keine Freundesliste, keine Updates – nur der Launcher mit seinen Spielen.

use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{Detected, Provider, P};
use crate::util::*;

fn store_file() -> PathBuf {
    crate::paths::data_dir().join("custom-launchers.json")
}

pub fn load() -> Vec<Value> {
    std::fs::read_to_string(store_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|l| l["id"].as_str().is_some_and(is_custom_id) && !l["name"].as_str().unwrap_or("").trim().is_empty())
        .collect()
}

fn save(list: &[Value]) {
    let f = store_file();
    if let Some(d) = f.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(f, serde_json::to_string_pretty(list).unwrap_or_default());
}

pub fn is_custom_id(id: &str) -> bool {
    crate::re!(r"^x-[0-9a-f]{8}$").is_match(id)
}

/// Neuer Launcher; Fehlertext, wenn etwas nicht passt
pub fn add(name: &str, exe: &str, folder: &str) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(t("Bitte einen Namen eingeben."));
    }
    if name.chars().count() > 40 {
        return Err(t("Der Name ist zu lang (höchstens 40 Zeichen)."));
    }
    if exe.is_empty() && folder.is_empty() {
        return Err(t("Wähle das Programm des Launchers oder einen Spieleordner (oder beides)."));
    }
    if !folder.is_empty() && !Path::new(folder).is_dir() {
        return Err(t("Der Spieleordner wurde nicht gefunden."));
    }
    let mut list = load();
    if list.iter().any(|l| l["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name))) {
        return Err(t_args("Einen Launcher „{0}“ gibt es schon.", &[name]));
    }
    let id = format!("x-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let entry = json!({ "id": id, "name": name, "exe": exe, "folder": folder });
    list.push(entry.clone());
    save(&list);
    Ok(entry)
}

/// Launcher entfernen; seine einzeln hinzugefügten Spiele wandern zu „Eigene Spiele“
pub fn remove(id: &str) {
    save(&load().into_iter().filter(|l| l["id"] != id).collect::<Vec<_>>());
    super::manual::reassign(id, "manual");
}

/// Farbe aus dem Namen (damit jeder eigene Launcher seine eigene Plakette hat)
fn accent_of(id: &str) -> String {
    const COLORS: [&str; 8] = ["#7c9cff", "#ff9f6b", "#6be3a1", "#ffc857", "#d78bff", "#5fd3e8", "#ff7aa2", "#a6e36b"];
    let n = id.bytes().fold(0usize, |a, b| a.wrapping_mul(31).wrapping_add(b as usize));
    COLORS[n % COLORS.len()].to_string()
}

pub struct Custom {
    id: String,
    name: String,
    exe: String,
    folder: String,
    accent: String,
}

pub fn providers() -> Vec<P> {
    load()
        .into_iter()
        .map(|l| {
            let id = l["id"].as_str().unwrap_or("").to_string();
            Arc::new(Custom {
                accent: accent_of(&id),
                id,
                name: l["name"].as_str().unwrap_or("").trim().to_string(),
                exe: l["exe"].as_str().unwrap_or("").to_string(),
                folder: l["folder"].as_str().unwrap_or("").to_string(),
            }) as P
        })
        .collect()
}

/// Spiele in einem Ordner: jeder Unterordner mit einer passenden Programmdatei (Mac: jedes .app)
pub fn scan_folder(folder: &Path) -> Vec<(String, String, PathBuf, PathBuf)> {
    let mut out = vec![];
    let Ok(rd) = std::fs::read_dir(folder) else { return out };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.starts_with('$') {
            continue;
        }
        let path = e.path();
        if IS_MAC && name.to_lowercase().ends_with(".app") {
            out.push((name.clone(), name.trim_end_matches(".app").to_string(), path.clone(), folder.to_path_buf()));
            continue;
        }
        if !path.is_dir() {
            continue;
        }
        let exe = if IS_MAC {
            std::fs::read_dir(&path).ok().and_then(|r| r.flatten().map(|x| x.path()).find(|p| p.extension().is_some_and(|x| x == "app")))
        } else {
            crate::icons::guess_game_exe(&path).or_else(|| if IS_LINUX { guess_linux_exe(&path) } else { None })
        };
        if let Some(exe) = exe {
            out.push((name.clone(), name, exe, path));
        }
    }
    out
}

/// Linux: größte ausführbare Datei (ohne Endung, .x86_64 oder .sh) im Ordner
fn guess_linux_exe(dir: &Path) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let ok_ext = crate::re!(r"(?i)^[^.]+$|\.(x86_64|x86|sh|run)$");
        let mut found: Vec<(PathBuf, u64)> = std::fs::read_dir(dir)
            .ok()?
            .flatten()
            .filter_map(|e| {
                let m = e.metadata().ok()?;
                let n = e.file_name().to_string_lossy().into_owned();
                (m.is_file() && m.permissions().mode() & 0o111 != 0 && ok_ext.is_match(&n)).then(|| (e.path(), m.len()))
            })
            .collect();
        found.sort_by(|a, b| b.1.cmp(&a.1));
        found.into_iter().next().map(|x| x.0)
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        None
    }
}

#[async_trait]
impl Provider for Custom {
    fn id(&self) -> &str {
        &self.id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn color(&self) -> &str {
        "#1d2230"
    }
    fn accent(&self) -> &str {
        &self.accent
    }
    fn platforms(&self) -> &[&str] {
        &["win32", "darwin", "linux"]
    }
    fn has_client(&self) -> bool {
        !self.exe.is_empty()
    }
    async fn client(&self) -> Option<Value> {
        if self.exe.is_empty() {
            return None;
        }
        let dir = Path::new(&self.exe).parent().map(|d| d.to_string_lossy().into_owned());
        Some(json!({ "type": "exe", "target": self.exe, "args": [], "cwd": dir }))
    }

    async fn detect(&self) -> anyhow::Result<Detected> {
        let mut games: Vec<Value> = super::manual::load().iter().filter(|g| g["launcher"] == self.id.as_str()).map(super::manual::to_game).collect();
        if !self.folder.is_empty() {
            let folder = PathBuf::from(&self.folder);
            if !folder.is_dir() {
                return Ok(Detected { games, warning: Some(t_args("Spieleordner nicht gefunden: {0}", &[&self.folder])) });
            }
            let found = tokio::task::spawn_blocking(move || scan_folder(&folder)).await.unwrap_or_default();
            for (key, name, exe, dir) in found {
                let exe_s = exe.to_string_lossy().into_owned();
                if games.iter().any(|g| g["launch"]["target"] == exe_s.as_str()) {
                    continue; // schon einzeln hinzugefügt
                }
                let dir_s = dir.to_string_lossy().into_owned();
                games.push(json!({
                    "nativeId": format!("dir:{key}"), "name": name, "installDir": dir_s,
                    "status": "installed", "covers": [],
                    "launch": { "type": "exe", "target": exe_s, "args": [], "cwd": dir_s },
                }));
            }
        }
        Ok(games.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert!(is_custom_id("x-0a1b2c3d"));
        assert!(!is_custom_id("steam"));
        assert!(!is_custom_id("x-../../a"));
    }

    #[test]
    fn ordner() {
        let dir = std::env::temp_dir().join(format!("ludora-custom-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Cool Game")).unwrap();
        std::fs::create_dir_all(dir.join("Leer")).unwrap();
        std::fs::write(dir.join("Cool Game").join("CoolGame.exe"), vec![0u8; 2048]).unwrap();
        std::fs::write(dir.join("Cool Game").join("unins000.exe"), vec![0u8; 9999]).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::create_dir_all(dir.join("Native")).unwrap();
            let f = dir.join("Native").join("native.x86_64");
            std::fs::write(&f, b"x").unwrap();
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let found = scan_folder(&dir);
        let cool = found.iter().find(|f| f.1 == "Cool Game").expect("Spiel gefunden");
        assert!(cool.2.ends_with("CoolGame.exe"));
        assert!(!found.iter().any(|f| f.1 == "Leer"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
