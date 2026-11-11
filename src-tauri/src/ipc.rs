//! Verteiler: Die Oberfläche ruft dieselben Kanäle auf wie in der Electron-Version
//! ("library:scan", "settings:get", …). So bleibt der React-Teil unverändert.
//! Kanäle, die noch nicht nach Rust portiert sind, melden das klar statt still zu scheitern.

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::settings;
use crate::util::{t, t_args};

/// Plattformname wie in Node (process.platform), damit die Oberfläche nichts ändern muss
pub fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn arg(args: &[Value], i: usize) -> Value {
    args.get(i).cloned().unwrap_or(Value::Null)
}

fn s(args: &[Value], i: usize) -> String {
    match args.get(i) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string(),
    }
}

fn ok() -> Value {
    json!({ "ok": true })
}

pub async fn dispatch(app: &AppHandle, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    let args: Vec<Value> = args.into_iter().map(inbound).collect();
    let a0 = s(&args, 0);
    Ok(match channel {
        // ---------- App ----------
        "friends:window" => crate::chat::open_friends(app, &a0, args.get(1).and_then(|v| v.as_bool()).unwrap_or(false)),
        "app:ready" => {
            crate::splash::ui_ready(app);
            json!(true)
        }
        "splash:done" => {
            crate::splash::anim_done(app);
            json!(true)
        }
        "app:boot" => json!({ "platform": platform(), "language": crate::util::lang() }),
        "app:info" => json!({ "version": app.package_info().version.to_string(), "runtime": "tauri", "platform": platform() }),
        "app:quit" => {
            crate::quit(app);
            json!(true)
        }
        "app:devtools" => {
            #[cfg(debug_assertions)]
            for (_, w) in app.webview_windows() {
                if w.is_focused().unwrap_or(false) {
                    if w.is_devtools_open() { w.close_devtools() } else { w.open_devtools() }
                }
            }
            json!(true)
        }
        "app:openData" => {
            open_path(app, &crate::paths::data_dir().to_string_lossy());
            Value::Null
        }
        "app:openExternal" => {
            const ALLOWED: [&str; 3] = ["https://steamcommunity.com/dev/apikey", "https://steamcommunity.com/my/edit/settings", "https://www.steamgriddb.com/profile/preferences/api"];
            if ALLOWED.contains(&a0.as_str()) {
                open_url(app, &a0);
            }
            Value::Null
        }

        // ---------- Einstellungen ----------
        "settings:get" => settings_get(app).await,
        "settings:set" => settings_set(app, &arg(&args, 0)),
        "cache:info" => json!({ "bytes": cache_size(app).await }),
        "cache:clear" => {
            for (_, w) in app.webview_windows() {
                let _ = w.clear_all_browsing_data();
            }
            crate::covers::clear_url_cache();
            json!({ "bytes": cache_size(app).await })
        }
        "account:login" => {
            if crate::accounts::account(&a0).is_none() {
                json!({ "ok": false, "error": t("Unbekanntes Konto") })
            } else if a0 == "battlenet" && !settings::get_bool("bnetAccountLibrary", false) {
                json!({ "ok": false, "error": t("Erst in den Einstellungen unter „Erweitert“ einschalten.") })
            } else {
                crate::webauth::login(app, &a0).await
            }
        }
        "account:logout" => {
            if crate::accounts::account(&a0).is_none() {
                json!({ "ok": false })
            } else {
                crate::accounts::logout(&a0);
                ok()
            }
        }

        // ---------- Bibliothek ----------
        "library:cached" => crate::library::cached().await,
        "library:scan" => crate::library::scan(app).await,
        "library:streams" => crate::streams::get(),
        "game:stream" => crate::streams::stream_game(&a0).await,
        "game:launch" => crate::library::launch(&a0).await,
        "launcher:open" => crate::library::open_launcher(&a0, &s(&args, 1)).await,
        "downloads:status" => crate::library::downloads_status().await,
        "game:update" => crate::library::update_game(&a0, arg(&args, 1) == true).await,
        "download:manage" => crate::library::manage_download(&a0).await,
        "game:setCover" => crate::library::set_cover(app, &a0).await,
        "games:running" => json!(crate::library::running_games().await.keys().cloned().collect::<Vec<_>>()),
        "game:focus" => {
            let pid = crate::library::running_games().await.get(&a0).copied();
            if let Some(p) = pid {
                crate::running::focus(p);
            }
            json!({ "ok": pid.is_some() })
        }
        "game:uninstall" => crate::library::uninstall(app, &a0).await,
        "game:openFolder" => crate::library::open_folder(app, &a0).await,
        "favorites:get" => settings::get("favorites").unwrap_or_else(|| json!([])),
        "favorites:toggle" => {
            let r = toggle_favorite(&a0);
            crate::tray::refresh(app);
            r
        }
        "manual:pickExe" => {
            let filters: Vec<(&str, &[&str])> = if cfg!(target_os = "macos") { vec![("Programme", &["app"])] } else { vec![("Programme", &["exe", "lnk", "bat", "url"]), ("Alle Dateien", &["*"])] };
            crate::dialogs::pick_file(app, &t("Spiel auswählen"), &filters).await.map_or(Value::Null, Value::String)
        }
        "manual:add" => {
            let d = arg(&args, 0);
            let exe = d["exe"].as_str().unwrap_or("");
            if exe.is_empty() {
                json!({ "ok": false, "error": t("Keine Datei gewählt.") })
            } else {
                crate::providers::manual::add(d["name"].as_str().unwrap_or(""), exe, d["args"].as_str().unwrap_or(""));
                ok()
            }
        }
        "manual:remove" => match crate::library::find_game(&a0) {
            Ok(g) if g["provider"] == "manual" => {
                crate::providers::manual::remove(g["nativeId"].as_str().unwrap_or(""));
                ok()
            }
            Ok(_) => json!({ "ok": false, "error": t("Nur eigene Spiele können entfernt werden.") }),
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        },

        // ---------- Shop ----------
        "shop:query" => crate::shop::query(&arg(&args, 0)).await,
        "shop:more" => crate::shop::more(&arg(&args, 0)).await,
        "shop:open" => shop_open(app, &arg(&args, 0)).await,

        // ---------- Updates von Ludora ----------
        "update:get" => crate::updater::get_state(),
        "update:check" => crate::updater::check().await,
        "update:install" => crate::updater::install().await,

        // ---------- Steam-Freunde & Chat ----------
        "friends:get" => crate::steam::get_state(),
        "friends:qr" => crate::steam::start_qr().await,
        "friends:logout" => {
            crate::steam::logout();
            ok()
        }
        "friends:fast" => {
            crate::steam::set_fast(arg(&args, 0) == true);
            Value::Null
        }
        "friends:action" => friends_action(app, &a0, &s(&args, 1)),
        "chat:open" => crate::chat::open(app, &a0),
        "chat:history" => crate::chat::history(&a0).await,
        "chat:send" => crate::chat::send(&a0, &s(&args, 1)).await,
        "chat:typing" => {
            crate::chat::typing(&a0);
            Value::Null
        }
        "chat:read" => {
            crate::chat::read(&a0);
            Value::Null
        }

        // ---------- Weitere Freundeslisten ----------
        "friends2:list" => crate::friends::list(),
        "friends2:login" => crate::friends::login(app, &a0).await,
        "friends2:logout" => {
            crate::friends::logout(app, &a0).await;
            ok()
        }
        "friends2:refresh" => {
            crate::friends::refresh(&a0);
            ok()
        }
        "friends2:fast" => {
            let on = arg(&args, 0) == true;
            crate::friends::set_fast(on);
            crate::hub::set_fast(on);
            Value::Null
        }
        "friends2:startRiot" => start_riot().await,
        "friends2:open" => {
            let p = crate::providers::by_id(&a0);
            let launch = match &p {
                Some(p) => p.client().await,
                None => None,
            };
            match (p, launch) {
                (Some(p), Some(l)) => {
                    crate::hide::stop(&a0);
                    match crate::running::run_launch(Some(&l), false).await {
                        Ok(_) => json!({ "ok": true, "name": p.name() }),
                        Err(e) => json!({ "ok": false, "error": e.to_string() }),
                    }
                }
                (p, _) => json!({ "ok": false, "error": t_args("{0} nicht gefunden.", &[p.as_ref().map(|p| p.name()).unwrap_or("Launcher")]) }),
            }
        }
        "people:get" => crate::friends::people_get(),
        "people:save" => crate::friends::people_save(&arg(&args, 0)),

        // ---------- Ludora-Konto ----------
        "hub:get" => crate::hub::get_state(),
        "hub:register" => crate::hub::register(&a0, &s(&args, 1)).await,
        "hub:login" => crate::hub::login(&a0, &s(&args, 1)).await,
        "hub:logout" => crate::hub::logout().await,
        "hub:deleteAccount" => {
            let yes = crate::dialogs::confirm(
                app,
                &t("Ludora-Konto löschen"),
                &t("Ludora-Konto endgültig löschen?"),
                &t("Dein Ludora-Name, alle verknüpften Launcher-Konten und deine Ludora-Freundschaften werden vom Server gelöscht. Das lässt sich nicht rückgängig machen. Deine Spiele und Launcher bleiben unberührt."),
                &t("Konto endgültig löschen"),
            )
            .await;
            if yes {
                crate::hub::delete_account().await
            } else {
                json!({ "ok": false, "cancelled": true })
            }
        }
        "hub:unlink" => crate::hub::unlink(&a0, &s(&args, 1)).await,
        "hub:relink" => crate::hub::relink(),
        "hub:friendRequest" => crate::hub::friend_request(&a0).await,
        "hub:friendAccept" => crate::hub::friend_accept(&a0).await,
        "hub:friendRemove" => crate::hub::friend_remove(&a0).await,
        "hub:refreshFriends" => crate::hub::refresh_friends().await,
        "hub:steamAdd" => {
            if a0.len() == 17 && a0.chars().all(|c| c.is_ascii_digit()) {
                crate::hide::stop("steam");
                let _ = crate::running::open_with_system(&format!("steam://friends/add/{a0}"));
                ok()
            } else {
                json!({ "ok": false })
            }
        }
        "hub:lookup" => {
            let list: Vec<Value> = arg(&args, 0)
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .take(3000)
                .map(|x| json!({ "launcher": s(&[x["launcher"].clone()], 0), "account_id": s(&[x["account_id"].clone()], 0) }))
                .filter(|x| ["steam", "riot", "epic", "gog"].contains(&x["launcher"].as_str().unwrap_or("")) && x["account_id"] != "")
                .collect();
            match crate::hub::lookup(list).await {
                Ok(items) => json!({ "ok": true, "items": items }),
                Err(e) => json!({ "ok": false, "items": [], "error": e.to_string() }),
            }
        }

        #[cfg(debug_assertions)]
        "debug:log" => {
            crate::log::info(&format!("[selftest] {}", a0.chars().take(600).collect::<String>()));
            Value::Null
        }
        #[cfg(debug_assertions)]
        "debug:options" => crate::selftest::options(),
        #[cfg(debug_assertions)]
        "debug:status" => crate::selftest::status(),
        #[cfg(debug_assertions)]
        "debug:report" => crate::selftest::report(&arg(&args, 0)),
        #[cfg(debug_assertions)]
        "debug:finish" => crate::selftest::finish(app, &arg(&args, 0)),

        _ => return Err(format!("Unbekannter Kanal: {channel}")),
    })
}

