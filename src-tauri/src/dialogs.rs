//! System-Dialoge (Datei wählen, Rückfrage) über tauri-plugin-dialog

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Rückfrage mit zwei Knöpfen; true = bestätigt
pub async fn confirm(app: &AppHandle, title: &str, message: &str, detail: &str, ok_label: &str) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(if detail.is_empty() { message.to_string() } else { format!("{message}\n\n{detail}") })
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok_label.to_string(), crate::util::t("Abbrechen")))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    rx.await.unwrap_or(false)
}

/// Datei auswählen; None = abgebrochen
pub async fn pick_file(app: &AppHandle, title: &str, filters: &[(&str, &[&str])]) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut d = app.dialog().file().set_title(title);
    for (name, ext) in filters {
        d = d.add_filter(*name, ext);
    }
    d.pick_file(move |f| {
        let _ = tx.send(f.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()));
    });
    rx.await.ok().flatten()
}
