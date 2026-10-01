/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import type { TuiKeybind } from "../../../src/config/keybind"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function mountSelector(input: {
  root: string
  keybinds: Partial<TuiKeybind.Keybinds>
  onSelect: (value: number) => void
  width?: number
  height?: number
}) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider, useDialog },
    { DialogSelect },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/ui/dialog-select"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  function Selector() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogSelect
          compact
          title="Select model"
          current={20}
          options={Array.from({ length: 30 }, (_, value) => ({
            value,
            title: `Model ${value}`,
            onSelect() {
              input.onSelect(value)
              dialog.clear()
            },
          }))}
        />
      )),
    )
    return (
      <box>
        <text>Conversation stays visible</text>
        <text position="absolute" top={input.height ? input.height - 3 : 37}>
          Input stays visible
        </text>
      </box>
    )
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({
      keybinds: input.keybinds,
      leader_timeout: 1000,
    })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts
        directory={input.root}
        paths={{
          home: input.root,
          state,
          worktree: input.root,
        }}
      >
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <Selector />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, {
    kittyKeyboard: true,
    width: input.width ?? 100,
    height: input.height ?? 40,
  })
  return {
    app,
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

// The selector centers the current option from a timer, so a fixed number of
// frames races it when the whole suite is running.
async function renderUntil(
  app: Awaited<ReturnType<typeof testRender>>,
  ready: (frame: string) => boolean,
  timeout = 2000,
) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await app.renderOnce()
    if (ready(app.captureCharFrame())) return
    await Bun.sleep(20)
  }
}

test("compact selector preserves the conversation and input, scrolls to the current model, and closes on Escape", async () => {
  await using tmp = await tmpdir()
  const selector = await mountSelector({ root: tmp.path, keybinds: {}, onSelect() {} })
  try {
    await renderUntil(selector.app, (frame) => frame.includes("Model 20"))
    const frame = selector.app.captureCharFrame()
    expect(frame).toContain("Conversation stays visible")
    expect(frame).toContain("Input stays visible")
    expect(frame).toContain("Model 20")
    expect(frame).not.toContain("Model 0 ")
    const lines = frame.split("\n")
    expect(lines.findIndex((line) => line.includes("Select model"))).toBeGreaterThan(15)
    expect(lines.findIndex((line) => line.includes("Select model"))).toBeLessThan(33)
    await selector.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(20)
    await selector.app.renderOnce()
    await selector.app.renderOnce()
    expect(selector.app.captureCharFrame()).not.toContain("Select model")
    expect(selector.app.captureCharFrame()).toContain("Conversation stays visible")
  } finally {
    await selector.cleanup()
  }
})

test("compact selector stays usable in a narrow terminal and selects with Enter", async () => {
  await using tmp = await tmpdir()
  const selected: number[] = []
  const selector = await mountSelector({
    root: tmp.path,
    keybinds: {},
    width: 38,
    height: 22,
    onSelect: (value) => selected.push(value),
  })
  try {
    await renderUntil(selector.app, (frame) => frame.includes("Select model"))
    expect(selector.app.captureCharFrame()).toContain("Select model")
    expect(selector.app.captureCharFrame()).toContain("Input stays visible")
    await selector.app.mockInput.pressKey("RETURN")
    await selector.app.renderOnce()
    expect(selected).toEqual([20])
    expect(selector.app.captureCharFrame()).not.toContain("Select model")
  } finally {
    await selector.cleanup()
  }
})
