// Ludora – Einstieg. Unter Windows kein zusätzliches Konsolenfenster.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ludora_lib::run();
}
