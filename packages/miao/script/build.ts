#!/usr/bin/env bun

import { $ } from "bun"
import { existsSync } from "fs"
import { copyFile, mkdir, mkdtemp, rename } from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")
const entitlements = path.join(__dirname, "miao.entitlements")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@miao/script"
import pkg from "../package.json"

const singleFlag = process.argv.includes("--single")
// One macOS runner builds both darwin architectures, so the release does not
// depend on the Intel pool, whose jobs have taken ten times as long as their
// arm64 siblings (and never finished inside their budget). The engine archives
// are cross-compiled to match.
const darwinFlag = process.argv.includes("--darwin")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

const createEmbeddedEngineModule = (enginePath: string) => {
  if (!existsSync(enginePath)) throw new Error(`--engine: no such file: ${enginePath}`)
  const spec = path.relative(dir, enginePath).replaceAll("\\", "/")
  return [
    `import engine from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`,
    `export default engine;`,
  ].join("\n")
}

const engineFlagIndex = process.argv.indexOf("--engine")
const engineFlag = engineFlagIndex !== -1 ? process.argv[engineFlagIndex + 1] : undefined
const embeddedEngineModule = engineFlag ? createEmbeddedEngineModule(engineFlag) : null

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`MIAO_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()
const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = darwinFlag
  ? allTargets.filter((item) => item.os === "darwin" && item.abi === undefined)
  : singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

await $`rm -rf dist`

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}

// Build the miao-native addon for the host so `@miao/native` can embed it. The
// addon is optional: if the build fails (no Rust), callers fall back to TS.
const nativeDir = path.resolve(dir, "../native")
const nativeAddon = path.join(nativeDir, "src/miao-native.node")
try {
  await $`bun run build.ts`.cwd(nativeDir)
} catch (error) {
  console.warn("miao-native addon build failed; native paths will fall back to TS", error)
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"

  // Only embed the addon into a matching-platform binary; hide it otherwise so a
  // wrong-platform .node is not baked in.
  const hostMatch = item.os === process.platform && item.arch === process.arch && item.abi === undefined
  const stash = !hostMatch && existsSync(nativeAddon) ? `${nativeAddon}.stash` : undefined
  const restore = stash ? () => rename(stash, nativeAddon) : undefined
  if (stash) await rename(nativeAddon, stash)

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/miao`,
      execArgv: [`--user-agent=miao/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      [treeSitterWorkerPath]: treeSitterWorker,
      ...(embeddedFileMap ? { "miao-web-ui.gen.ts": embeddedFileMap } : {}),
      ...(embeddedEngineModule ? { "miao-engine.gen.ts": embeddedEngineModule } : {}),
    },
    entrypoints: [
      "./src/index.ts",
      treeSitterWorkerPath,
      ...(embeddedFileMap ? ["miao-web-ui.gen.ts"] : []),
      ...(embeddedEngineModule ? ["miao-engine.gen.ts"] : []),
    ],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      MIAO_VERSION: `'${Script.version}'`,
      MIAO_BUILD_ID: JSON.stringify(crypto.randomUUID()),
      MIAO_MODELS_SNAPSHOT: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
      // Signals a compiled single-file build, so the sandbox runner can
      // re-execute this binary through the hidden `__sandbox-run` command
      // instead of shipping a separate `miao-run` executable.
      MIAO_PACKAGED: "true",
      MIAO_CHANNEL: `'${Script.channel}'`,
      MIAO_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  }).finally(() => restore?.())

  // Embedding the bundle invalidates the linker's ad-hoc signature, and macOS 27+
  // SIGKILLs binaries with invalid pages. Re-sign after every darwin compile — with
  // the Developer ID identity when one is available so release binaries pass
  // Gatekeeper, ad-hoc otherwise.
  if (item.os === "darwin" && process.platform === "darwin") {
    const identity = await developerIdIdentity()
    if (identity) {
      await codesign(["--force", "--options", "runtime", "--timestamp", "--entitlements", entitlements, "--sign", identity, `dist/${name}/bin/miao`])
    } else {
      await codesign(["--force", "--sign", "-", `dist/${name}/bin/miao`])
    }
  }

  // Ship the catalog next to the binary so a fresh install works offline; the
  // runtime reads it before falling back to a network fetch.
  if (generated.modelsData) {
    await Bun.write(`dist/${name}/bin/models.json`, generated.modelsData)
  }

  // Smoke test: only run if binary is for current platform
  const binaryPath = `dist/${name}/bin/miao`
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  if (embeddedEngineModule && item.os === process.platform && item.arch === process.arch && !item.abi && item.os !== "win32") {
    const home = await mkdtemp(path.join(os.tmpdir(), "miao-engine-embed-"))
    try {
      await $`env HOME=${home} ${binaryPath} --version`.quiet()
      const beside = path.join(path.dirname(path.resolve(binaryPath)), "miao-engine")
      const inHome = path.join(home, ".local/share/miao-engine/bin/miao-engine")
      const extracted = existsSync(beside) ? beside : inHome
      const caps = JSON.parse(await $`${extracted} --capabilities`.text())
      if (caps.name !== "miao-engine") throw new Error(`embedded engine reports name ${caps.name}`)
      console.log(`Embedded engine smoke passed: ${extracted} (protocol ${caps.protocol})`)
    } catch (e) {
      console.error(`Embedded engine smoke failed for ${name}:`, e)
      process.exit(1)
    } finally {
      await $`rm -rf ${home}`
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

/**
 * Build the engine binary for this platform (B5) and archive it at the repo
 * root next to the CLI archives. Build failures fail the release rather than
 * uploading a stale binary or silently omitting an advertised platform asset.
 */
async function buildEngineArchive(): Promise<string[]> {
  const os = ({ darwin: "darwin", linux: "linux", win32: "windows" } as Record<string, string | undefined>)[process.platform]
  if (!os) return []
  // Ship a static Linux engine. The CLI archive can rely on the runner's glibc
  // because it is a Bun executable, but a native engine linked against a newer
  // runner glibc refuses to start on the LTS distributions many users run.
  // musl also makes one archive work across glibc versions and distributions.
  const linuxTarget =
    process.platform === "linux"
      ? process.arch === "arm64"
        ? "aarch64-unknown-linux-musl"
        : "x86_64-unknown-linux-musl"
      : undefined
  // The darwin build produces both architectures on one runner, so the archive
  // set does not wait on the Intel pool, whose jobs have taken ten times as long
  // as their arm64 siblings and never finished inside their budget. Every other
  // platform builds its host target as before.
  const wanted = darwinFlag
    ? [
        { target: "aarch64-apple-darwin" as string | undefined, arch: "arm64" },
        { target: "x86_64-apple-darwin" as string | undefined, arch: "x64" },
      ]
    : [{ target: linuxTarget as string | undefined, arch: process.arch === "arm64" ? "arm64" : "x64" }]
  const crate = path.resolve(dir, "../../crates/miao-engine")
  const archives: string[] = []
  for (const { target, arch } of wanted) {
    const musl = target === linuxTarget
    const muslEnv =
      musl && target
        ? {
            [`CC_${target.replaceAll("-", "_")}`]: "musl-gcc",
            [`CARGO_TARGET_${target.toUpperCase().replaceAll("-", "_")}_LINKER`]: "musl-gcc",
          }
        : {}
    await $`cargo build --locked --release --bin miao-engine ${target ? ["--target", target] : []}`
      .cwd(crate)
      // Bun's .env() replaces the whole environment for the command: passing
      // only the musl overrides stripped PATH, so every cc/linker spawn failed
      // with "not found". Merge over the inherited environment instead.
      .env({ ...process.env, ...muslEnv })
    const suffix = process.platform === "win32" ? ".exe" : ""
    const bin = path.join(crate, "target", ...(target ? [target] : []), "release", `miao-engine${suffix}`)
    // A cross-built binary cannot run here, so only the host target asserts its
    // version; the same crate produced both.
    if (!target || musl) {
      const version = (await $`${bin} --version`.text()).trim()
      if (version !== `miao-engine ${Script.version}`)
        throw new Error(`engine version mismatch: ${version}; expected miao-engine ${Script.version}`)
    }
    if (process.platform === "darwin") {
      const identity = await developerIdIdentity()
      if (identity) {
        await codesign(["--force", "--options", "runtime", "--timestamp", "--sign", identity, bin])
      } else {
        await codesign(["--force", "--sign", "-", bin])
      }
    }
    const name = `miao-engine-${os}-${arch}`
    const staging = `dist/${name}`
    await mkdir(staging, { recursive: true })
    const files = [`miao-engine${suffix}`, "LICENSE", "LICENSE-APACHE-2.0", "NOTICE"]
    await Promise.all([
      copyFile(bin, path.join(staging, `miao-engine${suffix}`)),
      copyFile(path.resolve(dir, "../../LICENSE"), path.join(staging, "LICENSE")),
      ...files.slice(2).map((file) => copyFile(path.join(crate, file), path.join(staging, file))),
    ])
    if (process.platform === "win32") {
      await $`powershell -NoProfile -Command ${`Compress-Archive -Path ${staging}/* -DestinationPath dist/${name}.zip -Force`}`
      archives.push(`./dist/${name}.zip`)
      continue
    }
    // darwin uses a zip so the archive is notarizable with the CLI archives.
    if (process.platform === "darwin") {
      await $`zip -r ../${name}.zip ${files}`.cwd(staging)
      archives.push(`./dist/${name}.zip`)
      continue
    }
    await $`tar -czf ../${name}.tar.gz ${files}`.cwd(staging)
    archives.push(`./dist/${name}.tar.gz`)
  }
  return archives
}

if (Script.release) {
  const archives: string[] = []
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
      archives.push(`./dist/${key}.tar.gz`)
    } else if (process.platform === "win32") {
      await $`powershell -NoProfile -Command ${`Compress-Archive -Path dist/${key}/bin/* -DestinationPath dist/${key}.zip -Force`}`
      archives.push(`./dist/${key}.zip`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
      archives.push(`./dist/${key}.zip`)
    }
  }
  // The engine binary rides the same release channel (B5): one archive per
  // platform, built from this commit alongside the CLI.
  archives.push(...(await buildEngineArchive()))

  // Bare executables cannot carry a staple ticket; submitting the zip registers
  // the binary's cdhash and Gatekeeper checks it online at first launch.
  const notary = notaryCredentials()
  if (notary) {
    for (const archive of archives.filter((item) => item.includes("darwin"))) {
      await $`xcrun notarytool submit ${archive} --key ${notary.key} --key-id ${notary.keyId} --issuer ${notary.issuer} --wait`
    }
  }

  for (const archive of archives) {
    const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(archive.slice(2)).arrayBuffer()).digest("hex")
    await Bun.write(`${archive}.sha256`, `${hash}  ${path.basename(archive)}\n`)
  }

  // Upload only the archives this platform produced; a `--single` build never
  // has both `.zip` and `.tar.gz`, and Bun's shell errors on an unmatched glob.
  if (archives.length) {
    const manifests = archives.map((archive) => `${archive}.sha256`)
    await $`gh release upload v${Script.version} ${archives} ${manifests} --clobber --repo ${process.env.GH_REPO}`
  }
}

export { binaries }

// Function declarations hoist: the build loop above runs during module evaluation.
// codesign's `--timestamp` call to Apple's timestamp authority occasionally
// stalls forever on hosted macOS runners. Each attempt is bounded and retried,
// and `--force` makes a retry replace whatever partial signature was written.
async function codesign(args: string[]) {
  const timeoutMs = 60_000
  const attempts = 5
  let lastError = "timed out"
  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`codesign ${args.at(-1)} (attempt ${attempt}/${attempts})`)
    const proc = Bun.spawn(["codesign", ...args], { stdout: "inherit", stderr: "pipe" })
    const stderr = new Response(proc.stderr).text()
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    const exitCode = await proc.exited
    clearTimeout(timer)
    if (exitCode === 0) {
      await stderr
      return
    }
    lastError = (await stderr).trim() || `exit ${exitCode}`
    console.warn(`codesign attempt ${attempt}/${attempts} failed: ${lastError}`)
  }
  throw new Error(`codesign failed after ${attempts} attempts: ${lastError}`)
}

async function developerIdIdentity() {
  const fromEnv = process.env.MIAO_CODESIGN_IDENTITY?.trim()
  if (fromEnv) return fromEnv
  const { stdout } = await $`security find-identity -v -p codesigning`.quiet()
  return stdout
    .toString()
    .split("\n")
    .find((line) => line.includes("Developer ID Application"))
    ?.match(/"(.+)"/)?.[1]
}

function notaryCredentials() {
  const key = process.env.APPLE_API_KEY_P8?.trim()
  const keyId = process.env.APPLE_API_KEY_ID?.trim()
  const issuer = process.env.APPLE_API_ISSUER?.trim()
  if (!key || !keyId || !issuer) return undefined
  return { key, keyId, issuer }
}
