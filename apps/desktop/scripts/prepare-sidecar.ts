#!/usr/bin/env bun
import { $ } from "bun"
import { chmod, copyFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

// Tauri's `externalBin` resolves to `sidecars/miao-cli-<target triple>` at build
// time and fails when the file is absent. The sidecar is the same single binary
// the CLI ships, so prepare it from a local build rather than a published
// artifact: no desktop release exists yet to pin one.
const root = join(import.meta.dir, "../../..")
const tauri = join(import.meta.dir, "../src-tauri")

async function hostTriple() {
  const output = await $`rustc -vV`.quiet()
  const host = output
    .text()
    .split("\n")
    .find((line) => line.startsWith("host:"))
  return host?.slice("host:".length).trim()
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE ?? (await hostTriple())
if (!triple) throw new Error("could not determine the Rust target triple; set TAURI_ENV_TARGET_TRIPLE")

const windows = triple.includes("windows")
const profile = process.env.MIAO_PROFILE ?? (Bun.env.NODE_ENV === "production" ? "release" : "debug")
const built = join(root, "crates/miao-cli/target", triple, profile, windows ? "miao.exe" : "miao")
const source = Bun.env.MIAO_BINARY ?? built
const target = join(tauri, "sidecars", `miao-cli-${triple}${windows ? ".exe" : ""}`)

if (!(await Bun.file(source).exists())) {
  throw new Error(
    `sidecar binary not found at ${source}\n` +
      `build it first (crates/miao-cli, ${profile} profile), or point MIAO_BINARY at an existing miao binary`,
  )
}

await mkdir(dirname(target), { recursive: true })
await copyFile(source, target)
await chmod(target, 0o755)
console.log(`prepared sidecar ${target}`)
