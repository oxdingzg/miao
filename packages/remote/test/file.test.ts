import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readJson, writePrivate, writer } from "../src/file"

test("writes owner-only JSON atomically and reads it back", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remote-file-"))
  try {
    const file = path.join(directory, "nested", "state.json")
    expect(await readJson(file)).toBeUndefined()
    await writePrivate(file, { a: 1 })
    expect(await readJson(file)).toEqual({ a: 1 })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700)

    const save = writer(file, (error) => {
      throw error
    })
    await Promise.all([1, 2, 3].map((value) => save(() => ({ a: value }))))
    expect(await readJson(file)).toEqual({ a: 3 })
    expect(await readdir(path.dirname(file))).toEqual(["state.json"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
