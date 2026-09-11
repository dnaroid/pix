fn main() {
    // `watch:all` builds Vite first and then invokes `tauri build` with
    // `beforeBuildCommand` disabled. Tauri's generated build script does not
    // register frontendDist as a Cargo input, so a web-only rebuild can leave
    // the previously embedded asset manifest in an otherwise "fresh" Rust
    // crate. Track Vite's entrypoint explicitly: its hashed asset references
    // change whenever the production web bundle changes.
    println!("cargo:rerun-if-changed=../dist/index.html");
    tauri_build::build()
}
