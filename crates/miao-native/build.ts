#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"

const dir = import.meta.dir
const lib = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so"
const source = path.join(dir, "target", "release", `libmiao_native.${lib}`)
const target = path.join(dir, "miao-native.node")

await $`cargo build --release`.cwd(dir)
await Bun.write(target, Bun.file(source))
console.log(`built ${target}`)