/// Größe des Browser-Zwischenspeichers (WebView-Ordner "EBWebView"/"WebKit" im Datenordner)
async fn cache_size(app: &AppHandle) -> u64 {
    let mut n = 0;
    for base in [app.path().app_local_data_dir().ok(), app.path().app_cache_dir().ok()].into_iter().flatten() {
        for d in ["EBWebView/Default/Cache", "EBWebView/Default/Code Cache", "WebKitCache", "CacheStorage", "NetworkCache"] {
            n += crate::util::dir_size(base.join(d), 200_000).await;
        }
    }
    n
}

async fn settings_get(app: &AppHandle) -> Value {
    let s = settings::get_all();
    let detected = match crate::providers::steam::find_steam_path().await {
        Some(p) => crate::providers::steam::find_steam_id(&p).await,
        None => None,
    };
    let packaged = !cfg!(debug_assertions);
    let autostart = if packaged {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().unwrap_or(false)
    } else {
        false
    };
    let bnet = s.get("bnetAccountLibrary") == Some(&json!(true));
    let launchers: Vec<Value> = crate::providers::providers()
        .iter()
        .map(|p| {
            json!({
                "id": p.id(), "name": t(p.name()), "accent": p.accent(),
                "account": crate::accounts::account(p.id()).is_some() && (p.id() != "battlenet" || bnet)
            })
        })
        .collect();
    let str_of = |k: &str| s.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    json!({
        "steamApiKey": str_of("steamApiKey"),
        "steamId": str_of("steamId"),
        "steamGridDbKey": str_of("steamGridDbKey"),
        "launcherMode": s.get("launcherMode").and_then(|v| v.as_str()).unwrap_or("hide"),
        "closeToTray": s.get("closeToTray") != Some(&json!(false)),
        "language": crate::util::lang(),
        "bnetAccountLibrary": bnet,
        "autostart": autostart,
        "autostartAvailable": packaged,
        "accounts": crate::accounts::status(),
        "enabledLaunchers": s.get("enabledLaunchers").cloned().unwrap_or(json!({})),
        "launchers": launchers,
        "detectedSteamId": detected
    })
}

