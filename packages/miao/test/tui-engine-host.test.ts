import { describe, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { parseTuiEngineArgs, rustEngineShim } from "@/engine/tui-engine-host"

describe("parseTuiEngineArgs", () => {
  test("reads the Location the Rust TUI passes to its engine", () => {
    expect(
      parseTuiEngineArgs([
        "serve",
        "--db",
        "/tmp/engine.db",
        "--workspace",
        "/work",
        "--model",
        "openai/gpt-5",
        "--config-dir",
        "/home/.config/miao",
      ]),
    ).toEqual({ database: "/tmp/engine.db", workspace: "/work", model: "openai/gpt-5" })
  })

  test("accepts --flag=value and skips a flag without a value", () => {
    expect(parseTuiEngineArgs(["serve", "--db=/tmp/a.db", "--workspace", "--model=google/gemini"])).toEqual({
      database: "/tmp/a.db",
      workspace: undefined,
      model: "google/gemini",
    })
  })

  test("keeps the TUI's no-model placeholder", () => {
    expect(parseTuiEngineArgs(["--db", "/tmp/a.db", "--workspace", "/w", "--model", "unavailable/model"]).model).toBe(
      "unavailable/model",
    )
  })
})

describe("rustEngineShim", () => {
  test.skipIf(process.platform === "win32")("writes an executable wrapper that calls the hidden shim command", async () => {
    const shim = await rustEngineShim({ MIAO_ENGINE_BIN: "/opt/miao engine/miao-engine" })
    expect(shim).toBeDefined()
    const script = await Bun.file(shim!.program).text()
    expect(script.startsWith("#!/bin/sh\n")).toBe(true)
    expect(script).toContain("__engine-shim \"$@\"")
    expect(shim!.engine).toBe("/opt/miao engine/miao-engine")
    expect((await stat(shim!.program)).mode & 0o111).not.toBe(0)
    await shim!.dispose()
    expect(await Bun.file(shim!.program).exists()).toBe(false)
  })

  test.skipIf(process.platform === "win32")("declines to shim when no engine is configured", async () => {
    expect(await rustEngineShim({ MIAO_ENGINE_BIN: "" })).toBeUndefined()
  })
})
