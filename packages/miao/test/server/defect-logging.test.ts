import { describe, expect, test } from "bun:test"
import { Exit, Effect } from "effect"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { HttpApiAssembly } from "@miao/server/assembly"

describe("HttpApiAssembly.defectLogging", () => {
  test("persists a defect to miao.log and keeps it propagating", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "miao-defect-log-"))
    const file = path.join(dir, "miao.log")
    const logged = HttpApiAssembly.defectLogging(file)

    const exit = await Effect.runPromiseExit(logged(Effect.die(new Error("boom"))))
    expect(Exit.isFailure(exit)).toBe(true)

    const text = await readFile(file, "utf8")
    expect(text).toContain("level=ERROR")
    expect(text).toContain('message="http defect"')
    expect(text).toContain("boom")
  })

  test("typed failures stay out of the log", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "miao-defect-log-"))
    const file = path.join(dir, "miao.log")
    const logged = HttpApiAssembly.defectLogging(file)

    const exit = await Effect.runPromiseExit(logged(Effect.fail("typed")))
    expect(Exit.isFailure(exit)).toBe(true)

    await expect(readFile(file, "utf8")).rejects.toThrow()
  })
})
