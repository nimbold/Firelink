fn main() {
    tauri_build::build();

    #[cfg(target_os = "windows")]
    embed_manifest_for_integration_tests();
}

#[cfg(target_os = "windows")]
fn embed_manifest_for_integration_tests() {
    let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("tests/comctl-v6.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
        manifest.display()
    );
}
