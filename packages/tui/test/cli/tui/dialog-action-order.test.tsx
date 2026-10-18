/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

// Switching the provider from the model dialog replaces one DialogSelect with
// another whose actions carry a function `disabled`. The action list is built
// from the selected option, which is declared further down the component body,
// so that first (eager) computation used to read it in its temporal dead zone:
// the dialog took down the whole TUI with "undefined is not an object
// (evaluating 'actionItems().indexOf')" cascading from the ReferenceError.
async function mount(root: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider, useDialog },
    { DialogSelect },
    { ErrorBoundary },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider, useTuiConfig },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/ui/dialog-select"),
    import("../../../src/component/error-boundary"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  function ModelDialog() {
    const dialog = useDialog()
    return (
      <DialogSelect
        compact
        title="Select model"
        options={[{ title: "Model", value: "model" }]}
        actions={[
          {
            command: "model.dialog.provider",
            title: "Switch provider",
            onTrigger() {
              dialog.replace(() => <ProviderDialog />)
            },
          },
        ]}
      />
    )
  }

  function ProviderDialog() {
    return (
      <DialogSelect
        compact
        title="Switch provider"
        options={[{ title: "OpenAI", value: "openai" }]}
        actions={[
          {
            command: "provider.accounts",
            title: "Accounts",
            disabled: (option) => !option || option.value.startsWith("connect:"),
            onTrigger() {},
          },
        ]}
      />
    )
  }

  // The accounts command is registered app-wide, so the provider dialog finds a
  // keybinding for its disabled action while its own bindings are still being
  // set up — the state that used to crash.
  function GlobalCommands() {
    const tuiConfig = useTuiConfig()
    useBindings(() => ({
      commands: [{ name: "provider.accounts", title: "Manage provider accounts", category: "Provider", run() {} }],
    }))
    useBindings(() => ({
      bindings: tuiConfig.keybinds.gather("app", ["provider.accounts"]),
    }))
    return null
  }

  function Opener() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <ModelDialog />))
    return <text>Conversation stays visible</text>
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    onCleanup(registerOpencodeKeymap(keymap, renderer, resolvedConfig))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <ErrorBoundary fallback={(report) => <text>{`crash ${report.error.message}`}</text>}>
                    <DialogProvider>
                      <GlobalCommands />
                      <Opener />
                    </DialogProvider>
                  </ErrorBoundary>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true, width: 100, height: 40 })
  const until = async (ready: (frame: string) => boolean, timeout = 2000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      if (ready(frame)) return frame
      await Bun.sleep(20)
    }
    throw new Error(`frame never matched:\n${app.captureCharFrame()}`)
  }
  return { app, until, cleanup: () => app.renderer.destroy() }
}

test("keeps the provider dialog alive when its actions read the selected option", async () => {
  await using tmp = await tmpdir()
  const view = await mount(tmp.path)
  try {
    // The model dialog's own action bar is bound before the switch happens.
    await view.until((frame) => frame.includes("Switch provider"))
    view.app.mockInput.pressKey("a", { ctrl: true })
    const frame = await view.until((next) => next.includes("OpenAI"))
    expect(frame).toContain("OpenAI")
    expect(frame).not.toContain("crash")
  } finally {
    view.cleanup()
  }
})
