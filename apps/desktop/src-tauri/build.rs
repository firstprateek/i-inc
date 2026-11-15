fn main() {
    println!("cargo:rerun-if-env-changed=I_INC_URL");
    tauri_build::build()
}
