// Shared entry point for the Tauri app (desktop now, mobile-ready for later).
// The frontend is the existing Vite static build in ../dist — this app has no
// native/backend needs beyond opening external links, so there is no custom
// command surface yet.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings6;
                use windows::core::Interface;

                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| unsafe {
                        if let Ok(settings) = webview.controller().CoreWebView2() {
                            if let Ok(settings) = settings.Settings() {
                                if let Ok(settings) = settings.cast::<ICoreWebView2Settings6>() {
                                    let _ = settings.SetIsPinchZoomEnabled(false);
                                    let _ = settings.SetIsSwipeNavigationEnabled(false);
                                }
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}