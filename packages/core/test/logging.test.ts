import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Logging } from "../src/observability/logging"

describe("Logging.appendLine", () => {
  test("writes one structured line matching the file logger shape", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "miao-logging-"))
    const file = path.join(dir, "miao.log")

    await Logging.appendLine("ERROR", "http defect", { cause: new Error("boom") }, file)

    const text = await readFile(file, "utf8")
    const lines = text.trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("level=ERROR")
    expect(lines[0]).toContain("run=")
    expect(lines[0]).toContain('message="http defect"')
    expect(lines[0]).toContain("cause=")
    expect(lines[0]).toContain("boom")
  })

  test("an append failure never rejects", async () => {
    await Logging.appendLine("WARN", "ignored", {}, "/miao-append-line-missing-dir/miao.log")
  })
})
