//! Rockstar Games Launcher

use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::{galaxy, Detected, Provider};
use crate::reg;
use crate::util::*;

async fn find_launcher() -> Option<PathBuf> {
    let dir = reg::get_string(r"HKLM\SOFTWARE\WOW6432Node\Rockstar Games\Launcher", "InstallFolder")?;
    let exe = PathBuf::from(dir).join("Launcher.exe");
    if exists(&exe).await { Some(exe) } else { None }
}

const FOLDER_TITLES: [(&str, &str); 12] = [
    ("gta v", "Grand Theft Auto V Legacy"),
    ("gtav", "Grand Theft Auto V Legacy"),
    ("gtav enhanced", "Grand Theft Auto V Enhanced"),
    ("gta iii definitive edition", "Grand Theft Auto III – The Definitive Edition"),
    ("gta vice city definitive edition", "Grand Theft Auto: Vice City – The Definitive Edition"),
    ("gta san andreas definitive edition", "Grand Theft Auto: San Andreas – The Definitive Edition"),
    ("red dead redemption 2", "Red Dead Redemption 2"),
    ("red dead redemption", "Red Dead Redemption"),
    ("l.a. noire", "L.A. Noire"),
    ("max payne 3", "Max Payne 3"),
    ("bully", "Bully: Scholarship Edition"),
    ("gta iv", "Grand Theft Auto IV"),
];

async fn played_titles() -> Vec<String> {
    let mut roots = vec![];
    if !env("LOCALAPPDATA").is_empty() {
        roots.push(PathBuf::from(env("LOCALAPPDATA")).join("Rockstar Games"));
    }
    if !env("USERPROFILE").is_empty() {
        roots.push(PathBuf::from(env("USERPROFILE")).join("Documents").join("Rockstar Games"));
    }
    let mut titles: Vec<String> = Vec::new();
    for r in roots {
        for d in list_dir(&r).await {
            if let Some((_, t)) = FOLDER_TITLES.iter().find(|(k, _)| *k == d.to_lowercase()) {
                if !titles.iter().any(|x| x == t) {
                    titles.push(t.to_string());
                }
            }
        }
    }
    titles
}

fn launcher_launch(l: &Path, args: &[&str]) -> Value {
    exe_launch(Some(l), args).unwrap()
}

pub struct Rockstar;

#[async_trait]
impl Provider for Rockstar {
    fn id(&self) -> &str { "rockstar" }
    fn name(&self) -> &str { "Rockstar" }
    fn color(&self) -> &str { "#2a2306" }
    fn accent(&self) -> &str { "#fcaf17" }
    fn processes(&self) -> &[&str] { &["Launcher", "LauncherPatcher"] }

    async fn detect(&self) -> anyhow::Result<Detected> {
        let launcher = find_launcher().await;
        let mut games = Vec::new();
        for e in reg::uninstall_entries() {
            let v = &e.values;
            if !reg::val_str(v, "Publisher").unwrap_or_default().to_lowercase().contains("rockstar games") {
                continue;
            }
            let name = reg::val_str(v, "DisplayName").unwrap_or_default();
            let lower = name.to_lowercase();
            if lower.contains("launcher") || lower.contains("social club") {
                continue;
            }
            let Some(dir) = reg::val_str(v, "InstallLocation").map(|d| norm_path(&d.replace('"', ""))) else { continue };
            let dl = dir.to_string_lossy().to_lowercase();
            if dl.contains("steamapps") || dl.contains("epic games") {
                continue;
            }
            let launch = match &launcher {
                Some(l) => launcher_launch(l, &["-launchTitleInFolder", &dir.to_string_lossy()]),
                None => {
                    let exe = clean_exe_path(&reg::val_str(v, "DisplayIcon").unwrap_or_default());
                    if exe.is_empty() {
                        continue;
                    }
                    json!({ "type": "exe", "target": exe, "args": [], "cwd": dir.to_string_lossy() })
                }
            };
            games.push(json!({
                "nativeId": e.name, "name": name, "installDir": dir.to_string_lossy(), "status": "installed", "covers": [], "launch": launch,
            }));
        }
        let mut have: HashSet<String> = games.iter().map(|g| normalize(g["name"].as_str().unwrap_or(""))).collect();
        for title in played_titles().await {
            let key = normalize(&title);
            if !have.insert(key.clone()) {
                continue;
            }
            games.push(json!({
                "nativeId": format!("played:{key}"), "name": title, "status": "notInstalled", "covers": [],
                "launch": match &launcher {
                    Some(l) => launcher_launch(l, &[]),
                    None => json!({ "type": "url", "target": "https://www.rockstargames.com/de/downloads" }),
                },
            }));
        }
        let l2 = launcher.clone();
        let games = galaxy::add_owned(games, &["rockstar"], move |_| l2.as_ref().map(|l| launcher_launch(l, &[]))).await;
        Ok(games.into())
    }
    async fn client(&self) -> Option<Value> {
        exe_launch(find_launcher().await.as_deref(), &[])
    }
    fn store(&self) -> Option<Value> {
        Some(json!({ "type": "url", "target": "https://store.rockstargames.com/de" }))
    }
}
