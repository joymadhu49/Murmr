// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK on Linux/Wayland sometimes renders the entire window black
    // (DMABUF + GBM path bug). Force the legacy compositor before the webview boots.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        // Force XWayland on Wayland sessions so window positioning (HUD overlay)
        // and global shortcuts (push-to-talk hotkey) work — both rely on X11 APIs
        // that Wayland compositors don't expose to clients.
        let on_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false);
        if on_wayland {
            std::env::set_var("GDK_BACKEND", "x11");
            std::env::remove_var("WAYLAND_DISPLAY");
        }
    }

    murmr_lib::run()
}
