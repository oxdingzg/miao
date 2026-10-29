/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { InputRenderable } from "@opentui/core"
import { onCleanup, onMount } from "solid-js"
import type { SavedPermissionsApi } from "../../src/component/dialog-saved-permissions"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"

const native = {
  id: "psv_native_prule_test",
  projectID: "proj_main",
  action: "read",
  resource: "public/**",
  origin: "native" as const,
  scope: { type: "directory" as const, directory: "/workspace/main/worktree-a" },
}
const location = { directory: "/workspace/main/worktree-a", project: { id: "proj_main", directory: "/workspace/main" } }

test("saved rule review shows directory, project and shared scopes before revocation", async () => {
  await using tmp = await tmpdir()
  const view = await mount(tmp.path, {
    list: async () => [
      native,
      { id: "psv_project", projectID: "proj_main", action: "edit", resource: "src/**" },
      { id: "psv_shared", projectID: "global", action: "bash", resource: "git *" },
    ],
    location: async () => location,
    remove: async () => {
      throw new Error("should not revoke without selection")
    },
  })
  try {
    const frame = await view.until((frame) => frame.includes("All non-Git directories") && frame.includes("Directory"))
    expect(frame).toContain("Project")
    expect(frame).toContain("including its worktrees")
    await view.until(() => view.app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await view.app.mockInput.typeText("public")
    await view.app.renderOnce()
    await view.app.mockInput.pressEnter()
    const review = await view.until((frame) => frame.includes("Review saved permission"))
    expect(review).toContain("/workspace/main/worktree-a")
    expect(review).toContain('Target pattern: "public/**"')
    expect(review).toContain("Keep this rule")
    expect(review).toContain("Revoke this rule")
    await view.app.mockInput.pressEnter()
    await view.until((frame) => frame.includes("Saved permissions") && !frame.includes("Review saved permission"))
  } finally {
    view.app.renderer.destroy()
  }
})

test("failed and pending revocations retain the rule until a server acknowledgement", async () => {
  await using tmp = await tmpdir()
  const pending = Promise.withResolvers<void>()
  const state = { calls: 0, rules: [native], fail: true }
  const view = await mount(tmp.path, {
    list: async () => state.rules,
    location: async () => location,
    remove: async () => {
      state.calls++
      if (state.fail) throw new Error("Server is unavailable")
      await pending.promise
    },
  })
  try {
    await view.until((frame) => frame.includes("public/**"))
    await view.until(() => view.app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await view.app.mockInput.pressEnter()
    await view.until((frame) => frame.includes("Review saved permission"))
    await view.app.mockInput.pressArrow("down")
    await view.app.mockInput.pressEnter()
    const failed = await view.until((frame) => frame.includes("Server is unavailable"))
    expect(failed).toContain("public/**")
    expect(failed).toContain("Revoke this rule")
    expect(state.calls).toBe(1)
    state.fail = false
    await view.app.mockInput.pressEnter()
    await view.until((frame) => frame.includes("Waiting for the server"))
    await view.app.mockInput.pressEnter()
    expect(state.calls).toBe(2)
    state.rules = []
    pending.resolve()
    const done = await view.until((frame) => frame.includes("No saved permissions for this location"))
    expect(done).not.toContain("public/**")
    expect(done).toContain("Saved permission revoked")
  } finally {
    pending.resolve()
    view.app.renderer.destroy()
  }
})

test("long target patterns keep scope and revoke controls visible in a small terminal", async () => {
  await using tmp = await tmpdir()
  const view = await mount(
    tmp.path,
    {
      list: async () => [{ ...native, resource: "public/" + "long-target-".repeat(200) }],
      location: async () => location,
      remove: async () => {},
    },
    { width: 80, height: 24 },
  )
  try {
    await view.until((frame) => frame.includes("long-target"))
    await view.until(() => view.app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await view.app.mockInput.pressEnter()
    const review = await view.until((frame) => frame.includes("Review saved permission"))
    expect(review).toContain("Keep this rule")
    expect(review).toContain("Revoke this rule")
    expect(review).toContain("Directory: /workspace/main/worktree-a")
    if (process.env.MIAO_TUI_TEST_FRAME) await Bun.write(process.env.MIAO_TUI_TEST_FRAME, review)
  } finally {
    view.app.renderer.destroy()
  }
})

test("loading failures retry and unknown scope cannot be revoked", async () => {
  await using tmp = await tmpdir()
  const state = { fail: true, removed: false }
  const view = await mount(tmp.path, {
    list: async () => {
      if (state.fail) throw new Error("Saved rules are unavailable")
      return [{ ...native, scope: undefined }]
    },
    location: async () => location,
    remove: async () => {
      state.removed = true
    },
  })
  try {
    const failed = await view.until((frame) => frame.includes("Saved rules are unavailable"))
    expect(failed).not.toContain("No saved permissions for this location")
    state.fail = false
    await view.app.mockInput.pressKey("r", { ctrl: true })
    await view.until((frame) => frame.includes("public/**"))
    await view.until(() => view.app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await view.app.mockInput.pressEnter()
    const review = await view.until((frame) => frame.includes("Scope unavailable"))
    expect(review).not.toContain("Revoke this rule")
    await view.app.mockInput.pressArrow("down")
    await view.app.mockInput.pressEnter()
    expect(state.removed).toBe(false)
  } finally {
    view.app.renderer.destroy()
  }
})

async function mount(root: string, api: SavedPermissionsApi, size = { width: 110, height: 40 }) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [
    { DialogProvider, useDialog },
    { DialogSavedPermissionsView },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider, Toast },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { ClipboardProvider },
  ] = await Promise.all([
    import("../../src/ui/dialog"),
    import("../../src/component/dialog-saved-permissions"),
    import("../../src/context/kv"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/ui/toast"),
    import("../../src/keymap"),
    import("../../src/context/clipboard"),
  ])
  function Opener() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogSavedPermissionsView api={api} />))
    return <text>Conversation</text>
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ keybinds: {} })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <ClipboardProvider>
                    <DialogProvider>
                      <Opener />
                      <Toast />
                    </DialogProvider>
                  </ClipboardProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { kittyKeyboard: true, ...size })
  return {
    app,
    until: async (ready: (frame: string) => boolean) => {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        await app.renderOnce()
        const frame = app.captureCharFrame()
        if (ready(frame)) return frame
        await Bun.sleep(10)
      }
      throw new Error(`frame never matched:\n${app.captureCharFrame()}`)
    },
  }
}
