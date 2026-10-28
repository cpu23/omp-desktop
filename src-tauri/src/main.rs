//! omp-desktop native shell. Linux uses the GTK4/WebKitGTK6 shell; macOS and
//! Windows retain the existing Tauri shell.

mod daemon;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(not(target_os = "linux"))]
mod shell;

#[cfg(target_os = "linux")]
fn main() {
    linux::run();
}

#[cfg(not(target_os = "linux"))]
fn main() {
    tauri::Builder::default()
        // The second launch hands its arguments to the running instance and exits.
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
