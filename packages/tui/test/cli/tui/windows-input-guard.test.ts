import { expect, test } from "bun:test"
import path from "node:path"

test.skipIf(process.platform !== "win32")(
  "real Windows console guard repairs raw echo and respects cooked handoff and teardown",
  async () => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../../fixture/windows-input-guard.ts")], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain("WINDOWS_INPUT_GUARD_VERIFIED")
  },
  10000,
)
