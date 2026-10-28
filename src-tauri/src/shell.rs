//! Window policy and IPC boundaries for the bundled connection page and daemon client.
//!
//! The window is either on the bundled connection page (local `tauri://localhost`)
//! or on the daemon origin (`http://127.0.0.1:<port>`). The bundled page receives
//! core APIs; the loopback daemon page receives only the separately scoped
//! notification plugin permissions. `connect` re-checks its caller's URL before
//! using the shell command, so remote content gets no other shell privileges.

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

use crate::daemon;

const MAIN_WINDOW: &str = "main";
/// Builds the `main` window from `tauri.conf.json` (`create: false` there) and
/// attaches the shell policy at build time, before any page loads.
pub fn build_main_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .cloned()
        .ok_or("tauri.conf.json does not declare a `main` window")?;

    let port = daemon::daemon_port();
    let handle = app.clone();

    WebviewWindowBuilder::from_config(app, &config)?
        // WebKitGTK keeps navigator.clipboard disabled unless this is set
        // (selection copy and image paste in the existing client need it).
        .enable_clipboard_access()
        // Navigation never leaves the bundled page or the daemon origin;
        // http(s) links elsewhere open in the system browser from Rust.
        .on_navigation(move |url| {
            if daemon::is_shell_url(url, port) {
                return true;
            }
            if daemon::is_web_url(url) {
                daemon::open_in_browser(url);
            }
            false
        })
        // target=_blank and window.open() requests are handled here too: shell
        // URLs reuse the single window, everything else opens externally, and
        // no URL is ever allowed to spawn an unmanaged webview.
        .on_new_window(move |url, _features| {
            if daemon::is_shell_url(&url, port) {
                if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
                    let _ = window.navigate(url);
                }
            } else if daemon::is_web_url(&url) {
                daemon::open_in_browser(&url);
            }
            NewWindowResponse::Deny
        })
        .build()?;

    // Normalize physical window coordinates to CSS viewport pixels at the
    // backend boundary; the shared frontend contract has no DPR shim.
    let drop_app = app.clone();
    let window = app.get_webview_window(MAIN_WINDOW).ok_or("main window disappeared")?;
    window.on_window_event(move |event| {
        let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) = event else {
            return;
        };
        if paths.is_empty() {
            return;
        }
        let payload = serde_json::json!({
            "paths": paths.iter().map(|path| path.to_string_lossy().into_owned()).collect::<Vec<_>>(),
            "x": position.x,
            "y": position.y,
        });
        let Ok(payload) = serde_json::to_string(&payload) else {
            return;
        };
        if let Some(window) = drop_app.get_webview_window(MAIN_WINDOW) {
            let script = format!(
                "(() => {{ const detail = {payload}; const dpr = window.devicePixelRatio || 1; detail.x /= dpr; detail.y /= dpr; window.dispatchEvent(new CustomEvent('omp-desktop-file-drop', {{ detail }})); }})();"
            );
            let _ = window.eval(script);
        }
    });
    Ok(())
}

/// Second launches focus the running window instead of starting a second shell.
pub fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Called by the bundled connection page (its Retry button calls it again).
///
/// Verifies the daemon through `GET /api/build`, starting the existing
/// `omp-desktopd` systemd user unit when nothing is listening on the port, then
/// navigates the window to the daemon origin so the web client runs
/// same-origin. The blocking probe runs on a worker thread: the window stays
/// responsive while the daemon starts.
#[tauri::command]
pub async fn connect(webview: WebviewWindow) -> Result<String, String> {
    let current = webview
        .url()
        .map_err(|error| format!("cannot read the current page URL: {error}"))?;
    if !daemon::is_bootstrap_url(&current) {
        return Err("connect is only available from the bundled connection page".to_owned());
    }

    let port = daemon::daemon_port();
    let build = tauri::async_runtime::spawn_blocking(move || daemon::connect_blocking(port))
        .await
        .map_err(|error| format!("connection task failed: {error}"))??;

    let target = daemon::daemon_url(port);
    webview
        .navigate(target.clone())
        .map_err(|error| format!("connected to build {build}, but could not open {target}: {error}"))?;

    Ok(build)
}
