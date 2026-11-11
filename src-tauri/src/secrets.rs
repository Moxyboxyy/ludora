//! Anmeldungen verschlüsselt in logins.json.
//! Gleiches Verfahren wie Electrons safeStorage, damit vorhandene Anmeldungen weiter gelten:
//!   Windows: "v10" + AES-256-GCM, Schlüssel per DPAPI geschützt in "Local State" (os_crypt.encrypted_key)
//!   macOS:   "v10" + AES-128-CBC, Schlüssel aus dem Schlüsselbund ("Ludora Safe Storage") per PBKDF2
//!   Linux:   "v11" wie macOS mit Passwort aus dem Secret Service; "v10" (Electron-Ersatz "peanuts") wird gelesen
//! Unverschlüsselt wird nie gespeichert.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::path::PathBuf;

type Listener = Box<dyn Fn(&str, &Value) + Send + Sync>;
static LISTENERS: Lazy<Mutex<Vec<Listener>>> = Lazy::new(|| Mutex::new(Vec::new()));

struct Store {
    file: PathBuf,
    cache: Option<Map<String, Value>>,
    mtime: Option<std::time::SystemTime>,
}

static STORE: Lazy<Mutex<Store>> = Lazy::new(|| Mutex::new(Store { file: crate::paths::shared_dir().join("logins.json"), cache: None, mtime: None }));

pub fn init_file(file: PathBuf) {
    let mut s = STORE.lock();
    s.file = file;
    s.cache = None;
    s.mtime = None;
}

fn read_all(s: &mut Store) -> Map<String, Value> {
    let mtime = std::fs::metadata(&s.file).and_then(|m| m.modified()).ok();
    if s.cache.is_some() && mtime == s.mtime {
        return s.cache.clone().unwrap();
    }
    let map = std::fs::read_to_string(&s.file).ok().and_then(|t| serde_json::from_str::<Map<String, Value>>(&t).ok());
    if let Some(m) = map {
        s.cache = Some(m);
    } else if s.cache.is_none() {
        s.cache = Some(Map::new());
    }
    s.mtime = mtime;
    s.cache.clone().unwrap()
}

fn write_all(s: &mut Store, all: Map<String, Value>) {
    if let Some(d) = s.file.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = s.file.with_extension("json.tmp");
    // Electron schrieb mit 1 Leerzeichen Einrückung – Inhalt ist entscheidend, Format egal
    if std::fs::write(&tmp, serde_json::to_string_pretty(&all).unwrap_or_default()).is_ok() && std::fs::rename(&tmp, &s.file).is_ok() {
        s.mtime = std::fs::metadata(&s.file).and_then(|m| m.modified()).ok();
    }
    s.cache = Some(all);
}

/// Wert lesen (None, wenn nicht vorhanden oder nicht entschlüsselbar)
pub fn get(key: &str) -> Option<Value> {
    let enc = {
        let mut s = STORE.lock();
        read_all(&mut s).get(key)?.get("v")?.as_str()?.to_string()
    };
    let raw = B64.decode(enc).ok()?;
    let plain = crypto::decrypt(&raw)?;
    let text = String::from_utf8(plain).ok()?;
    Some(serde_json::from_str(&text).unwrap_or(Value::String(text))).filter(|v| !v.is_null())
}

/// Wann zuletzt geändert (ms)? 0 = nie
pub fn changed_at(key: &str) -> i64 {
    let mut s = STORE.lock();
    read_all(&mut s).get(key).and_then(|e| e["at"].as_i64().or_else(|| e["at"].as_f64().map(|f| f as i64))).unwrap_or(0)
}

/// Wert speichern (Null = löschen). at: Änderungszeit (für Abgleich mit anderen Geräten)
pub fn set_with(key: &str, value: Value, at: Option<i64>, silent: bool) {
    let at = at.unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    {
        let mut s = STORE.lock();
        let mut all = read_all(&mut s);
        if value.is_null() {
            if let Some(e) = all.get(key) {
                if e["v"].is_null() && !e["at"].is_null() {
                    return;
                }
            }
            all.insert(key.into(), json!({ "v": null, "at": at }));
        } else {
            let Some(enc) = crypto::encrypt(serde_json::to_string(&value).unwrap_or_default().as_bytes()) else {
                crate::log::warn("[secrets] Verschlüsselung nicht verfügbar – Anmeldung nicht gespeichert");
                return;
            };
            all.insert(key.into(), json!({ "v": B64.encode(enc), "at": at }));
        }
        write_all(&mut s, all);
    }
    if !silent {
        for l in LISTENERS.lock().iter() {
            l(key, &value);
        }
    }
}

pub fn set(key: &str, value: Value) {
    set_with(key, value, None, false)
}

pub fn on_change(f: impl Fn(&str, &Value) + Send + Sync + 'static) {
    LISTENERS.lock().push(Box::new(f));
}

pub mod crypto {
    use super::*;

    #[cfg(windows)]
    mod os {
        use super::*;
        use aes_gcm::aead::{Aead, KeyInit};
        use aes_gcm::{Aes256Gcm, Nonce};
        use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
        use windows_sys::Win32::Foundation::LocalFree;

