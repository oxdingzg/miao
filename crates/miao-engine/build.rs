fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json");
    println!("cargo:rerun-if-changed={}", root.display());
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root).expect("root manifest"))
            .expect("root manifest JSON");
    println!(
        "cargo:rustc-env=MIAO_ENGINE_VERSION={}",
        manifest["version"].as_str().expect("root version")
    );
}
