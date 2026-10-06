import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// A crash record is only useful if it survives the process, so exercise it in a
// child with an isolated data dir: the parent cannot observe the file otherwise.
test("an uncaught error is recorded to crash.log", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miao-crash-"))
  const script = path.join(root, "record.ts")
  await Bun.write(
    script,
    `
import { Crash } from ${JSON.stringify(fileURLToPath(new URL("../../src/cli/crash.ts", import.meta.url)))}
Crash.recordCrash("uncaughtException", new Error("boom-42"))
Crash.recordCrash("unhandledRejection", { name: "Opaque", message: "no stack" })
`,
  )
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, XDG_DATA_HOME: path.join(root, "data") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited).toBe(0)
  expect(stderr).toContain("boom-42")

  const lines = (await Bun.file(path.join(root, "data", "miao", "log", "crash.log")).text()).trim().split("\n")
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain("uncaughtException")
  expect(lines[0]).toContain("thread=main")
  expect(lines[0]).toContain("boom-42")
  expect(lines[1]).toContain("unhandledRejection")
  expect(lines[1]).toContain("no stack")
})
