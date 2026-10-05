/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("waiting UI shows elapsed time and interrupt guidance, then disappears", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [{ SessionWaiting }, { KVProvider }, { ThemeProvider }, { TuiConfigProvider }] = await Promise.all([
    import("../../../src/routes/session/activity"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
  ])
  const [waiting, setWaiting] = createSignal(true)
  const [elapsed, setElapsed] = createSignal(0)
  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <SessionWaiting waiting={waiting()} elapsed={elapsed()} />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 10 },
  )
  try {
    const deadline = Date.now() + 2000
    while (!app.captureCharFrame().includes("Waiting for model response") && Date.now() < deadline) {
      await Bun.sleep(20)
      await app.renderOnce()
    }
    expect(app.captureCharFrame()).toContain("Waiting for model response")
    expect(app.captureCharFrame()).not.toContain("esc interrupt")
    setElapsed(31000)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("31.0s")
    expect(app.captureCharFrame()).toContain("no readable output yet; esc interrupt")
    setWaiting(false)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Waiting for model response")
  } finally {
    app.renderer.destroy()
  }
})

test("turn activity replaces the waiting text on the same status line", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [{ SessionWaiting }, { KVProvider }, { ThemeProvider }, { TuiConfigProvider }] = await Promise.all([
    import("../../../src/routes/session/activity"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
  ])
  const [activity, setActivity] = createSignal<string | undefined>(undefined)
  const [elapsed, setElapsed] = createSignal(0)
  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <SessionWaiting waiting={false} elapsed={elapsed()} activity={activity()} />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 10 },
  )
  try {
    const settled = async (text: string) => {
      const deadline = Date.now() + 2000
      while (!app.captureCharFrame().includes(text) && Date.now() < deadline) {
        await Bun.sleep(20)
        await app.renderOnce()
      }
      return app.captureCharFrame()
    }
    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("")
    setActivity("Thought for 3.0s, ran 43 shell commands")
    const active = await settled("Thought for 3.0s")
    expect(active).toContain("Thought for 3.0s, ran 43 shell commands")
    expect(active).not.toContain("Waiting for model response")
    // The live timer rides along with the activity summary.
    setElapsed(5000)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Thought for 3.0s, ran 43 shell commands · 5.0s")
    setActivity(undefined)
    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("the waiting label names the current drain phase", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [{ SessionWaiting }, { KVProvider }, { ThemeProvider }, { TuiConfigProvider }] = await Promise.all([
    import("../../../src/routes/session/activity"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
  ])
  const [phase, setPhase] = createSignal<"queued" | "preparing" | "requesting" | undefined>("requesting")
  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <SessionWaiting waiting elapsed={0} phase={phase()} />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 10 },
  )
  try {
    const settled = async (text: string) => {
      const deadline = Date.now() + 2000
      while (!app.captureCharFrame().includes(text) && Date.now() < deadline) {
        await Bun.sleep(20)
        await app.renderOnce()
      }
      return app.captureCharFrame()
    }
    expect(await settled("Waiting for model response")).toContain("Waiting for model response")
    setPhase("preparing")
    expect(await settled("Preparing request")).toContain("Preparing request")
    setPhase("queued")
    expect(await settled("Queued")).toContain("Queued")
  } finally {
    app.renderer.destroy()
  }
})
