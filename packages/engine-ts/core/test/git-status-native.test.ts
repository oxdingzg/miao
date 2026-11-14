import { describe, expect, test } from "bun:test"
import { execFile } from "child_process"
import fs from "fs/promises"
import path from "path"
import { promisify } from "util"
import { native } from "@miao/native"
import { tmpdir } from "./fixture/tmpdir"

/**
 * Parity between the native `gitStatus` primitive and the
 * `git status`/`git diff --numstat` contract that V2 `Git.status.entries`
 * exposes. The addon is absent in a plain checkout, so the suite skips; CI
 * builds it and sets `MIAO_NATIVE_REQUIRED=1` to fail instead of skipping.
 */
const exec = promisify(execFile)
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd })

const activeNative = typeof native?.gitStatusAsync === "function" ? native : undefined

if (process.env.MIAO_NATIVE_REQUIRED === "1" && activeNative === undefined) {
  throw new Error("MIAO_NATIVE_REQUIRED=1 but the @miao/native addon does not expose gitStatusAsync")
}

const withNative = activeNative ? describe : describe.skip

withNative("native git status parity", () => {
  test("matches git porcelain and numstat for a changed working tree", async () => {
    const root = await tmpdir()
    try {
      await git(root.path, "init", "-q")
      await git(root.path, "config", "user.email", "test@example.com")
      await git(root.path, "config", "user.name", "Test")
      await fs.writeFile(path.join(root.path, "tracked.txt"), "one\n")
      await fs.writeFile(path.join(root.path, "deleted.txt"), "gone\n")
      await fs.writeFile(path.join(root.path, "bin.dat"), Buffer.from([0, 1, 2, 255, 254]))
      await git(root.path, "add", "-A")
      await git(root.path, "commit", "-qm", "initial")

      await fs.writeFile(path.join(root.path, "tracked.txt"), "one\ntwo\n")
      await fs.writeFile(path.join(root.path, "added.txt"), "new\n")
      await fs.writeFile(path.join(root.path, "bin.dat"), Buffer.from([0, 1, 2, 3]))
      await fs.rm(path.join(root.path, "deleted.txt"))

      const entries = (await activeNative!.gitStatusAsync(root.path))
        .map((entry) => ({
          path: entry.path,
          status: entry.status,
          additions: entry.additions,
          deletions: entry.deletions,
        }))
        .toSorted((left, right) => left.path.localeCompare(right.path))

      expect(entries).toEqual([
        { path: "added.txt", status: "added", additions: 1, deletions: 0 },
        { path: "bin.dat", status: "modified", additions: 0, deletions: 0 },
        { path: "deleted.txt", status: "deleted", additions: 0, deletions: 1 },
        { path: "tracked.txt", status: "modified", additions: 1, deletions: 0 },
      ])
    } finally {
      await root[Symbol.asyncDispose]()
    }
  })
})
