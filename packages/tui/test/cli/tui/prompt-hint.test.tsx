/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("composer hint row reports the mode, background work and the next escape action", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), '{"animations_enabled":false}')
  const [{ SessionPromptHint }, { KVProvider }, { ThemeProvider }, { TuiConfigProvider }] = await Promise.all([
    import("../../../src/component/prompt/hint"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
  ])
  const [mode, setMode] = createSignal<"auto" | "normal">("normal")
  const [jobs, setJobs] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [waiting, setWaiting] = createSignal(0)
  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <SessionPromptHint
                permissionMode={mode()}
                runningJobs={jobs()}
                busy={busy()}
                waitingPrompts={waiting()}
              />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 2 },
  )
  const lines = () => app.captureCharFrame().split("\n").filter((line) => line.trim())
  try {
    // The provider tree mounts a frame behind the first render pass.
    const deadline = Date.now() + 2000
    while (!app.captureCharFrame().includes("auto-approve") && Date.now() < deadline) {
      await Bun.sleep(20)
      await app.renderOnce()
    }
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toContain("auto-approve off")
    expect(lines()[0]).not.toContain("background")
    expect(lines()[0]).not.toContain("esc")

    setMode("auto")
    await app.renderOnce()
    expect(lines()[0]).toContain("auto-approve on")
    expect(lines()).toHaveLength(1)

    setJobs(1)
    await app.renderOnce()
    expect(lines()[0]).toContain("1 background job running")

    setJobs(3)
    await app.renderOnce()
    expect(lines()[0]).toContain("3 background jobs running")

    setBusy(true)
    await app.renderOnce()
    expect(lines()[0]).toContain("esc interrupt")

    setWaiting(2)
    await app.renderOnce()
    expect(lines()[0]).toContain("esc remove prompt")

    setBusy(false)
    setWaiting(0)
    await app.renderOnce()
    expect(lines()[0]).not.toContain("esc")
    expect(lines()).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})
