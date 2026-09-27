#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"

const crate = path.join(import.meta.dir, "../../crates/miao-native")
const lib = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so"
const base = process.platform === "win32" ? "miao_native" : "libmiao_native"
const source = path.join(crate, "target", "release", `${base}.${lib}`)
const target = path.join(import.meta.dir, "src", "miao-native.node")

await $`cargo build --release`.cwd(crate)
await Bun.write(target, Bun.file(source))
console.log(`built ${target}`)
