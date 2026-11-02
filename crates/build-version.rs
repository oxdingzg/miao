use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Read the product version from this invocation's checkout, not a cached
/// build-script executable's compile-time working directory.
pub fn version(manifest_dir: &Path, asserted: Option<&str>) -> Result<String, String> {
    let root = manifest_dir.join("../../package.json");
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&root)
            .map_err(|error| format!("cannot read {}: {error}", root.display()))?,
    )
    .map_err(|error| format!("invalid root package.json: {error}"))?;
    let version = manifest["version"]
        .as_str()
        .filter(|version| !version.is_empty())
        .ok_or("root package.json must contain a version")?;
    if let Some(expected) = asserted {
        if expected != version {
            return Err(format!(
                "MIAO_VERSION {expected} differs from package.json {version}"
            ));
        }
    }
    Ok(version.to_owned())
}

#[cfg(not(test))]
pub fn emit(name: &str) {
    let manifest_dir = std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory");
    let manifest_dir = Path::new(&manifest_dir);
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("../../package.json").display()
    );
    println!("cargo:rerun-if-changed=../build-version.rs");
    println!("cargo:rerun-if-env-changed=MIAO_VERSION");
    let asserted = std::env::var("MIAO_VERSION").ok();
    let version =
        version(manifest_dir, asserted.as_deref()).unwrap_or_else(|error| panic!("{error}"));
    println!("cargo:rustc-env={name}={version}");
}

/// The identity an installer keeps a build under: unique per build so two
/// different binaries never collide on one install directory, and stable for
/// the life of the binary. A source build gets one too, because `--build-id`
/// is how an installer asks which artifact it is looking at before it trusts
/// the file.
///
/// Each build script includes this module for the subset it needs, so the ones
/// that emit no identity must not warn about it.
#[cfg(not(test))]
#[allow(dead_code)]
pub fn build_id() -> String {
    let mut hasher = DefaultHasher::new();
    std::env::var("CARGO_MANIFEST_DIR")
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