        fn dpapi(data: &[u8], protect: bool) -> Option<Vec<u8>> {
            unsafe {
                let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
                let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
                let ok = if protect {
                    CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut out)
                } else {
                    CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut out)
                };
                if ok == 0 || out.pbData.is_null() {
                    return None;
                }
                let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
                LocalFree(out.pbData as _);
                Some(v)
            }
        }

        static KEY: Lazy<Mutex<Option<Vec<u8>>>> = Lazy::new(|| Mutex::new(None));

        fn local_state() -> PathBuf {
            crate::paths::shared_dir().join("Local State")
        }

        /// AES-Schlüssel aus "Local State" (wie Chromium/Electron); fehlt er, wird einer angelegt
        fn key() -> Option<Vec<u8>> {
            if let Some(k) = KEY.lock().clone() {
                return Some(k);
            }
            let file = local_state();
            let mut state: Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
            let existing = state["os_crypt"]["encrypted_key"].as_str().and_then(|b| B64.decode(b).ok()).and_then(|raw| {
                let body = raw.strip_prefix(b"DPAPI")?;
                dpapi(body, false)
            });
            let k = match existing {
                Some(k) if k.len() == 32 => k,
                _ => {
                    let k: Vec<u8> = (0..32).map(|_| rand::random::<u8>()).collect();
                    let mut blob = b"DPAPI".to_vec();
                    blob.extend(dpapi(&k, true)?);
                    if !state.is_object() {
                        state = json!({});
                    }
                    state["os_crypt"]["encrypted_key"] = json!(B64.encode(blob));
                    let _ = std::fs::create_dir_all(file.parent()?);
                    std::fs::write(&file, serde_json::to_string(&state).ok()?).ok()?;
                    k
                }
            };
            *KEY.lock() = Some(k.clone());
            Some(k)
        }

        pub fn decrypt(data: &[u8]) -> Option<Vec<u8>> {
            if let Some(body) = data.strip_prefix(b"v10") {
                let k = key()?;
                let (nonce, ct) = body.split_at(12.min(body.len()));
                return Aes256Gcm::new_from_slice(&k).ok()?.decrypt(Nonce::from_slice(nonce), ct).ok();
            }
            dpapi(data, false) // sehr alte Electron-Versionen: reines DPAPI
        }

        pub fn encrypt(data: &[u8]) -> Option<Vec<u8>> {
            let k = key()?;
            let nonce: [u8; 12] = rand::random();
            let ct = Aes256Gcm::new_from_slice(&k).ok()?.encrypt(Nonce::from_slice(&nonce), data).ok()?;
            let mut out = b"v10".to_vec();
            out.extend(nonce);
            out.extend(ct);
            Some(out)
        }
    }

    #[cfg(not(windows))]
    mod os {
        use super::*;
        use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};

        type Dec = cbc::Decryptor<aes::Aes128>;
        type Enc = cbc::Encryptor<aes::Aes128>;
        const IV: [u8; 16] = [b' '; 16];

        fn derive(password: &[u8], iterations: u32) -> [u8; 16] {
            let mut key = [0u8; 16];
            pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", iterations, &mut key);
            key
        }

        static PASSWORD: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

        /// Passwort aus dem Schlüsselbund ("Ludora Safe Storage" wie bei Electron); fehlt es, wird es angelegt
        fn password() -> Option<String> {
            if let Some(p) = PASSWORD.lock().clone() {
                return Some(p);
            }
            let entry = keyring::Entry::new("Ludora Safe Storage", "Ludora").ok()?;
            let pw = match entry.get_password() {
                Ok(p) => p,
                Err(_) => {
                    let p = B64.encode((0..16).map(|_| rand::random::<u8>()).collect::<Vec<_>>());
                    entry.set_password(&p).ok()?;
                    p
                }
            };
            *PASSWORD.lock() = Some(pw.clone());
            Some(pw)
        }

        fn iterations() -> u32 {
            if cfg!(target_os = "macos") { 1003 } else { 1 }
        }

        pub fn decrypt(data: &[u8]) -> Option<Vec<u8>> {
            let (body, key) = if let Some(b) = data.strip_prefix(b"v11") {
                (b, derive(password()?.as_bytes(), iterations()))
            } else {
                let b = data.strip_prefix(b"v10")?;
                let pw = if cfg!(target_os = "macos") { password()? } else { "peanuts".into() };
                (b, derive(pw.as_bytes(), iterations()))
            };
            Dec::new(&key.into(), &IV.into()).decrypt_padded_vec_mut::<Pkcs7>(body).ok()
        }

        pub fn encrypt(data: &[u8]) -> Option<Vec<u8>> {
            let key = derive(password()?.as_bytes(), iterations());
            let mut out = if cfg!(target_os = "macos") { b"v10".to_vec() } else { b"v11".to_vec() };
            out.extend(Enc::new(&key.into(), &IV.into()).encrypt_padded_vec_mut::<Pkcs7>(data));
            Some(out)
        }

        #[cfg(test)]
        pub fn test_roundtrip_peanuts() -> bool {
            // Electron (Linux ohne Schlüsselbund): "v10" + AES-128-CBC mit Passwort "peanuts"
            let key = derive(b"peanuts", 1);
            let mut enc = b"v10".to_vec();
            enc.extend(Enc::new(&key.into(), &IV.into()).encrypt_padded_vec_mut::<Pkcs7>(b"\"hallo\""));
            decrypt(&enc).as_deref() == Some(b"\"hallo\"".as_slice())
        }
    }

    pub fn decrypt(data: &[u8]) -> Option<Vec<u8>> {
        os::decrypt(data)
    }

    pub fn encrypt(data: &[u8]) -> Option<Vec<u8>> {
        os::encrypt(data)
    }

    #[cfg(all(test, not(windows)))]
    #[test]
    fn electron_v10_lesbar() {
        if cfg!(target_os = "linux") {
            assert!(os::test_roundtrip_peanuts());
        }
    }
}
