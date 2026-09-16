// Shared entry point for the Tauri app (desktop now, mobile-ready for later).
// The frontend is the existing Vite static build in ../dist — this app has no
// native/backend needs beyond opening external links, so there is no custom
// command surface yet.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
