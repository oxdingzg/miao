/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { SessionsActivityOutput } from "@miao/client"
import { createSignal } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("idle wakeup countdown renders, advances, pauses on disconnect and switches to job completion", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [{ SessionTimerDisplay }, { KVProvider }, { ThemeProvider }, { TuiConfigProvider }] = await Promise.all([
    import("../../../src/routes/session/timers"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
  ])
  const activity: SessionsActivityOutput = {
    observedAt: 1000,
    status: { type: "idle" },
    pendingNotifications: 0,
    schedules: [{ id: "sched_1", prompt: "Check CI", createdAt: 1000, nextAt: 121000, recurring: false }],
    jobs: [],
  }
  const [snapshot, setSnapshot] = createSignal({ activity, receivedAt: performance.now() })
  const [stale, setStale] = createSignal<number>()
  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <SessionTimerDisplay snapshot={snapshot()} stale={stale()} />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 10 },
  )
  try {
    const deadline = Date.now() + 2000
    while (!app.captureCharFrame().includes("Wakeup in") && Date.now() < deadline) {
      await Bun.sleep(20)
      await app.renderOnce()
    }
    expect(app.captureCharFrame()).toContain("Wakeup in")
    const first = app.captureCharFrame()
    // Time advancement is the behavior under test, not readiness synchronization.
    await Bun.sleep(1100)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toBe(first)
    setStale(performance.now())
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Status unavailable")
    const paused = app.captureCharFrame()
    await Bun.sleep(1100)
    await app.renderOnce()
    expect(app.captureCharFrame()).toBe(paused)
    setStale(undefined)
    setSnapshot({
      receivedAt: performance.now(),
      activity: {
        ...activity,
        schedules: [],
        jobs: [{ id: "job_1", title: "CI watch", startedAt: 0, completedAt: 1000, status: "completed" }],
      },
    })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Finished 1s · CI watch")
    expect(app.captureCharFrame()).not.toContain("Wakeup in")
    expect(app.captureCharFrame()).not.toContain("Status unavailable")
  } finally {
    app.renderer.destroy()
  }
})
