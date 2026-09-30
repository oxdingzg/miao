/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onCleanup, Show } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { Flag } from "@miao/core/flag/flag"

const replyPath = () =>
  Flag.MIAO_TUI_V2 ? "/api/session/ses_test/question/que_test/reply" : "/question/que_test/reply"
const rejectPath = () =>
  Flag.MIAO_TUI_V2 ? "/api/session/ses_test/question/que_test/reject" : "/question/que_test/reject"

type QuestionInput = {
  header: string
  question: string
  options: Array<{ label: string; description: string; preview?: string }>
  multiSelect?: boolean
}

async function mountQuestion(
  root: string,
  status = 204,
  onSettled?: () => void,
  delay = 0,
  advance = false,
  custom?: QuestionInput[],
) {
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
    const [index, setIndex] = createSignal(0)
    const requests = ["test", "next"].map((id) => ({
      id: `que_${id}`,
      sessionID: "ses_test",
      questions:
        custom ??
        ["First", "Second"].map((header) => ({
          header,
          question: id === "test" ? header : `Next ${header}`,
          options: [{ label: "Yes", description: "Accept" }],
        })),
    }))
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
                        if (delay) await Bun.sleep(delay)
                        return status === 204
                          ? new Response(null, { status })
                          : Response.json(
                              {
                                name: status === 404 ? "QuestionNotFoundError" : "ServiceUnavailableError",
                                data: {
                                  message: status === 404 ? "Question request not found" : "Service unavailable",
                                },
                              },
                              { status },
                            )
                      },
                      { preconnect: fetch.preconnect },
                    )}
                  >
                    <Toast />
                    <Show when={requests[index()]} keyed>
                      {(request) => (
                        <QuestionPrompt
                          request={request}
                          onSettled={() => {
                            onSettled?.()
                            if (advance) setIndex((value) => value + 1)
                          }}
                        />
                      )}
                    </Show>
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

for (const action of ["enter", "escape"] as const) {
  test(`question review settles once on ${action}`, async () => {
    await using tmp = await tmpdir()
    let settled = 0
    const { app, calls } = await mountQuestion(tmp.path, 204, () => settled++, 50)
    try {
      app.mockInput.pressEnter()
      app.mockInput.pressEnter()
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Review")
      if (action === "enter") app.mockInput.pressEnter()
      if (action === "escape") app.mockInput.pressEscape()
      app.mockInput.pressEnter()
      app.mockInput.pressEscape()
      await Bun.sleep(100)
      app.mockInput.pressEnter()
      app.mockInput.pressEscape()
      await Bun.sleep(60)
      expect(calls).toEqual([action === "enter" ? replyPath() : rejectPath()])
      expect(settled).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test(`switching from a custom answer to review keeps ${action} active`, async () => {
    await using tmp = await tmpdir()
    const { app, calls } = await mountQuestion(tmp.path)
    try {
      app.mockInput.pressKey("2")
      await app.renderOnce()
      const lines = app.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes("Confirm"))
      const x = lines[y].indexOf("Confirm")
      await app.mockMouse.click(x, y)
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Review")
      if (action === "enter") app.mockInput.pressEnter()
      if (action === "escape") app.mockInput.pressEscape()
      await Bun.sleep(60)
      expect(calls).toEqual([action === "enter" ? replyPath() : rejectPath()])
    } finally {
      app.renderer.destroy()
    }
  })

  test(`missing question on ${action} dismisses the stale prompt only once`, async () => {
    await using tmp = await tmpdir()
    let settled = 0
    const { app, calls } = await mountQuestion(tmp.path, 404, () => settled++)
    try {
      app.mockInput.pressEnter()
      app.mockInput.pressEnter()
      if (action === "enter") app.mockInput.pressEnter()
      if (action === "escape") app.mockInput.pressEscape()
      await Bun.sleep(60)
      await app.renderOnce()
      expect(calls).toHaveLength(1)
      expect(app.captureCharFrame()).toContain("Question request not found")
      expect(settled).toBe(1)
      app.mockInput.pressEscape()
      app.mockInput.pressEnter()
      await Bun.sleep(60)
      expect(calls).toHaveLength(1)
    } finally {
      app.renderer.destroy()
    }
  })
}

test("transient failures keep the question available for retry or dismissal", async () => {
  await using tmp = await tmpdir()
  let settled = 0
  const { app, calls } = await mountQuestion(tmp.path, 503, () => settled++)
  try {
    app.mockInput.pressEnter()
    app.mockInput.pressEnter()
    app.mockInput.pressEnter()
    await Bun.sleep(60)
    expect(calls).toEqual([replyPath()])
    expect(settled).toBe(0)
    app.mockInput.pressEscape()
    await Bun.sleep(60)
    expect(calls).toEqual([replyPath(), rejectPath()])
    expect(settled).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("settling a queued question mounts the next question with fresh answers and key bindings", async () => {
  await using tmp = await tmpdir()
  const { app, calls } = await mountQuestion(tmp.path, 204, undefined, 0, true)
  try {
    app.mockInput.pressEnter()
    app.mockInput.pressEnter()
    app.mockInput.pressEnter()
    await Bun.sleep(60)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Next First")
    expect(app.captureCharFrame()).not.toContain("Review")
    expect(app.captureCharFrame()).not.toContain("✓")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Next Second")
    expect(calls).toHaveLength(1)
    app.mockInput.pressEscape()
    await Bun.sleep(60)
    expect(calls).toEqual([
      replyPath(),
      Flag.MIAO_TUI_V2 ? "/api/session/ses_test/question/que_next/reject" : "/question/que_next/reject",
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("shows the focused option preview beside a single-select question", async () => {
  await using tmp = await tmpdir()
  const { app } = await mountQuestion(tmp.path, 204, undefined, 0, false, [
    {
      header: "Approach",
      question: "Which approach?",
      options: [
        { label: "Fast", description: "Ship sooner", preview: "preview-fast-body" },
        { label: "Safe", description: "Fewer risks", preview: "preview-safe-body" },
      ],
    },
  ])
  try {
    await Bun.sleep(150)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("preview-fast-body")
    expect(app.captureCharFrame()).not.toContain("preview-safe-body")
    await app.mockInput.pressKeys(["ARROW_DOWN"])
    await Bun.sleep(150)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("preview-safe-body")
  } finally {
    app.renderer.destroy()
  }
})

test("multiSelect toggles options instead of submitting", async () => {
  await using tmp = await tmpdir()
  const { app, calls } = await mountQuestion(tmp.path, 204, undefined, 0, false, [
    {
      header: "Features",
      question: "Which features?",
      options: [
        { label: "Alpha", description: "First" },
        { label: "Beta", description: "Second" },
      ],
      multiSelect: true,
    },
  ])
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("select all that apply")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("[✓] Alpha")
    expect(calls).toHaveLength(0)
  } finally {
    app.renderer.destroy()
  }
})