fn settings_set(app: &AppHandle, patch: &Value) -> Value {
    let before = settings::get_str("steamGridDbKey", "");
    let mut allowed = Map::new();
    for k in ["steamApiKey", "steamId", "steamGridDbKey"] {
        if let Some(v) = patch[k].as_str() {
            allowed.insert(k.into(), json!(v.trim()));
        }
    }
    if let Some(m) = patch["launcherMode"].as_str().filter(|m| ["hide", "minimize", "off"].contains(m)) {
        allowed.insert("launcherMode".into(), json!(m));
    }
    if let Some(b) = patch["closeToTray"].as_bool() {
        allowed.insert("closeToTray".into(), json!(b));
    }
    let mut language_changed = false;
    if let Some(l) = patch["language"].as_str().filter(|l| ["en", "de"].contains(l)) {
        if l != crate::util::lang() {
            allowed.insert("language".into(), json!(l));
            language_changed = true;
        }
    }
    if let Some(b) = patch["bnetAccountLibrary"].as_bool() {
        allowed.insert("bnetAccountLibrary".into(), json!(b));
    }
    if let Some(b) = patch["autostart"].as_bool() {
        if !cfg!(debug_assertions) {
            use tauri_plugin_autostart::ManagerExt;
            let al = app.autolaunch();
            let _ = if b { al.enable() } else { al.disable() };
        }
    }
    if let Some(o) = patch["enabledLaunchers"].as_object() {
        let ids: Vec<&str> = crate::providers::providers().iter().map(|p| p.id()).collect();
        let m: Map<String, Value> = o.iter().filter(|(k, v)| ids.contains(&k.as_str()) && v.is_boolean()).map(|(k, v)| (k.clone(), v.clone())).collect();
        allowed.insert("enabledLaunchers".into(), Value::Object(m));
    }
    let new_key = allowed.get("steamGridDbKey").and_then(|v| v.as_str()).map(String::from);
    settings::set(allowed);
    if new_key.is_some_and(|k| !k.is_empty() && k != before) {
        crate::covers::clear_misses();
    }
    if language_changed {
        // Neue Sprache: alle Fenster neu laden, Tray-Menü neu bauen
        crate::tray::refresh(app);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            for (_, w) in app.webview_windows() {
                let _ = w.eval("window.location.reload()");
            }
        });
    }
    json!({ "ok": true, "languageChanged": language_changed })
}

