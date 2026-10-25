/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("pruning cards expand measured byte facts and reject inconsistent data", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [{ PruningSettlement }, { KVProvider }, { ThemeProvider }, { TuiConfigProvider }] = await Promise.all([
    import("../../../src/routes/session/context-settlement"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
  ])
  const stats = {
    executionID: "00000000-0000-4000-8000-000000000001",
    step: 2,
    contextEpoch: 3,
    reason: "tool_output_budget",
    scope: "tool_result_payloads",
    unit: "utf8_bytes",
    payloads: 2,
    messages: 1,
    beforeBytes: 8087,
    afterBytes: 2000,
    savedBytes: 6087,
  }
  const [value, setValue] = createSignal<unknown>(stats)
  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <PruningSettlement value={value()} />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 110, height: 10 },
  )
  try {
    const deadline = Date.now() + 2000
    while (!app.captureCharFrame().includes("Tool output pruned") && Date.now() < deadline) {
      await Bun.sleep(20)
      await app.renderOnce()
    }
    expect(app.captureCharFrame()).toMatch(/saved 6.?087 bytes/)
    expect(app.captureCharFrame()).not.toContain("UTF-8")
    await app.mockMouse.click(4, 1)
    await app.renderOnce()
    const expanded = app.captureCharFrame()
    expect(expanded).toContain("UTF-8 bytes")
    expect(expanded).toContain("payloads: 2")
    expect(expanded).toContain("messages: 1")
    expect(expanded).toContain("original output remains available through recall")
    expect(expanded).not.toContain("tokens")
    setValue({ ...stats, savedBytes: 999999 })
    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("compaction cards expose their summary without inventing token savings", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [{ CompactionSettlement }, { KVProvider }, { ThemeProvider }, { TuiConfigProvider }] = await Promise.all([
    import("../../../src/routes/session/context-settlement"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
  ])
  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <CompactionSettlement summary="Preserve the verified implementation decisions" through={42} />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 8 },
  )
  try {
    const deadline = Date.now() + 2000
    while (!app.captureCharFrame().includes("Context compacted") && Date.now() < deadline) {
      await Bun.sleep(20)
      await app.renderOnce()
    }
    expect(app.captureCharFrame()).not.toContain("saved")
    await app.mockMouse.click(4, 1)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Preserve the verified implementation decisions")
    expect(frame).toContain("message sequence 42")
    expect(frame).not.toContain("tokens")
    expect(frame).not.toContain("%")
  } finally {
    app.renderer.destroy()
  }
})
