import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import yargs from "yargs"
import { tmpdir } from "../../fixture/fixture"
import {
  TuiThreadCommand,
  resolveThreadDirectory,
  rustEngineDatabase,
  rustTuiBinary,
  selectedTui,
  unsupportedByRustTui,
} from "../../../src/cli/cmd/tui"
import { cliIt } from "../../lib/cli-process"

describe("tui thread", () => {
  test("loads the TUI integration lazily", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()

    expect(source).toContain('await import("../tui/layer")')
    expect(source).toMatch(/await import\(["']@\/plugin\/tui\/runtime["']\)/)
    expect(source).not.toContain('import("./app")')
  })

  async function check(project?: string) {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"

    try {
      await fs.symlink(tmp.path, link, type)
      expect(resolveThreadDirectory(project, link, tmp.path)).toBe(tmp.path)
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  test("uses the real cwd when PWD points at a symlink", async () => {
    await check()
  })

  test("uses the real cwd after resolving a relative project from PWD", async () => {
    await check(".")
  })

  test("resolves a relative mini project from PWD when cwd differs", async () => {
    await using pwd = await tmpdir({ git: true })
    await using cwd = await tmpdir({ git: true })

    expect(resolveThreadDirectory(".", pwd.path, cwd.path)).toBe(pwd.path)
    expect(resolveThreadDirectory(undefined, pwd.path, cwd.path)).toBe(cwd.path)
  })

  test("parses supported --no-replay forms", async () => {
    for (const option of ["--no-replay", "--no-replay=true", "--noReplay"]) {
      const args = await yargs([])
        .command({ ...TuiThreadCommand, handler: () => {} })
        .exitProcess(false)
        .parse(["--mini", option, "--replay-limit", "10"])

      expect(args.replay === false || args.noReplay === true).toBe(true)
      expect(args.replayLimit).toBe(10)
    }
  })

  test("preserves boolean negation for existing options", async () => {
    const args = await yargs([])
      .command({ ...TuiThreadCommand, handler: () => {} })
      .exitProcess(false)
      .parse(["--mdns", "--no-mdns"])

    expect(args.mdns).toBe(false)
  })

  test("starts the Rust TUI by default and honours an explicit selection", () => {
    expect(selectedTui({}, {})).toBe("rust")
    expect(selectedTui({}, { MIAO_TUI: "legacy" })).toBe("legacy")
    expect(selectedTui({ tui: "legacy" }, {})).toBe("legacy")
    expect(selectedTui({ tui: "rust" }, { MIAO_TUI: "legacy" })).toBe("rust")
    expect(selectedTui({ tui: "legacy" }, { MIAO_TUI: "rust" })).toBe("legacy")
  })

  test("ignores a selection it does not recognise", () => {
    expect(selectedTui({}, { MIAO_TUI: "ratatui" })).toBe("rust")
    expect(selectedTui({ tui: "ratatui" }, {})).toBe("rust")
  })

  test("prefers MIAO_TUI_BIN over the installed locations", () => {
    expect(rustTuiBinary({ MIAO_TUI_BIN: "/custom/miao-tui" })).toBe("/custom/miao-tui")
  })

  test("points the Rust TUI at the Location's engine database", async () => {
    await using config = await tmpdir()
    const root = path.join(config.path, "engines")
    // The engine refuses the product database, and the server derives a
    // Location's store from its directory alone, so the launcher must land on
    // that same file or the two never see each other's Sessions.
    const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify({ directory: "/repo" })).digest("hex")

    expect(await rustEngineDatabase(config.path, "/repo", { MIAO_ENGINE_STORAGE: root })).toBe(
      path.join(root, digest + ".db"),
    )
  })

  test("refuses the Rust TUI when native storage is opted out", async () => {
    await using config = await tmpdir()

    expect(await rustEngineDatabase(config.path, "/repo", { MIAO_ENGINE_STORAGE: "" })).toBeUndefined()
  })

  test("refuses options the Rust TUI does not implement", () => {
    // `replay: false` means --no-replay, which the Rust TUI also lacks.
    const unsupported = [
      { mini: true },
      { fork: true },
      { agent: "build" },
      { auto: true },
      { yolo: true },
      { "dangerously-skip-permissions": true },
      { replay: true },
      { replay: false },
      { noReplay: true },
      { replayLimit: 10 },
      { demo: true },
    ]

    for (const args of unsupported) expect(unsupportedByRustTui(args)).toBeDefined()
    expect(unsupportedByRustTui({})).toBeUndefined()
  })

  cliIt.live("rejects mini-only options without --mini", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--replay-limit", "10"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--replay-limit requires --mini")
    }),
  )

  cliIt.live("routes attached sessions to mini mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["attach", "http://127.0.0.1:1", "--mini"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--mini requires a TTY stdout")
    }),
  )

  cliIt.live("rejects network options in mini mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--mini", "--port", "4096"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--port cannot be used with --mini")
    }),
  )
})
