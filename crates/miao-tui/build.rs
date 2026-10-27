// The product version lives in the root package.json; the release build
// injects it so `miao-tui --version` reports the same version as `miao`.
fn main() {
    println!("cargo:rerun-if-env-changed=MIAO_VERSION");
    if let Ok(version) = std::env::var("MIAO_VERSION") {
        println!("cargo:rustc-env=MIAO_TUI_VERSION={version}");
    }
}
