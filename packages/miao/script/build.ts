#!/usr/bin/env bun

import { $ } from "bun"
import { copyFile, mkdir } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

import { Script } from "@miao/script"

// One macOS runner builds both darwin architectures, so the release does not
// depend on the Intel pool, whose jobs have taken ten times as long as their
// arm64 siblings (and never finished inside their budget).
const darwinFlag = process.argv.includes("--darwin")

// Which crate is the product is decided once, here. `docs/cli.md` names
// `crates/miao-cli` (`miao`) as the single binary, and this pipeline has to build
// that same crate: naming another one ships a binary that answers `--version`
// but not the documented `models`/`auth`/`serve` commands, which is how a
// release once published the bare TUI under the product's name.
const PRODUCT = { crate: "miao-cli", binary: "miao" } as const

if (process.argv.includes("--native-cli")) {
  await $`rm -rf dist`
  const { archives } = await buildNativeArchives({
    ...PRODUCT,
    licenses: [path.resolve(dir, "../../LICENSE")],
    env: { MIAO_VERSION: Script.version },
    // The installer keeps a build under `--build-id` before it trusts the file,
    // so the artifact this pipeline uploads has to answer it, not just --version.
    identity: true,
  })
  if (Script.release && archives.length) {
    // Bare executables cannot carry a staple ticket; submitting the zip
    // registers the binary's cdhash and Gatekeeper checks it online.
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
    const manifests = archives.map((archive) => `${archive}.sha256`)
    await $`gh release upload v${Script.version} ${archives} ${manifests} --clobber --repo ${process.env.GH_REPO}`
  }
  console.log(`native release artifact: ${archives.join(", ")}`)
  process.exit(0)
}

// This pipeline builds the release artifact and nothing else. The TypeScript
// bundler that used to live here went with the TypeScript product: `miao` is the
// Rust binary, and `install` fetches exactly the archive built above.
console.error(
  "usage: build.ts --native-cli\n\n" +
    "Builds the product archive for this platform, and uploads it when the\n" +
    "environment marks a release. Pass --darwin to build both darwin\n" +
    "architectures from one runner.",
)
process.exit(1)

function hostOs() {
  return ({ darwin: "darwin", linux: "linux", win32: "windows" } as Record<string, string | undefined>)[
    process.platform
  ]
}

/// The static Linux target for this architecture. The CLI archive can rely on
/// the runner's glibc because it is a Bun executable, but a native binary
/// linked against a newer runner glibc refuses to start on the LTS
/// distributions many users run. musl also makes one archive work across glibc
/// versions and distributions.
function linuxMuslTarget(arch: string) {
  return arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl"
}

/// The target/arch pairs a native build produces on this host. The darwin
/// build produces both architectures on one runner, so the archive set does
/// not wait on the Intel pool; every other platform builds its host target.
function nativeTargets(): { target: string | undefined; arch: string }[] {
  if (darwinFlag)
    return [
      { target: process.arch === "arm64" ? undefined : "aarch64-apple-darwin", arch: "arm64" },
      { target: process.arch === "x64" ? undefined : "x86_64-apple-darwin", arch: "x64" },
    ]
  return [
    {
      target: process.platform === "linux" ? linuxMuslTarget(process.arch) : undefined,
      arch: process.arch === "arm64" ? "arm64" : "x64",
    },
  ]
}

/**
 * Build, sign, and archive one native binary per target. The product binary and
 * the companion archives ride the same release, so they share the musl, signing,
 * and archiving rules instead of growing variants that can drift.
 *
 * Build failures fail the release rather than uploading a stale binary or
 * silently omitting an advertised platform asset.
 */
async function buildNativeArchives(spec: {
  crate: string
  binary: string
  /** Archive and in-archive name, when it differs from the built binary. */
  archiveAs?: string
  licenses: string[]
  env?: Record<string, string>
  /** Assert the installer's `--build-id` probe, not just `--version`. */
  identity?: boolean
}): Promise<{ archives: string[]; bins: Record<string, string> }> {
  const os = hostOs()
  if (!os) return { archives: [], bins: {} }
  const crate = path.resolve(dir, "../../crates", spec.crate)
  const suffix = process.platform === "win32" ? ".exe" : ""
  const archives: string[] = []
  const bins: Record<string, string> = {}
  for (const { target, arch } of nativeTargets()) {
    const musl = process.platform === "linux" && target === linuxMuslTarget(process.arch)
    const muslEnv =
      musl && target
        ? {
            [`CC_${target.replaceAll("-", "_")}`]: "musl-gcc",
            [`CARGO_TARGET_${target.toUpperCase().replaceAll("-", "_")}_LINKER`]: "musl-gcc",
          }
        : {}
    await $`cargo build --locked --release --bin ${spec.binary} ${target ? ["--target", target] : []}`
      .cwd(crate)
      // Bun's .env() replaces the whole environment for the command: passing
      // only the musl overrides stripped PATH, so every cc/linker spawn failed
      // with "not found". Merge over the inherited environment instead.
      .env({ ...process.env, ...muslEnv, ...spec.env })
    const bin = path.join(
      path.resolve(crate, process.env.CARGO_TARGET_DIR ?? "target"),
      ...(target ? [target] : []),
      "release",
      `${spec.binary}${suffix}`,
    )
    // A cross-built binary cannot run here, so only the host target asserts its
    // version; the same crate produced both.
    if (!target || musl) {
      const reported = (await $`${bin} --version`.text()).trim()
      if (reported !== `${spec.binary} ${Script.version}`)
        throw new Error(`${spec.binary} version mismatch: ${reported}; expected ${spec.binary} ${Script.version}`)
      if (spec.identity) {
        const id = (await $`${bin} --build-id`.text()).trim()
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
          throw new Error(`${spec.binary} --build-id answered ${JSON.stringify(id)}; an installer requires a UUID`)
      }
    }
    if (process.platform === "darwin") {
      const identity = await developerIdIdentity()
      if (identity) {
        await codesign(["--force", "--options", "runtime", "--timestamp", "--sign", identity, bin])
      } else {
        await codesign(["--force", "--sign", "-", bin])
      }
    }
    bins[`${process.platform}-${arch}`] = bin
    // A release ships the Rust binary as `miao` itself: it carries the engine
    // in-process, so the name inside the archive is the product's entry point.
    const staged = `${spec.archiveAs ?? spec.binary}${suffix}`
    const name = `${spec.archiveAs ?? spec.binary}-${os}-${arch}`
    const staging = `dist/${name}`
    await mkdir(staging, { recursive: true })
    const files = [staged, ...spec.licenses.map((file) => path.basename(file))]
    await Promise.all([
      copyFile(bin, path.join(staging, staged)),
      ...spec.licenses.map((file) => copyFile(file, path.join(staging, path.basename(file)))),
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
  return { archives, bins }
}

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
