#[path = "../build-version.rs"]
mod build_version;

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    build_version::emit("MIAO_TUI_VERSION");
    // The identity names the directory an install keeps this artifact in, so it
    // must be regenerated whenever the binary changes: `emit` narrows cargo's
    // change detection to the manifest, and a stale identity would make two
    // different builds collide on one directory.
    println!("cargo:rerun-if-changed=src");
    // The installer names the directory it keeps a binary in after this identity,
    // so it has to be unique per build and stable for the life of the binary.
    // A source build gets one too: `--build-id` is how an installer asks which
    // artifact it is looking at, before it trusts the file.
    println!("cargo:rustc-env=MIAO_TUI_BUILD_ID={}", build_id());
}

fn build_id() -> String {
    let mut hasher = DefaultHasher::new();
    std::env::var("CARGO_MANIFEST_DIR")
        .unwrap_or_default()
        .hash(&mut hasher);
    std::env::var("MIAO_TUI_VERSION")
        .unwrap_or_default()
        .hash(&mut hasher);
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default()
        .hash(&mut hasher);
    let digest = hasher.finish();
    let hex = format!("{digest:016x}{:016x}", digest.rotate_left(31));
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}
