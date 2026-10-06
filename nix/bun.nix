# The bundler the project pins, instead of the one nixpkgs carries.
#
# The version is load-bearing. `bun build --compile --splitting` bakes the
# bundle's module initialization order into the binary, and bun 1.3.13 (what
# nixpkgs has) orders it so that a consumer reads the `ToolPlugins` namespace
# before that namespace is initialized. The resulting binary dies with
# `undefined is not an object (evaluating 'exports_plugins.node')` on every
# subcommand except `--version`. bun 1.3.14, pinned by `packageManager` in the
# root package.json and used by CI for the released binaries, bundles it so the
# same source works.
#
# nixpkgs builds this package from the prebuilt GitHub release, so overriding
# the version only means restating the per-platform sources. Only the build uses
# this; `node_modules.nix` keeps nixpkgs' bun so the fixed-output node_modules
# hash stays valid.
#
# The binary also has to stay byte-identical to that release. `bun build
# --compile` clones the running bun and edits the clone in place, so anything
# nixpkgs' fixup phase would do to the template -- strip, patchelf, rpath
# shrinking -- changes the layout the clone assumes and yields a binary that
# segfaults at startup. `dontFixup` keeps the artifact as released, and
# `postPhases` drops the completion phase that would otherwise have to execute
# the unpatched binary. `./miao.nix` re-points a throwaway copy at the store's
# interpreter when it needs to run it.
{ bun, fetchurl }:
let
  version = "1.3.14";
  source =
    file: hash:
    fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v${version}/${file}";
      inherit hash;
    };
in
bun.overrideAttrs (old: {
  # The version bump comes with the sources below, so nixpkgs' "you overrode
  # `version` without overriding `src`" warning does not apply here.
  __intentionallyOverridingVersion = true;
  inherit version;

  dontFixup = true;
  postPhases = [ ];

  passthru = old.passthru // {
    sources = {
      "aarch64-darwin" = source "bun-darwin-aarch64.zip" "sha256-2LliIYKK1vl6x6wKt+lYcjQa92MAHogD6CZ2UsJlJiA=";
      "x86_64-darwin" = source "bun-darwin-x64-baseline.zip" "sha256-PjWtb1OXGpg0v55nhuKt9ytfGSHMmpxf3gc9KXKUQHY=";
      "aarch64-linux" = source "bun-linux-aarch64.zip" "sha256-on/7Y6gxA3WDbg1vZorhf6jY0YuIw3yCHGUzGXOhmjs=";
      "x86_64-linux" = source "bun-linux-x64.zip" "sha256-lR7iruhV8IWVruxiJSJqKY0/6oOj3NZGXAnLzN9+hI8=";
    };
  };
})
