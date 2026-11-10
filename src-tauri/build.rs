fn main() {
    // Zugangsdaten des Ludora-Servers: wie in der Electron-Version aus electron/hub-config.json
    // (im Release-Build von GitHub Actions erzeugt; lokal optional).
    let cfg = std::path::Path::new("../electron/hub-config.json");
    println!("cargo:rerun-if-changed=../electron/hub-config.json");
    let text = std::fs::read_to_string(cfg).unwrap_or_default();
    let pick = |key: &str| -> String {
        let re = format!("\"{key}\"");
        text.find(&re)
            .and_then(|i| {
                let rest = &text[i + re.len()..];
                let start = rest.find('"')? + 1;
                let end = rest[start..].find('"')? + start;
                Some(rest[start..end].to_string())
            })
            .unwrap_or_default()
    };
    println!("cargo:rustc-env=LUDORA_HUB_URL={}", pick("url"));
    println!("cargo:rustc-env=LUDORA_HUB_KEY={}", pick("anonKey"));
    println!("cargo:rustc-env=LUDORA_HUB_FUNCTION={}", pick("linkFunction"));
    tauri_build::build()
}