async fn shop_open(app: &AppHandle, store: &Value) -> Value {
    let url = store["url"].as_str().unwrap_or("");
    let uri = store["uri"].as_str().unwrap_or("");
    let launcher = store["launcher"].as_str().unwrap_or("");
    crate::log::info(&format!("[shop] öffnen {launcher}: {url} {uri}"));
    if !crate::shop::is_allowed_url(url) {
        crate::log::warn(&format!("[shop] Link nicht erlaubt: {url}"));
        return json!({ "ok": false, "error": t("Ungültiger Store-Link") });
    }
    let info = crate::library::last_providers().into_iter().find(|x| x["id"] == launcher);
    let has_launcher = info.is_some_and(|i| i["enabled"] != false && (i["count"].as_i64().unwrap_or(0) > 0 || i["installed"].as_i64().unwrap_or(0) > 0));
    let uri_works = platform() != "linux" || launcher == "steam";
    if !uri.is_empty() && uri_works && crate::shop::is_allowed_uri(uri) && has_launcher {
        crate::hide::stop(launcher);
        if crate::running::run_launch(Some(&crate::util::uri(uri.to_string())), false).await.is_ok() {
            return json!({ "ok": true, "via": "launcher" });
        }
    }
    open_url(app, url);
    json!({ "ok": true, "via": "browser" })
}

