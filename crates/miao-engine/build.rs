#[path = "../build-version.rs"]
mod build_version;

fn main() {
    build_version::emit("MIAO_ENGINE_VERSION");
}
