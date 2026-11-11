fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        tauri_build::try_build(
            tauri_build::Attributes::new().app_manifest(
                tauri_build::AppManifest::new()
                    .commands(&["connect", "select_workspace_directory", "show_workspace_folder"]),
            ),
        )
        .expect("failed to configure Tauri command permissions");
    }
}
