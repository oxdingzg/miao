import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { readJson, writeJsonAtomic } from "../src/util/persistence"

describe("writeJsonAtomic", () => {
  test("writes and reads back JSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "miao-persist-"))
    try {
      const file = path.join(dir, "state.json")
      await writeJsonAtomic(file, { variant: { "a/b": "high" } })
      const state = await readJson<{ variant?: Record<string, string> }>(file)
      expect(state.variant?.["a/b"]).toBe("high")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("resolves instead of rejecting when the destination cannot be replaced", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "miao-persist-"))
    try {
      // A directory at the destination path makes every rename fail with a
      // non-transient error and the in-place fallback fail too; the helper
      // must still resolve, because persistence is best-effort.
      const file = path.join(dir, "model.json")
      await mkdir(file)
      await expect(writeJsonAtomic(file, { pinned: [] })).resolves.toBeUndefined()
      expect(await readdir(file)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
