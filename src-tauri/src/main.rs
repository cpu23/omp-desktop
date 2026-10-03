//! omp-desktop native shell (Tauri 2 / WebKitGTK).
//!
//! The shell owns no daemon lifetime: the Bun daemon runs as the
//! `omp-desktopd` systemd user unit, and closing this window never stops it.

mod daemon;
mod shell;

fn main() {
    tauri::Builder::default()
        // Must be the first plugin so a second launch hands its arguments to
        // the running instance and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _arguments, _cwd| {
            shell::focus_main_window(app);
        }))
        .invoke_handler(tauri::generate_handler![shell::connect])
        .setup(|app| {
            shell::build_main_window(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run omp desktop");
}
