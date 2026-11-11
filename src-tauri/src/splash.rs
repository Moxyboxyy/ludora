//! Startanimation: eigenes kleines, rahmenloses und durchsichtiges Fenster, in dem nur das Logo zu sehen ist.
//! Das Hauptfenster startet unsichtbar und erscheint erst, wenn beides fertig ist: die Animation
//! ("splash:done" aus splash.html) und die Oberfläche ("app:ready" aus main.jsx). Hängt eins davon,
//! zeigt ein Sicherheitsnetz das Hauptfenster spätestens nach ein paar Sekunden trotzdem.
use parking_lot::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
struct State {
    active: bool,
    anim_done: bool,
    ui_ready: bool,
}

static STATE: Mutex<State> = Mutex::new(State { active: false, anim_done: false, ui_ready: false });

const LABEL: &str = "splash";
/// Spätestens dann erscheint Ludora, auch wenn die Animation oder die Oberfläche nicht Bescheid sagen
const SAFETY: Duration = Duration::from_secs(6);

/// Beim normalen Start (nicht beim Autostart in den Tray) aufrufen
pub fn start(app: &AppHandle) {
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("splash.html".into()))
        .title("Ludora")
        .inner_size(240.0, 240.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .focused(false)
        .build();
    match built {
        Ok(_) => {
            STATE.lock().active = true;
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(SAFETY).await;
                finish(&h);
            });
        }
        Err(e) => {
            crate::log::warn(&format!("[splash] Fenster nicht möglich: {e}"));
            crate::show_main(app);
        }
    }
}

/// Animation ist durch (aus splash.html)
pub fn anim_done(app: &AppHandle) {
    let ready = {
        let mut s = STATE.lock();
        s.anim_done = true;
        s.ui_ready
    };
    if ready {
        finish(app);
    }
}

/// Oberfläche im Hauptfenster steht (aus main.jsx). Ohne laufende Startanimation passiert nichts.
pub fn ui_ready(app: &AppHandle) {
    let done = {
        let mut s = STATE.lock();
        s.ui_ready = true;
        s.anim_done
    };
    if done {
        finish(app);
    }
}

/// Hauptfenster zeigen, Startfenster ausblenden und nach dem Ausklingen des Startsounds schließen
fn finish(app: &AppHandle) {
    {
        let mut s = STATE.lock();
        if !s.active {
            return;
        }
        s.active = false;
    }
    crate::show_main(app);
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.set_always_on_top(false);
        let h = app.clone();
        tauri::async_runtime::spawn(async move {
            // Logo blendet in splash.html aus (0,3 s), der Ton klingt noch nach
            tokio::time::sleep(Duration::from_millis(350)).await;
            if let Some(w) = h.get_webview_window(LABEL) {
                let _ = w.hide();
            }
            tokio::time::sleep(Duration::from_millis(1800)).await;
            if let Some(w) = h.get_webview_window(LABEL) {
                let _ = w.close();
            }
        });
    }
}
