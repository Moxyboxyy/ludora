//! EA app (entspricht electron/providers/ea.js)

use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::{galaxy, Detected, Provider};
use crate::reg;
use crate::util::*;

const SLUG_NAMES: [(&str, &str); 16] = [
    ("skate", "skate."),
    ("ea-sports-fc-26", "EA SPORTS FC 26"),
    ("ea-sports-fc-25", "EA SPORTS FC 25"),
    ("ea-sports-fc-24", "EA SPORTS FC 24"),
    ("battlefield-5", "Battlefield V"),
    ("battlefield-6", "Battlefield 6"),
    ("star-wars-battlefront-2", "Star Wars Battlefront II"),
    ("star-wars-battlefront", "Star Wars Battlefront"),
    ("star-wars-jedi-fallen-order", "Star Wars Jedi: Fallen Order"),
    ("star-wars-jedi-survivor", "Star Wars Jedi: Survivor"),
    ("the-sims-4", "The Sims 4"),
    ("jade-empire", "Jade Empire: Special Edition"),
    ("battlefield-1942", "Battlefield 1942"),
    ("dead-space-classic", "Dead Space (2008)"),
    ("a-way-out", "A Way Out"),
    ("it-takes-two", "It Takes Two"),
];

pub fn slug_to_name(slug: &str) -> String {
    if let Some((_, n)) = SLUG_NAMES.iter().find(|(s, _)| *s == slug) {
        return n.to_string();
    }
    let up = Regex::new(r"^(ii|iii|iv|vi|fc|ea|nfs|ufc|nhl|nba|f1)$").unwrap();
    slug.split('-')
        .map(|w| {
            if up.is_match(w) {
                w.to_uppercase()
            } else {
                let mut c = w.chars();
                c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Spiele aus den EA-app-Protokollen mit letztem bekannten Status: (slug, name, installiert)
async fn library_from_logs() -> Vec<(String, String, bool)> {
    let local = env("LOCALAPPDATA");
    if local.is_empty() {
        return vec![];
    }
    let dir = PathBuf::from(local).join(r"Electronic Arts\EA Desktop\Logs");
    let re = Regex::new(r"baseSlug=\[([a-z0-9-]+)\] installedStatus=\[(\w+)\]").unwrap();
    let mut status: Vec<(String, String)> = Vec::new();
    for f in ["EADesktop.bak", "EADesktop.log"] {
        let Some(text) = read_text(dir.join(f)).await else { continue };
        for c in re.captures_iter(&text) {
            let slug = c[1].to_string();
            status.retain(|(s, _)| *s != slug);
            status.push((slug, c[2].to_string()));
        }
    }
    status.into_iter().map(|(slug, st)| (slug.clone(), slug_to_name(&slug), st != "NotInstalled")).collect()
}

pub async fn find_ea_app() -> Option<PathBuf> {
    let from_reg = reg::get_first_string(&[
        (r"HKLM\SOFTWARE\Electronic Arts\EA Desktop", "DesktopAppPath"),
        (r"HKLM\SOFTWARE\Electronic Arts\EA Desktop", "LauncherAppPath"),
    ])
    .map(|s| PathBuf::from(clean_exe_path(&s)))
    .unwrap_or_default();
    let pf = { let x = env("ProgramFiles"); if x.is_empty() { r"C:\Program Files".into() } else { x } };
    first_existing(&[from_reg, PathBuf::from(pf).join(r"Electronic Arts\EA Desktop\EA Desktop\EADesktop.exe")]).await
}

pub struct Ea;

#[async_trait]
impl Provider for Ea {
    fn id(&self) -> &str { "ea" }
    fn name(&self) -> &str { "EA app" }
    fn color(&self) -> &str { "#3a0d12" }
    fn accent(&self) -> &str { "#ff4747" }
    fn processes(&self) -> &[&str] { &["EADesktop"] }

    async fn detect(&self) -> anyhow::Result<Detected> {
        let ignore = Regex::new(r"(?i)^(EA app|Origin|EA Desktop)").unwrap();
        let publisher_re = Regex::new(r"(?i)electronic arts|^ea\b").unwrap();
        let other_store = Regex::new(r"(?i)steamapps|epic games|ubisoft game launcher").unwrap();
        let bad_exe = Regex::new(r"(?i)uninst|cleanup|touchup").unwrap();
        let mut games = Vec::new();
        for e in reg::uninstall_entries() {
            let v = &e.values;
            let (Some(name), Some(loc)) = (reg::val_str(v, "DisplayName"), reg::val_str(v, "InstallLocation")) else { continue };
            let dir = norm_path(&loc.replace('"', ""));
            if ignore.is_match(&name) {
                continue;
            }
            let is_ea = publisher_re.is_match(&reg::val_str(v, "Publisher").unwrap_or_default());
            let has_installer = exists(dir.join("__Installer").join("installerdata.xml")).await;
            if !has_installer && !is_ea {
                continue;
            }
            if other_store.is_match(&dir.to_string_lossy()) {
                continue;
            }
            let exe = clean_exe_path(&reg::val_str(v, "DisplayIcon").unwrap_or_default());
            if exe.is_empty() || !exe.to_lowercase().ends_with(".exe") || bad_exe.is_match(&exe) || !exists(&exe).await {
                continue;
            }
            games.push(json!({
                "nativeId": e.name, "name": name, "installDir": dir.to_string_lossy(), "status": "installed", "covers": [],
                "launch": exe_launch(Some(Path::new(&exe)), &[]),
            }));
        }
        let mut have: HashSet<String> = games.iter().map(|g| normalize(g["name"].as_str().unwrap_or(""))).collect();
        let app = find_ea_app().await;
        for (slug, name, installed) in library_from_logs().await {
            let key = normalize(&name);
            if have.contains(&key) || have.contains(&normalize(&slug.replace('-', " "))) || installed {
                continue;
            }
            have.insert(key);
            games.push(json!({
                "nativeId": format!("slug:{slug}"), "name": name, "status": "notInstalled", "covers": [],
                "launch": exe_launch(app.as_deref(), &[]).unwrap_or_else(|| uri("origin2://library/open")),
            }));
        }
        let games = galaxy::add_owned(games, &["origin", "ea"], |o| {
            Some(uri(format!("origin2://game/launch?offerIds={}&autoDownload=1", crate::net::enc(&o.id))))
        })
        .await;
        Ok(games.into())
    }

    async fn client(&self) -> Option<Value> {
        exe_launch(find_ea_app().await.as_deref(), &[]).or_else(|| Some(uri("origin2://library/open")))
    }
    fn store(&self) -> Option<Value> {
        Some(json!({ "type": "url", "target": "https://www.ea.com/de/games" }))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn slugs() {
        assert_eq!(super::slug_to_name("ea-sports-fc-26"), "EA SPORTS FC 26");
        assert_eq!(super::slug_to_name("mass-effect-ii"), "Mass Effect II");
    }
}
