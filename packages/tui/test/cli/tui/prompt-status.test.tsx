/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createPendingPrompts } from "../../../src/context/pending-prompts"

test("prompt receipt distinguishes sending, failure and durable admission", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [{ PromptStatus }, { KVProvider }, { ThemeProvider }, { TuiConfigProvider }] = await Promise.all([
    import("../../../src/routes/session/prompt-status"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
  ])
  const receipts = createPendingPrompts()
  receipts.add({
    info: {
      id: "msg_test",
      sessionID: "ses_test",
      role: "user",
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      // The receipt's clock is the wait, so keep it old enough that the status
      // line renders a duration on the first frame rather than "0ms".
      time: { created: Date.now() - 65_000 },
    },
    parts: [],
    state: "sending",
    delivery: "steer",
  })
  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <PromptStatus prompt={receipts.data.msg_test} />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 10 },
  )
  try {
    const deadline = Date.now() + 2000
    while (!app.captureCharFrame().includes("SENDING") && Date.now() < deadline) {
      await Bun.sleep(20)
      await app.renderOnce()
    }
    expect(app.captureCharFrame()).toContain("SENDING · awaiting receipt")
    receipts.fail("msg_test", "Network unavailable")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("SEND FAILED")
    expect(app.captureCharFrame()).toContain("Network unavailable")
    receipts.admit("msg_test")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("RECEIVED · waiting for the next safe turn")
    expect(app.captureCharFrame()).toMatch(/RECEIVED · waiting for the next safe turn · \d/)
    expect(app.captureCharFrame()).not.toContain("SEND FAILED")
  } finally {
    app.renderer.destroy()
  }
})
