//! Tray-Symbol mit Menü.
//! Linksklick: Fenster zeigen/verstecken (Windows/Linux); Rechtsklick: Menü mit Favoriten.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::util::{t, t_args};

const TRAY_ID: &str = "ludora";

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let favs = crate::library::favorites_games();
    let dl = crate::DOWNLOADS_LABEL.lock().clone();
    let mut m = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("show", t("Ludora öffnen")).build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("nav:library", t("Bibliothek")).build(app)?)
        .item(&MenuItemBuilder::with_id("nav:shop", t("Shop")).build(app)?)
        .item(&MenuItemBuilder::with_id("nav:downloads", match &dl { Some(d) => t_args("Downloads ({0})", &[d]), None => t("Downloads") }).build(app)?)
        .item(&MenuItemBuilder::with_id("nav:friends", t("Freunde")).build(app)?)
        .separator();
    if favs.is_empty() {
        m = m.item(&MenuItemBuilder::with_id("nofav", t("Favoriten (noch keine)")).enabled(false).build(app)?);
    } else {
        let mut sub = SubmenuBuilder::new(app, t("Favoriten"));
        for g in favs.iter().take(10) {
            sub = sub.item(&MenuItemBuilder::with_id(format!("play:{}", g["id"].as_str().unwrap_or("")), g["name"].as_str().unwrap_or("")).build(app)?);
        }
        m = m.item(&sub.build()?);
    }
    m.separator()
        .item(&MenuItemBuilder::with_id("nav:settings", t("Einstellungen")).build(app)?)
        .item(&MenuItemBuilder::with_id("quit", t("Ludora beenden")).build(app)?)
        .build()
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let icon = app.default_window_icon().cloned();
    let mut b = TrayIconBuilder::with_id(TRAY_ID).tooltip("Ludora").menu(&menu).show_menu_on_left_click(cfg!(target_os = "macos"));
    if let Some(i) = icon {
        b = b.icon(i);
    }
    b.on_menu_event(|app, ev| {
        let id = ev.id().as_ref().to_string();
        match id.as_str() {
            "show" => crate::show_main(app),
            "quit" => crate::quit(app),
            x if x.starts_with("nav:") => crate::navigate(app, &x[4..]),
            x if x.starts_with("play:") => {
                let gid = x[5..].to_string();
                tauri::async_runtime::spawn(async move {
                    if let Some(pid) = crate::library::running_cached(&gid) {
                        crate::running::focus(pid);
                    } else if let Ok(g) = crate::library::find_game(&gid) {
                        if let Err(e) = crate::library::launch_game(&g).await {
                            crate::log::warn(&format!("[tray] Start fehlgeschlagen {e}"));
                        }
                    }
                });
            }
            _ => {}
        }
    })
    .on_tray_icon_event(|tray, ev| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
            if cfg!(target_os = "macos") {
                return;
            }
            let app = tray.app_handle();
            if let Some(w) = app.get_webview_window("main") {
                if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
                    let _ = w.hide();
                    crate::set_background(app, true);
                } else {
                    crate::show_main(app);
                }
            }
        }
    })
    .build(app)?;
    Ok(())
}

/// Menü neu bauen (Favoriten, Downloads, Sprache)
pub fn refresh(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(m) = build_menu(app) {
            let _ = tray.set_menu(Some(m));
        }
    }
}

pub fn set_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(if text.is_empty() { "Ludora" } else { text }));
    }
}
