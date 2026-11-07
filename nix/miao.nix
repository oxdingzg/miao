{
  lib,
  rustPlatform,
  makeBinaryWrapper,
  models-dev,
  writableTmpDirAsHomeHook,
  ripgrep,
  installShellFiles,
  versionCheckHook,
}:
let
  # The product version comes from the root manifest, the same file the Rust
  # build reads at compile time for `miao --version`.
  version = (lib.importJSON ../package.json).version;

  # Only what the crates compile in: their sources, the prompt and skill text
  # they `include_str!`, and the root manifest build-version.rs reads.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../crates
      ../assets
      ../package.json
    ];
  };
in
rustPlatform.buildRustPackage {
  pname = "miao";
  inherit version src;

  # The product is one binary built from miao-cli, which links the engine and
  # the TUI as path dependencies. Each crate keeps its own manifest and lock
  # file, so this build names the one it installs.
  cargoRoot = "crates/miao-cli";
  cargoLock.lockFile = ../crates/miao-cli/Cargo.lock;

  # The crates own extensive suites, and CI runs them per shard against a
  # toolchain and fixtures this build does not provide.
  doCheck = false;

  nativeBuildInputs = [
    makeBinaryWrapper
    installShellFiles
    # `miao completion` runs during install and needs a writable HOME.
    writableTmpDirAsHomeHook
  ];

  postInstall = ''
    installShellCompletion --cmd miao \
      --bash <($out/bin/miao completion bash) \
      --zsh <($out/bin/miao completion zsh)

    wrapProgram $out/bin/miao \
      --prefix PATH : ${lib.makeBinPath [ ripgrep ]}
  '';

  nativeInstallCheckInputs = [ versionCheckHook ];
  doInstallCheck = true;
  versionCheckProgramArg = "--version";

  passthru = {
    # The desktop derivation builds the TypeScript app, which still reads the
    # model snapshot and the product identity from these variables.
    env = {
      MODELS_DEV_API_JSON = "${models-dev}/dist/_api.json";
      MIAO_DISABLE_MODELS_FETCH = true;
      MIAO_VERSION = version;
      MIAO_CHANNEL = "prod";
    };
  };

  meta = {
    description = "The open source coding agent";
    homepage = "https://mtty.dev/miao/";
    license = lib.licenses.mit;
    mainProgram = "miao";
    platforms = [
      "aarch64-linux"
      "x86_64-linux"
      "aarch64-darwin"
      "x86_64-darwin"
    ];
  };
}
