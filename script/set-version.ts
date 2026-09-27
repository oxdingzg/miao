#!/usr/bin/env bun
// Set the version in every workspace package.json to a given value (defaults to
// the computed release version). Run before tagging a release, then
// `bun install --lockfile-only` to sync the lockfile.
//
//   bun script/set-version.ts 0.0.1
//   bun script/set-version.ts            # uses @miao/script's computed version
import { Glob } from "bun"
import { Script } from "@miao/script"

const version = process.argv[2] ?? Script.version

let changed = 0
for await (const file of new Glob("**/package.json").scan({ cwd: process.cwd() })) {
  if (file.includes("node_modules") || file.includes("/dist/") || file.startsWith("dist/")) continue
  const text = await Bun.file(file).text()
  const next = text.replace(/^(\s*"version":\s*)"[^"]*"/m, (_match, prefix: string) => `${prefix}"${version}"`)
  if (next === text) continue
  await Bun.write(file, next)
  changed++
  console.log(file)
}
console.log(`set version ${version} in ${changed} files`)
