fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        tauri_build::build();
    }
}
