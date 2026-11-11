//! Amazon Games

use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;

use super::{Detected, Provider};
use crate::reg;
use crate::sqlite::{self, s};
use crate::util::*;

async fn read_library() -> Vec<(String, String)> {
    let local = env("LOCALAPPDATA");
    if local.is_empty() {
        return vec![];
    }
    let file = PathBuf::from(local).join(r"Amazon Games\Data\Games\Sql\GameProductInfo.sqlite");
    tokio::task::spawn_blocking(move || {
        let Some(db) = sqlite::open(file) else { return vec![] };
        if !db.tables().contains("DbSet") {
            return vec![];
        }
        let cols = db.columns("DbSet");
        let Some(id_col) = ["ProductIdStr", "Id"].into_iter().find(|c| cols.contains(*c)) else { return vec![] };
        if !cols.contains("ProductTitle") {
            return vec![];
        }
        db.all(&format!("SELECT \"{id_col}\" AS id, ProductTitle AS name FROM DbSet"))
            .iter()
            .filter_map(|r| Some((s(r, "id")?, s(r, "name")?)))
            .collect()
    })
    .await
    .unwrap_or_default()
}

async fn find_amazon_exe() -> Option<PathBuf> {
    let local = env("LOCALAPPDATA");
    if local.is_empty() {
        return None;
    }
    first_existing(&[PathBuf::from(local).join(r"Amazon Games\App\Amazon Games.exe")]).await
}

pub struct Amazon;

#[async_trait]
impl Provider for Amazon {
    fn id(&self) -> &str { "amazon" }
    fn name(&self) -> &str { "Amazon Games" }
    fn color(&self) -> &str { "#1a2330" }
    fn accent(&self) -> &str { "#ff9900" }
    fn processes(&self) -> &[&str] { &["Amazon Games"] }

    async fn detect(&self) -> anyhow::Result<Detected> {
        let mut games = Vec::new();
        let mut installed = HashSet::new();
        for e in reg::uninstall_entries() {
            let un = reg::val_str(&e.values, "UninstallString").unwrap_or_default();
            if !un.to_lowercase().contains("amazon game remover") {
                continue;
            }
            let Some(id) = get_arg(&un, "p") else { continue };
            let name = reg::val_str(&e.values, "DisplayName").unwrap_or_default();
            installed.insert(id.clone());
            installed.insert(normalize(&name));
            games.push(json!({
                "nativeId": id, "name": name, "installDir": e.values.get("InstallLocation"), "status": "installed", "covers": [],
                "launch": uri(format!("amazon-games://play/{id}")),
            }));
        }
        for (id, name) in read_library().await {
            if installed.contains(&id) || installed.contains(&normalize(&name)) {
                continue;
            }
            installed.insert(id.clone());
            games.push(json!({
                "nativeId": id, "name": name, "status": "notInstalled", "covers": [],
                "launch": uri(format!("amazon-games://play/{id}")),
            }));
        }
        Ok(games.into())
    }
    async fn client(&self) -> Option<Value> {
        exe_launch(find_amazon_exe().await.as_deref(), &[])
    }
    fn store(&self) -> Option<Value> {
        Some(json!({ "type": "url", "target": "https://gaming.amazon.com/home" }))
    }
}
