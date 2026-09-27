#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"

const dir = import.meta.dir
const lib = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so"
const base = process.platform === "win32" ? "miao_native" : "libmiao_native"
const source = path.join(dir, "target", "release", `${base}.${lib}`)
const target = path.join(dir, "miao-native.node")

await $`cargo build --release`.cwd(dir)
await Bun.write(target, Bun.file(source))
console.log(`built ${target}`)
