fn main() {
    println!("cargo:rerun-if-env-changed=I_INC_URL");
    // App commands get `allow-<command>` permissions, so each capability names the ones it may call: the
    // launcher its three, the daemon's pages only `reset_zoom` and `restart_app` (capabilities/*.json).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["default_daemon", "daemon_override", "use_daemon", "reset_zoom", "restart_app"]),
    ))
    .expect("tauri build")
}