fn friends_action(app: &AppHandle, steamid: &str, action: &str) -> Value {
    if steamid.len() != 17 || !steamid.chars().all(|c| c.is_ascii_digit()) {
        return json!({ "ok": false });
    }
    let f = crate::steam::find_friend(steamid);
    let url = match action {
        "chat" => Some(format!("steam://friends/message/{steamid}")),
        "profile" => Some(format!("https://steamcommunity.com/profiles/{steamid}")),
        "games" => Some(format!("https://steamcommunity.com/profiles/{steamid}/games/?tab=all")),
        "join" => f.as_ref().and_then(crate::steam::join_url),
        "store" => f.as_ref().and_then(|f| f["appid"].as_u64().or_else(|| f["appid"].as_str().and_then(|s| s.parse().ok()))).filter(|a| *a > 0).map(|a| format!("steam://store/{a}")),
        "friendsWindow" => Some("steam://open/friends".into()),
        _ => None,
    };
    let Some(url) = url else { return json!({ "ok": false, "error": t("Nicht möglich") }) };
    crate::hide::stop("steam");
    if url.starts_with("https://") {
        open_url(app, &url);
    } else {
        let _ = crate::running::open_with_system(&url);
    }
    ok()
}

/// Riot Client unsichtbar starten (die Riot-Freundesliste braucht den laufenden Client)
async fn start_riot() -> Value {
    let Some(p) = crate::providers::by_id("riot") else { return json!({ "ok": false, "error": t("Riot Client nicht gefunden.") }) };
    let Some(launch) = p.client().await else { return json!({ "ok": false, "error": t("Riot Client nicht gefunden.") }) };
    crate::hide::keep_in_background("riot", crate::providers::proc_names(&p), 60, "hide");
    if let Err(e) = crate::running::run_launch(Some(&launch), true).await {
        return json!({ "ok": false, "error": e.to_string() });
    }
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        crate::friends::riot::refresh();
        tokio::time::sleep(std::time::Duration::from_secs(12)).await;
        crate::friends::riot::refresh();
    });
    ok()
}

/// Favorit an/aus (Schlüssel "<launcher>:<id>")
pub fn toggle_favorite(key: &str) -> Value {
    let list: Vec<String> = settings::get("favorites")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let valid = key.len() <= 220
        && key.split_once(':').is_some_and(|(a, b)| {
            !a.is_empty() && a.chars().all(|c| c.is_ascii_lowercase()) && !b.is_empty()
        });
    if !valid {
        return json!(list);
    }
    let mut next: Vec<String> = list.iter().filter(|x| x.as_str() != key).cloned().collect();
    if next.len() == list.len() {
        next.push(key.to_string()); // war noch kein Favorit
    }
    let mut p = Map::new();
    p.insert("favorites".into(), json!(next));
    settings::set(p);
    json!(next)
}

pub fn open_url(app: &AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        crate::log::warn(&format!("[app] Link öffnen über opener fehlgeschlagen ({e}) – versuche System"));
        let _ = crate::running::open_with_system(url);
    }
}

pub fn open_path(app: &AppHandle, path: &str) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_path(path, None::<&str>);
}

/// Bild-Adressen für die Oberfläche: unter Windows heißt ghimg://x in WebView2 http://ghimg.localhost/x
pub fn outbound(v: Value) -> Value {
    if !cfg!(windows) {
        return v;
    }
    match v {
        Value::String(s) if s.starts_with("ghimg://") => Value::String(format!("http://ghimg.localhost/{}", &s[8..])),
        Value::Array(a) => Value::Array(a.into_iter().map(outbound).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, outbound(v))).collect()),
        x => x,
    }
}

/// Rückweg: http://ghimg.localhost/x -> ghimg://x
pub fn inbound(v: Value) -> Value {
    match v {
        Value::String(s) if s.starts_with("http://ghimg.localhost/") => Value::String(format!("ghimg://{}", &s[23..])),
        Value::Array(a) => Value::Array(a.into_iter().map(inbound).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, inbound(v))).collect()),
        x => x,
    }
}
