#!/usr/bin/env bun
// Root package.json owns the version; workspace manifests are synchronized copies.
// bun script/set-version.ts X.Y.Z updates the root and all workspace versions.
// bun script/set-version.ts synchronizes workspaces with the existing root version.
import { $, Glob } from "bun"
import semver from "semver"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const manifest = await Bun.file(path.join(root, "package.json")).json()
const version = process.argv[2] ?? manifest.version
if (typeof version !== "string" || !semver.valid(version)) throw new Error("Expected a semantic version X.Y.Z")

const files = new Set(["package.json"])
for (const pattern of manifest.workspaces.packages) {
  for await (const file of new Glob(`${pattern}/package.json`).scan({ cwd: root })) files.add(file)
}
for (const file of files) {
  const target = Bun.file(path.join(root, file))
  const text = await target.text()
  const next = text.replace(/^(\s*"version":\s*)"[^"]*"/m, (_match, prefix: string) => `${prefix}"${version}"`)
  if (next === text) continue
  await Bun.write(target, next)
  console.log(file)
}
// Mirror the workspace versions into bun.lock. Without this, CI's `bun install`
// rewrites the lockfile's workspace entries, and the generate job (which can
// only fail on a protected branch) reports drift nobody committed.
await $`bun install --lockfile-only`.cwd(root)
console.log(`workspace versions synchronized to ${version}`)
