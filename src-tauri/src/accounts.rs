//! Konten-Anmeldung im Web (entspricht electron/lib/accounts.js) – derzeit Battle.net-Bibliothek.
//! Anmeldung im eigenen Fenster; die Bibliothek wird mit dessen Cookies abgerufen.

use serde_json::{json, Map, Value};

use crate::settings;
use crate::util::*;

pub struct Account {
    pub id: &'static str,
    pub name: &'static str,
    pub login_url: &'static str,
    pub library_url: &'static str,
    pub logged_in_host: &'static str,
}

pub const ACCOUNTS: [Account; 1] = [Account {
    id: "battlenet",
    name: "Battle.net",
    login_url: "https://account.battle.net/login/de-de/?ref=https%3A%2F%2Faccount.battle.net%2Fgames",
    library_url: "https://account.battle.net/api/games-and-subs",
    logged_in_host: "account.battle.net",
}];

pub fn account(id: &str) -> Option<&'static Account> {
    ACCOUNTS.iter().find(|a| a.id == id)
}

/// Alle Objekte mit localizedGameName herausziehen (doppelte Namen nur einmal)
pub fn collect_games(node: &Value) -> Vec<Value> {
    fn walk(n: &Value, out: &mut Vec<Value>) {
        match n {
            Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            Value::Object(o) => {
                if let Some(name) = o.get("localizedGameName").and_then(|v| v.as_str()) {
                    out.push(json!({ "name": name, "titleId": o.get("titleId"), "status": o.get("gameAccountStatus") }));
                }
                o.values().for_each(|x| walk(x, out));
            }
            _ => {}
        }
    }
    let mut all = Vec::new();
    walk(node, &mut all);
    let mut seen = std::collections::HashSet::new();
    all.into_iter().filter(|g| seen.insert(g["name"].as_str().unwrap_or("").to_lowercase())).collect()
}

/// Gespeicherte Bibliothek (wird nach dem Login und bei jedem Abruf aktualisiert)
pub fn save_library(id: &str, games: &[Value]) {
    let mut p = Map::new();
    p.insert(format!("account_{id}"), json!({ "connected": true, "at": chrono::Utc::now().timestamp_millis(), "games": games }));
    settings::set(p);
}

/// Bibliothek für den Scan: frisch über das Anmeldefenster-Profil abrufen, sonst die zuletzt gespeicherte Liste
pub async fn library(id: &str) -> (Vec<Value>, Option<String>) {
    let saved = settings::get(&format!("account_{id}")).unwrap_or(Value::Null);
    if saved["connected"] != true {
        return (vec![], None);
    }
    let list = saved["games"].as_array().cloned().unwrap_or_default();
    match crate::webauth::fetch_json_with_session(id, account(id).map(|a| a.library_url).unwrap_or("")).await {
        Some(Ok(j)) => {
            let games = collect_games(&j);
            save_library(id, &games);
            (games, None)
        }
        Some(Err(())) => (list, Some(t_args("{0}-Anmeldung abgelaufen – in den Einstellungen neu anmelden.", &[account(id).map(|a| a.name).unwrap_or(id)]))),
        None => (list, None), // offline / Fenster nicht verfügbar: gespeicherte Liste
    }
}

pub fn status() -> Value {
    let mut out = Map::new();
    for a in &ACCOUNTS {
        let s = settings::get(&format!("account_{}", a.id)).unwrap_or(Value::Null);
        out.insert(
            a.id.into(),
            if s["connected"] == true {
                json!({ "connected": true, "count": s["games"].as_array().map(|g| g.len()).unwrap_or(0), "at": s["at"] })
            } else {
                json!({ "connected": false })
            },
        );
    }
    Value::Object(out)
}

pub fn logout(id: &str) {
    let mut p = Map::new();
    p.insert(format!("account_{id}"), Value::Null);
    settings::set(p);
    crate::webauth::clear_session(id);
}

#[cfg(test)]
mod tests {
    #[test]
    fn spiele_sammeln() {
        let j = serde_json::json!({ "a": [{ "localizedGameName": "Diablo IV", "titleId": 1 }, { "x": { "localizedGameName": "diablo iv" } }, { "localizedGameName": "Overwatch 2" }] });
        let g = super::collect_games(&j);
        assert_eq!(g.len(), 2);
    }
}
