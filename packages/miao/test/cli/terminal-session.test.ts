import { expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { TerminalSession } from "@/cli/tui/terminal-session"
import { tmpdir } from "../fixture/fixture"

async function reports(file: string, count: number) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const lines = (
      await Bun.file(file)
        .text()
        .catch(() => "")
    )
      .trim()
      .split("\n")
      .filter(Boolean)
    if (lines.length >= count) return lines.map((line) => JSON.parse(line))
    await Bun.sleep(10)
  }
  throw new Error("Terminal report did not arrive")
}

test.skipIf(process.platform === "win32")(
  "client reports its owned Runtime, coalesces pending changes and clears its binding on exit",
  async () => {
    await using directory = await tmpdir()
    const fixture = path.join(directory.path, "report.ts")
    const file = path.join(directory.path, "reports.jsonl")
    await Bun.write(
      fixture,
      `#!${process.execPath}\nimport { appendFileSync } from "node:fs"\nconst context = JSON.parse(await Bun.stdin.text())\nappendFileSync(${JSON.stringify(file)}, JSON.stringify({args:process.argv.slice(2), context}) + "\\n")\n`,
    )
    await chmod(fixture, 0o700)
    const report = TerminalSession.reporter(
      { runtimeID: "runtime-for-this-pane", storage: "owned.db" },
      {
        MTTY_PANE_ID: "pane-this-client",
        MTTY_CLI: fixture,
      },
    )!
    report({ sessionID: "session-first", cwd: directory.path, state: "processing" })
    report({ sessionID: "session-second", state: "awaiting" })
    report()
    const values = await reports(file, 2)
    expect(values).toHaveLength(2)
    expect(values[0].args).toContain("session-first")
    expect(values[0].args).toContain("pane-this-client")
    expect(values[0].args).not.toContain("owned.db")
    expect(values[0].context).toEqual({ kind: "owned", runtimeID: "runtime-for-this-pane", storage: "owned.db" })
    expect(values[1].context).toBeNull()
    expect(values[1].args).not.toContain("session-second")
  },
)

test.skipIf(process.platform === "win32")(
  "explicitly attached clients cannot claim the default owned Runtime",
  async () => {
    expect(TerminalSession.reporter(undefined, {})).toBeUndefined()
    await using directory = await tmpdir()
    const fixture = path.join(directory.path, "report.ts")
    const file = path.join(directory.path, "reports.jsonl")
    await Bun.write(
      fixture,
      `#!${process.execPath}\nimport { appendFileSync } from "node:fs"\nconst context = JSON.parse(await Bun.stdin.text())\nappendFileSync(${JSON.stringify(file)}, JSON.stringify({context}) + "\\n")\n`,
    )
    await chmod(fixture, 0o700)
    TerminalSession.reporter(undefined, { MTTY_PANE_ID: "attached-pane", MTTY_CLI: fixture })!({
      sessionID: "remote-session",
      state: "idle",
    })
    expect((await reports(file, 1))[0].context).toEqual({ kind: "attached" })
  },
)
