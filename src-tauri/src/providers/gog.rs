//! GOG (entspricht electron/providers/gog.js)

use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::{galaxy, Detected, Provider};
use crate::reg;
use crate::util::*;

const GAMES_KEY: &str = r"HKLM\SOFTWARE\WOW6432Node\GOG.com\Games";

pub async fn find_galaxy() -> Option<PathBuf> {
    if IS_MAC {
        return first_existing(&[PathBuf::from("/Applications/GOG Galaxy.app"), home().join("Applications/GOG Galaxy.app")]).await;
    }
    let dir = reg::get_first_string(&[
        (r"HKLM\SOFTWARE\WOW6432Node\GOG.com\GalaxyClient\paths", "client"),
        (r"HKLM\SOFTWARE\GOG.com\GalaxyClient\paths", "client"),
    ])?;
    let exe = PathBuf::from(dir).join("GalaxyClient.exe");
    if exists(&exe).await { Some(exe) } else { None }
}

pub struct Gog;

#[async_trait]
impl Provider for Gog {
    fn id(&self) -> &str { "gog" }
    fn name(&self) -> &str { "GOG" }
    fn color(&self) -> &str { "#3b1f4f" }
    fn accent(&self) -> &str { "#c79bff" }
    fn platforms(&self) -> &[&str] { &["win32", "darwin"] }
    fn processes(&self) -> &[&str] { &["GalaxyClient", "GalaxyClient Helper"] }
    fn processes_mac(&self) -> &[&str] { &["GOG Galaxy"] }

    async fn detect(&self) -> anyhow::Result<Detected> {
        let entries = reg::sub_keys(GAMES_KEY);
        let galaxy_exe = find_galaxy().await;
        let owned = galaxy::owned_for(&["gog"]).await;
        let by_id: HashMap<&str, &galaxy::Owned> = owned.iter().map(|o| (o.id.as_str(), o)).collect();
        let mut games = Vec::new();
        let mut ids = HashSet::new();
        let mut names = HashSet::new();

        if IS_MAC {
            for (id, path) in galaxy::read_installed().await {
                let o = by_id.get(id.as_str());
                let app = path.as_deref().and_then(app_bundle).or_else(|| path.clone().filter(|p| p.to_lowercase().ends_with(".app")));
                ids.insert(id.clone());
                if let Some(o) = o {
                    names.insert(normalize(&o.name));
                }
                games.push(json!({
                    "nativeId": id, "name": o.map(|o| o.name.clone()).unwrap_or_else(|| format!("GOG {id}")),
                    "installDir": path, "status": "installed",
                    "covers": o.map(|o| o.covers.clone()).unwrap_or_default(), "wides": o.map(|o| o.wides.clone()).unwrap_or_default(),
                    "launch": match app { Some(a) => json!({ "type": "exe", "target": a, "args": [] }), None => uri(format!("goggalaxy://openGameView/gog_{id}")) },
                }));
            }
        }

        for e in entries {
            let v = &e.values;
            let game_id = reg::val_str(v, "gameID").unwrap_or_else(|| e.name.clone());
            let dir = reg::val_str(v, "path").unwrap_or_default();
            if reg::val_str(v, "dependsOn").is_some() {
                continue;
            }
            let exe = reg::val_str(v, "exe").or_else(|| reg::val_str(v, "launchCommand"));
            let launch = match exe {
                Some(x) if exists(&x).await => {
                    let args: Vec<String> = reg::val_str(v, "launchParam").map(|p| p.split(' ').map(String::from).collect()).unwrap_or_default();
                    json!({ "type": "exe", "target": x, "args": args, "cwd": reg::val_str(v, "workingDir").unwrap_or_else(|| dir.clone()) })
                }
                _ => match &galaxy_exe {
                    Some(g) => json!({
                        "type": "exe", "target": g.to_string_lossy(),
                        "args": ["/command=runGame", format!("/gameId={game_id}"), format!("/path={dir}")],
                        "cwd": g.parent().map(|p| p.to_string_lossy().into_owned()),
                    }),
                    None => continue,
                },
            };
            let name = reg::val_str(v, "gameName")
                .or_else(|| reg::val_str(v, "GAMENAME"))
                .or_else(|| by_id.get(game_id.as_str()).map(|o| o.name.clone()))
                .unwrap_or_else(|| format!("GOG {game_id}"));
            ids.insert(game_id.clone());
            names.insert(normalize(&name));
            let img = by_id.get(game_id.as_str());
            games.push(json!({
                "nativeId": game_id, "name": name, "installDir": dir, "status": "installed",
                "covers": img.map(|o| o.covers.clone()).unwrap_or_default(), "wides": img.map(|o| o.wides.clone()).unwrap_or_default(),
                "launch": launch,
            }));
        }

        for o in &owned {
            if ids.contains(&o.id) || names.contains(&normalize(&o.name)) {
                continue;
            }
            games.push(json!({
                "nativeId": o.id, "name": o.name, "status": "notInstalled", "covers": o.covers, "wides": o.wides,
                "launch": uri(format!("goggalaxy://openGameView/{}", o.release_key)),
            }));
        }
        Ok(games.into_iter().map(super::steam::strip_nulls).collect::<Vec<_>>().into())
    }

    async fn updates(&self) -> Option<Vec<Value>> {
        Some(galaxy::read_jobs().await.into_iter().map(|(id, u)| json!({ "nativeId": id, "update": u })).collect())
    }
    async fn client(&self) -> Option<Value> {
        exe_launch(find_galaxy().await.as_deref(), &[]).or_else(|| Some(json!({ "type": "url", "target": "https://www.gog.com/de/galaxy" })))
    }
    fn store(&self) -> Option<Value> {
        Some(json!({ "type": "url", "target": "https://www.gog.com/de/games" }))
    }
    async fn downloads_page(&self, _game: &Value) -> Option<Value> {
        exe_launch(find_galaxy().await.as_deref(), &[])
    }
}
