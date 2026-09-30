/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { Flag } from "@miao/core/flag/flag"

const replyPath = () => (Flag.MIAO_TUI_V2 ? "/api/session/ses_test/question/que_test/reply" : "/question/que_test/reply")
const rejectPath = () => (Flag.MIAO_TUI_V2 ? "/api/session/ses_test/question/que_test/reject" : "/question/que_test/reject")

async function mountQuestion(root: string, status = 204, onSettled?: () => void) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [
    { QuestionPrompt },
    { SDKProvider },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider, Toast },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/routes/session/question"),
    import("../../../src/context/sdk"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])
  const calls: string[] = []
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <SDKProvider
                    url="http://localhost"
                    events={{ subscribe: async () => () => {} }}
                    fetch={Object.assign(
                      async (request: Request | URL | string) => {
                        calls.push(new URL((request as Request).url).pathname)
                        return status === 204
                          ? new Response(null, { status })
                          : Response.json(
                              { name: "QuestionNotFoundError", data: { message: "Question request not found" } },
                              { status },
                            )
                      },
                      { preconnect: fetch.preconnect },
                    )}
                  >
                    <Toast />
                    <QuestionPrompt
                      request={{
                        id: "que_test",
                        sessionID: "ses_test",
                        questions: ["First", "Second"].map((header) => ({
                          header,
                          question: header,
                          options: [{ label: "Yes", description: "Accept" }],
                        })),
                      }}
                      onSettled={onSettled}
                    />
                  </SDKProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 30 })
  await Bun.sleep(100)
  await app.renderOnce()
  return { app, calls }
}

test("question review responds to enter and escape", async () => {
  await using tmp = await tmpdir()
  const { app, calls } = await mountQuestion(tmp.path)
  try {
    await app.renderOnce()
    app.mockInput.pressEnter()
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Review")
    app.mockInput.pressEnter()
    await Bun.sleep(60)
    app.mockInput.pressEscape()
    await Bun.sleep(60)
    expect(calls).toEqual([replyPath(), rejectPath()])
  } finally {
    app.renderer.destroy()
  }
})

test("switching from a custom answer to review keeps enter and escape active", async () => {
  await using tmp = await tmpdir()
  const { app, calls } = await mountQuestion(tmp.path)
  try {
    await app.renderOnce()
    app.mockInput.pressKey("2")
    await app.renderOnce()
    const lines = app.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("Confirm"))
    const x = lines[y].indexOf("Confirm")
    await app.mockMouse.click(x, y)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Review")
    app.mockInput.pressEnter()
    await Bun.sleep(60)
    app.mockInput.pressEscape()
    await Bun.sleep(60)
    expect(calls).toEqual([replyPath(), rejectPath()])
  } finally {
    app.renderer.destroy()
  }
})

test("failed question requests show an error and dismiss the stale prompt", async () => {
  await using tmp = await tmpdir()
  let settled = 0
  const { app, calls } = await mountQuestion(tmp.path, 404, () => settled++)
  try {
    app.mockInput.pressEnter()
    app.mockInput.pressEnter()
    app.mockInput.pressEnter()
    await Bun.sleep(60)
    await app.renderOnce()
    expect(calls).toHaveLength(1)
    expect(app.captureCharFrame()).toContain("Question request not found")
    expect(settled).toBe(1)
    app.mockInput.pressEscape()
    await Bun.sleep(60)
    expect(calls).toHaveLength(2)
  } finally {
    app.renderer.destroy()
  }
})
