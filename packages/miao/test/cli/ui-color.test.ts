import { describe, expect, test } from "bun:test"
import path from "path"

const pkgDir = path.resolve(import.meta.dir, "../..")
const script = 'import { UI } from "./src/cli/ui"; process.stdout.write(UI.logo())'

// Copy the environment without color-related switches so each test controls them
// explicitly; passing empty strings makes Bun warn and emit colored warnings.
function childEnv(overrides: Record<string, string> = {}) {
  const env = { ...process.env }
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  return { ...env, ...overrides }
}

async function logo(overrides: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", "-e", script], {
    cwd: pkgDir,
    env: childEnv(overrides),
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(child.stdout).text()
  await child.exited
  return out
}

describe("CLI plain-text fallback", () => {
  test("non-TTY output is plain (no ANSI)", async () => {
    const out = await logo()
    expect(out).toContain("( o.o )")
    expect(out).not.toContain("\x1b")
  })

  test("NO_COLOR forces plain output", async () => {
    const out = await logo({ NO_COLOR: "1" })
    expect(out).toContain("( o.o )")
    expect(out).not.toContain("\x1b")
  })

  test("FORCE_COLOR still emits ANSI", async () => {
    expect(await logo({ FORCE_COLOR: "1" })).toContain("\x1b")
  })

  test("miao --help stays plain under NO_COLOR", async () => {
    const child = Bun.spawn(["bun", "src/index.ts", "--help"], {
      cwd: pkgDir,
      env: childEnv({ NO_COLOR: "1", MIAO_DISABLE_AUTOUPDATE: "1" }),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    await child.exited
    const out = stdout + stderr
    expect(out).toContain("( o.o )")
    expect(out).not.toContain("\x1b")
  })
})
