// Prevents an extra console window from appearing on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Precision touchpads route scroll through Chromium's async/compositor-
    // thread wheel-event path, which is known to drop events intermittently
    // when WebView2 is embedded in a non-browser host window (as opposed to
    // a full Edge window) — this is what causes scroll-to-zoom in the 3D
    // viewer to work in bursts and then go silent. Forcing wheel events onto
    // the older synchronous path avoids that. Must be set before the
    // WebView2 environment is created, i.e. before lib::run().
    #[cfg(target_os = "windows")]
    {
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        let flag = "--disable-features=AsyncWheelEvents,TouchpadAndWheelScrollLatching,ElasticOverscroll";
        let combined = if existing.is_empty() {
            flag.to_string()
        } else {
            format!("{existing} {flag}")
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", combined);
    }

    lib::run()
}