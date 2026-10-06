{
  lib,
  stdenvNoCC,
  callPackage,
  nodejs,
  python3,
  sysctl,
  makeBinaryWrapper,
  models-dev,
  ripgrep,
  installShellFiles,
  versionCheckHook,
  writableTmpDirAsHomeHook,
  glibc,
  node_modules ? callPackage ./node-modules.nix { },
}:
let
  # `bun build --compile` bakes a module initialization order into the binary,
  # and nixpkgs' bun produces one that crashes at startup. See ./bun.nix.
  bun = callPackage ./bun.nix { };

  # The store's loader for the platform, which is what the compiled binary has
  # to name as its interpreter to be runnable outside the build sandbox.
  ldso = "${glibc}/lib/ld-linux-${if stdenvNoCC.hostPlatform.isAarch64 then "aarch64.so.1" else "x86-64.so.2"}";
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "miao";
  inherit (node_modules) version src;
  inherit node_modules;

  nativeBuildInputs = [
    nodejs # for patchShebangs node_modules
    python3 # for patch-interp.py, see buildPhase
    installShellFiles
    makeBinaryWrapper
    models-dev
    writableTmpDirAsHomeHook
  ];

  configurePhase = ''
    runHook preConfigure

    cp -R ${finalAttrs.node_modules}/. .
    patchShebangs node_modules
    patchShebangs packages/*/node_modules

    runHook postConfigure
  '';

  env.MODELS_DEV_API_JSON = "${models-dev}/dist/_api.json";
  env.MIAO_DISABLE_MODELS_FETCH = true;
  env.MIAO_VERSION = finalAttrs.version;
  env.MIAO_CHANNEL = "prod";

  buildPhase = ''
    runHook preBuild

    ${lib.optionalString stdenvNoCC.hostPlatform.isLinux ''
      # Build with a bun that can actually run here, without touching the layout
      # the compiler depends on. `bun build --compile` clones the running bun and
      # reuses its ELF layout, so the template must stay byte-identical to the
      # GitHub release: nixpkgs' bun is patchelf'd to the store's glibc, which
      # relocates the file by a page, and the binaries it compiles then segfault
      # before main. Rewriting a throwaway copy's interpreter in place (see
      # ./patch-interp.py) keeps the file the same size, and the compiled
      # binary inherits the store path -- so it needs no patching either.
      mkdir -p ./bun-bin
      cp -f ${bun}/bin/bun ./bun-bin/bun
      chmod 755 ./bun-bin/bun
      python3 ${./patch-interp.py} ./bun-bin/bun ${ldso}
      ./bun-bin/bun --version
      export PATH="$PWD/bun-bin:$PATH"
    ''}
    ${lib.optionalString stdenvNoCC.hostPlatform.isDarwin ''
      # The darwin release artifact already runs against the system libraries.
      export PATH="${bun}/bin:$PATH"
    ''}

    cd ./packages/miao
    bun --bun ./script/build.ts --single --skip-install
    bun --bun ./script/schema.ts schema.json

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 dist/miao-*/bin/miao $out/bin/miao
    install -Dm644 schema.json $out/share/miao/schema.json

    wrapProgram $out/bin/miao \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            ripgrep
          ]
          # bun runs sysctl to detect if running on rosetta2
          ++ lib.optional stdenvNoCC.hostPlatform.isDarwin sysctl
        )
      }

    runHook postInstall
  '';

  postInstall = lib.optionalString (stdenvNoCC.buildPlatform.canExecute stdenvNoCC.hostPlatform) ''
    # trick yargs into also generating zsh completions
    installShellCompletion --cmd miao \
      --bash <($out/bin/miao completion) \
      --zsh <(SHELL=/bin/zsh $out/bin/miao completion)
  '';

  nativeInstallCheckInputs = [
    versionCheckHook
    writableTmpDirAsHomeHook
  ];
  doInstallCheck = true;
  versionCheckKeepEnvironment = [ "HOME" "MIAO_DISABLE_MODELS_FETCH" ];
  versionCheckProgramArg = "--version";

  passthru = {
    jsonschema = "${placeholder "out"}/share/miao/schema.json";
    env = finalAttrs.env;
  };

  meta = {
    description = "The open source coding agent";
    homepage = "https://mtty.dev/miao/";
    license = lib.licenses.mit;
    mainProgram = "miao";
    inherit (node_modules.meta) platforms;
  };
})
