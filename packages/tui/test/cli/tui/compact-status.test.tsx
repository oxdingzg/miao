/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("composer live line keeps progress and clocks on one row", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), '{"animations_enabled":false}')
  const [{ SessionWaiting }, { KVProvider }, { ThemeProvider }, { TuiConfigProvider }] = await Promise.all([
    import("../../../src/routes/session/activity"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
  ])
  for (const width of [110, 38]) {
    const [phase, setPhase] = createSignal<"requesting" | "compacting" | "streaming">("requesting")
    const [activity, setActivity] = createSignal<string>()
    const [receipt, setReceipt] = createSignal<{ delivery: "steer" | "queue"; count: number; since: number | null }>()
    const app = await testRender(
      () => (
        <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
          <TuiConfigProvider config={createTuiResolvedConfig()}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <SessionWaiting
                  compact
                  waiting={!activity()}
                  phase={phase()}
                  activity={activity()}
                  elapsed={22000}
                  totalElapsed={91000}
                  progress={{ stage: 2, stages: 4 }}
                  receipt={receipt()}
                />
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </TestTuiContexts>
      ),
      { width, height: 6 },
    )
    try {
      const deadline = Date.now() + 2000
      while (!app.captureCharFrame().includes("Waiting") && Date.now() < deadline) {
        await Bun.sleep(20)
        await app.renderOnce()
      }
      // The width signal starts optimistic and narrows on the first layout pass.
      await Bun.sleep(50)
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame.split("\n").filter((line) => line.trim())).toHaveLength(1)
      expect(frame).toContain("Waiting")
      expect(frame).toContain("22.0s")
      expect(frame).not.toContain("esc ")
      if (width > 80) expect(frame).toContain("turn 1m 31s")
      if (width < 80) expect(frame).not.toContain("turn")
      setPhase("compacting")
      await app.renderOnce()
      const compacting = app.captureCharFrame()
      expect(compacting).toContain("2/4")
      expect(compacting.split("\n").filter((line) => line.trim())).toHaveLength(1)
      setPhase("streaming")
      setActivity("reading a/very/long/file/path/that/cannot/fit/on/a/narrow/terminal/example.ts")
      await app.renderOnce()
      const tool = app.captureCharFrame()
      expect(tool).toContain("22.0s")
      expect(tool.split("\n").filter((line) => line.trim())).toHaveLength(1)
      setReceipt({ delivery: "steer", count: 1, since: Date.now() - 22000 })
      await app.renderOnce()
      const received = app.captureCharFrame()
      expect(received).toContain("Received")
      expect(received).toContain("22.0s")
      expect(received.split("\n").filter((line) => line.trim())).toHaveLength(1)
      if (width > 80) expect(received).toContain("joins next turn")
      setReceipt({ delivery: "queue", count: 2, since: null })
      await app.renderOnce()
      const queued = app.captureCharFrame()
      expect(queued).toContain("2 pending")
      expect(queued).not.toContain("22.0s")
      expect(queued.split("\n").filter((line) => line.trim())).toHaveLength(1)
      if (width > 80) expect(queued).toContain("starts when idle")
    } finally {
      app.renderer.destroy()
    }
  }
})
