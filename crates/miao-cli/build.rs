#[path = "../build-version.rs"]
mod build_version;

fn main() {
    build_version::emit("MIAO_CLI_VERSION");
    // A stale identity would make two different builds collide on one install
    // directory, so any change to the sources regenerates it.
    println!("cargo:rerun-if-changed=src");
    // The installer names the directory it keeps a binary in after this identity,
    // so it has to be unique per build and stable for the life of the binary.
    // A source build gets one too: `--build-id` is how an installer asks which
    // artifact it is looking at, before it trusts the file.
    println!(
        "cargo:rustc-env=MIAO_CLI_BUILD_ID={}",
        build_version::build_id()
    );
}
