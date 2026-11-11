//! Tresor: Anmeldungen (Epic, GOG) verschlüsselt im Ludora-Konto, damit sie auf anderen Geräten
//! mitkommen. Schlüssel per scrypt aus dem Passwort (gleiches Format wie die frühere Electron-Version).

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

pub const SYNCED: [&str; 2] = ["friendsEpic", "friendsGog"];
const KEY_SECRET: &str = "vaultKey";

static USER: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static APPLYING: AtomicBool = AtomicBool::new(false);
static PUSH_GEN: AtomicU64 = AtomicU64::new(0);
static HOOKED: AtomicBool = AtomicBool::new(false);

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// scrypt(N=2^15, r=8, p=1, 32 Byte), Salz "ludora-<zweck>:<name>"
pub fn derive_key(password: &str, username: &str, purpose: &str) -> Vec<u8> {
    let params = scrypt::Params::new(15, 8, 1, 32).unwrap();
    let mut out = vec![0u8; 32];
    let salt = format!("ludora-{purpose}:{}", username.to_lowercase());
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut out).unwrap();
    out
}

pub fn encrypt(obj: &Value, key: &[u8]) -> String {
    let iv: [u8; 12] = rand::random();
    let c = Aes256Gcm::new_from_slice(key).unwrap();
    let mut ct = c.encrypt(Nonce::from_slice(&iv), Payload { msg: obj.to_string().as_bytes(), aad: b"" }).unwrap();
    let tag = ct.split_off(ct.len() - 16);
    json!({ "v": 1, "iv": b64().encode(iv), "tag": b64().encode(tag), "ct": b64().encode(ct) }).to_string()
}

pub fn decrypt(text: &str, key: &[u8]) -> Option<Value> {
    let j: Value = serde_json::from_str(text).ok()?;
    let iv = b64().decode(j["iv"].as_str()?).ok()?;
    let mut ct = b64().decode(j["ct"].as_str()?).ok()?;
    ct.extend(b64().decode(j["tag"].as_str()?).ok()?);
    let c = Aes256Gcm::new_from_slice(key).ok()?;
    let plain = c.decrypt(Nonce::from_slice(&iv), Payload { msg: &ct, aad: b"" }).ok()?;
    serde_json::from_slice(&plain).ok()
}

fn key() -> Option<Vec<u8>> {
    crate::secrets::get(KEY_SECRET).and_then(|k| k.as_str().and_then(|s| b64().decode(s).ok()))
}

pub fn has_key() -> bool {
    key().is_some()
}

pub async fn unlock(password: &str, username: &str) {
    let (p, u) = (password.to_string(), username.to_string());
    let k = tokio::task::spawn_blocking(move || derive_key(&p, &u, "vault")).await.unwrap_or_default();
    crate::secrets::set(KEY_SECRET, Value::String(b64().encode(k)));
}

pub fn attach(user_id: &str) {
    *USER.lock() = Some(user_id.to_string());
    if !HOOKED.swap(true, Ordering::SeqCst) {
        crate::secrets::on_change(|name, _| {
            if SYNCED.contains(&name) {
                schedule_push();
            }
        });
    }
}

pub fn detach(forget: bool) {
    PUSH_GEN.fetch_add(1, Ordering::SeqCst);
    *USER.lock() = None;
    if forget {
        crate::secrets::set(KEY_SECRET, Value::Null);
    }
}

fn local_entries() -> Map<String, Value> {
    let mut out = Map::new();
    for name in SYNCED {
        let at = crate::secrets::changed_at(name);
        if at > 0 {
            out.insert(name.into(), json!({ "value": crate::secrets::get(name), "at": at }));
        }
    }
    out
}

/// Tresor abgleichen (neuere Seite gewinnt). Gibt die wiederhergestellten Namen zurück.
pub async fn sync() -> anyhow::Result<Vec<String>> {
    let (Some(k), Some(uid)) = (key(), USER.lock().clone()) else { return Ok(vec![]) };
    let rows = crate::hub::request("GET", &format!("/rest/v1/vaults?user_id=eq.{}&select=data,updated_at", crate::net::enc(&uid)), None, true, &[]).await?;
    let raw = rows[0]["data"].as_str().map(String::from);
    let remote: Map<String, Value> = raw.and_then(|r| decrypt(&r, &k)).and_then(|v| v["entries"].as_object().cloned()).unwrap_or_default();
    let mut local = local_entries();
    let mut restored = vec![];
    APPLYING.store(true, Ordering::SeqCst);
    for (name, r) in &remote {
        let Some(at) = r["at"].as_i64() else { continue };
        if !SYNCED.contains(&name.as_str()) {
            continue;
        }
        if local.get(name).and_then(|l| l["at"].as_i64()).is_some_and(|l| l >= at) {
            continue;
        }
        crate::secrets::set_with(name, r["value"].clone(), Some(at), true);
        local.insert(name.clone(), r.clone());
        if !r["value"].is_null() {
            restored.push(name.clone());
        }
    }
    APPLYING.store(false, Ordering::SeqCst);
    let merged: Map<String, Value> = SYNCED.iter().filter_map(|n| local.get(*n).map(|v| (n.to_string(), v.clone()))).collect();
    let remote_f: Map<String, Value> = remote.into_iter().filter(|(n, _)| SYNCED.contains(&n.as_str())).collect();
    if Value::Object(merged.clone()) != Value::Object(remote_f) {
        crate::hub::request(
            "POST",
            "/rest/v1/vaults",
            Some(json!({ "user_id": uid, "data": encrypt(&json!({ "entries": merged }), &k), "updated_at": chrono::Utc::now().to_rfc3339() })),
            true,
            &[("prefer", "resolution=merge-duplicates,return=minimal")],
        )
        .await?;
    }
    for name in &restored {
        crate::friends::on_restore(name);
    }
    Ok(restored)
}

fn schedule_push() {
    if APPLYING.load(Ordering::SeqCst) || !has_key() || USER.lock().is_none() {
        return;
    }
    let my = PUSH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        if PUSH_GEN.load(Ordering::SeqCst) == my {
            if let Err(e) = sync().await {
                crate::log::warn(&format!("[vault] {e}"));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_key_as_electron() {
        // node: crypto.scrypt('pw', 'ludora-vault:x', 32, { N: 1 << 15, r: 8, p: 1 })
        assert_eq!(hex::encode(derive_key("pw", "X", "vault")), "0bb5d66f9f3c5fb9056417aa3e350aa7f6ebda33adc73e775350a4bf7a6a5411");
    }
    #[test]
    fn roundtrip() {
        let k = vec![7u8; 32];
        let e = encrypt(&json!({ "entries": { "a": 1 } }), &k);
        assert_eq!(decrypt(&e, &k).unwrap()["entries"]["a"], 1);
        assert!(decrypt(&e, &[8u8; 32]).is_none());
    }
}
