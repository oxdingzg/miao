import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs"
import { createRequire } from "module"
import os from "os"
import path from "path"

const require = createRequire(import.meta.url)
const nativePath = path.join(import.meta.dir, "../../../../crates/miao-native/miao-native.node")

type Native = {
  walkFiles(root: string, options?: { hidden?: boolean; gitignore?: boolean }): string[]
}

const native: Native | undefined = (() => {
  try {
    return require(nativePath) as Native
  } catch {
    return undefined
  }
})()

if (process.env.MIAO_NATIVE_REQUIRED === "1" && native === undefined) {
  throw new Error(`MIAO_NATIVE_REQUIRED=1 but ${nativePath} is missing; build crates/miao-native first`)
}

const walk = (root: string): string[] => {
  const out: string[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else out.push(path.relative(root, full).replaceAll("\\", "/"))
    }
  }
  visit(root)
  return out.sort()
}

const withNative = native ? describe : describe.skip

withNative("native walk parity", () => {
  test("walkFiles matches a recursive listing with no ignore and hidden included", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "miao-walk-"))
    try {
      mkdirSync(path.join(dir, "sub"))
      writeFileSync(path.join(dir, "a.txt"), "")
      writeFileSync(path.join(dir, "sub/b.txt"), "")
      writeFileSync(path.join(dir, ".hidden"), "")
      mkdirSync(path.join(dir, ".git"))
      writeFileSync(path.join(dir, ".git/HEAD"), "")

      const strip = (paths: string[]) => paths.filter((item) => !item.startsWith(".git/"))
      const actual = strip(native!.walkFiles(dir, { hidden: true, gitignore: false }))
      expect(actual).toEqual(strip(walk(dir)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("walkFiles honors .gitignore", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "miao-walk-git-"))
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir })
      writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n")
      writeFileSync(path.join(dir, "ignored.txt"), "")
      writeFileSync(path.join(dir, "kept.txt"), "")

      const actual = native!.walkFiles(dir, { gitignore: true })
      expect(actual).toContain("kept.txt")
      expect(actual).not.toContain("ignored.txt")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
