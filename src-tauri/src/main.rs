//! omp-desktop native shell (Tauri 2 / WebKitGTK).
//!
//! The shell owns no daemon lifetime: the Bun daemon runs as the
//! `omp-desktopd` systemd user unit, and closing this window never stops it.

mod daemon;
mod shell;

#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

fn main() {
    prefer_x11_under_wayland_nvidia();

    tauri::Builder::default()
        // Must be the first plugin so a second launch hands its arguments to
        // the running instance and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _arguments, _cwd| {
            shell::focus_main_window(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![shell::connect])
        .setup(|app| {
            shell::build_main_window(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run omp desktop");
}

/// Prefer the X11 (XWayland) GDK backend on Wayland sessions with the NVIDIA
/// driver, before GTK is initialized by the Tauri builder.
///
/// GTK3's integer Wayland scale inflated the framebuffer at fractional desktop
/// scaling, reducing measured four-pane rendering from 61 fps to 18 fps on the
/// NVIDIA workstation. XWayland preserves its fractional scale. Keep explicit
/// backend choices and other graphics configurations unchanged; see README.
fn prefer_x11_under_wayland_nvidia() {
    #[cfg(target_os = "linux")]
    if let Some(preference) = linux_backend_preference() {
        std::env::set_var("GDK_BACKEND", preference);
    }
}

/// `x11,wayland` means "X11 first, Wayland if XWayland cannot be opened", so a
/// missing or failed XWayland connection still starts the app. GTK splits
/// `GDK_BACKEND` on commas and tries each backend until one opens a display.
/// Only a non-empty value counts as an explicit user choice; an empty
/// `GDK_BACKEND` would open no display at all in GTK, so it is replaced.
#[cfg(target_os = "linux")]
fn linux_backend_preference() -> Option<&'static str> {
    let user_chose = std::env::var_os("GDK_BACKEND").is_some_and(|value| !value.is_empty());
    gdk_backend_preference(
        user_chose,
        wayland_session(),
        nvidia_driver_loaded(),
        xwayland_display_available(),
    )
}

/// The X11 preference applies only to the measured configuration: a Wayland
/// session whose NVIDIA kernel driver is loaded, on a desktop that exposes an
/// XWayland display to connect to. Everything else keeps GTK's own defaults.
fn gdk_backend_preference(
    gdk_backend_set: bool,
    wayland_session: bool,
    nvidia_loaded: bool,
    xwayland_available: bool,
) -> Option<&'static str> {
    if gdk_backend_set || !wayland_session || !nvidia_loaded || !xwayland_available {
        return None;
    }
    Some("x11,wayland")
}

#[cfg(target_os = "linux")]
fn wayland_session() -> bool {
    let display = std::env::var_os("WAYLAND_DISPLAY");
    display.is_some_and(|value| !value.is_empty())
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|value| value == "wayland")
}

/// The NVIDIA kernel module exposes this procfs file while it is loaded;
/// reading it avoids spawning a GPU query such as `nvidia-smi`.
#[cfg(target_os = "linux")]
fn nvidia_driver_loaded() -> bool {
    Path::new("/proc/driver/nvidia/version").exists()
}

/// XWayland is usable when `DISPLAY` points at a local X server socket.
#[cfg(target_os = "linux")]
fn xwayland_display_available() -> bool {
    std::env::var("DISPLAY")
        .ok()
        .and_then(|display| xwayland_socket(&display))
        .is_some_and(|socket| is_socket(&socket))
}

/// `:0` and `:0.0` name local displays (XWayland on Wayland); remote and
/// malformed values are ignored. Local X sockets live in /tmp/.X11-unix/X<n>.
#[cfg(target_os = "linux")]
fn xwayland_socket(display: &str) -> Option<PathBuf> {
    let number = display.strip_prefix(':')?.split('.').next()?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(PathBuf::from(format!("/tmp/.X11-unix/X{number}")))
}

#[cfg(target_os = "linux")]
fn is_socket(path: &Path) -> bool {
    use std::os::unix::fs::FileTypeExt;
    std::fs::metadata(path).is_ok_and(|metadata| metadata.file_type().is_socket())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_gdk_backend_wins() {
        assert_eq!(gdk_backend_preference(true, true, true, true), None);
        assert_eq!(gdk_backend_preference(true, true, false, false), None);
    }

    #[test]
    fn x11_preference_requires_wayland_nvidia_and_xwayland() {
        assert_eq!(
            gdk_backend_preference(false, true, true, true),
            Some("x11,wayland")
        );
        assert_eq!(gdk_backend_preference(false, false, true, true), None);
        assert_eq!(gdk_backend_preference(false, true, false, true), None);
        assert_eq!(gdk_backend_preference(false, true, true, false), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn xwayland_socket_accepts_only_local_displays() {
        assert_eq!(
            xwayland_socket(":0"),
            Some(PathBuf::from("/tmp/.X11-unix/X0"))
        );
        assert_eq!(
            xwayland_socket(":12.0"),
            Some(PathBuf::from("/tmp/.X11-unix/X12"))
        );
        assert_eq!(xwayland_socket(":abc"), None);
        assert_eq!(xwayland_socket("host:0"), None);
        assert_eq!(xwayland_socket("hostname/unix:0"), None);
        assert_eq!(xwayland_socket(""), None);
    }

}
