import { expect, test } from "bun:test"
import { RGBA, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { PromptPlaceholder } from "../src/component/prompt/placeholder"

const hint = 'Ask anything… "Fix broken tests"'

async function fixture() {
  let input: TextareaRenderable
  const [value, setValue] = createSignal("")
  const [text, setText] = createSignal<string | undefined>(hint)
  const [modal, setModal] = createSignal(false)
  const app = await testRender(
    () => (
      <box width="100%" height="100%" justifyContent="flex-end">
        <box paddingLeft={2} paddingRight={2} paddingTop={1} backgroundColor="#343b4a">
          <PromptPlaceholder
            value={value()}
            text={text()}
            color={RGBA.fromHex("#aaaaaa")}
            onMouseDown={() => input.focus()}
          >
            <textarea
              ref={(r) => (input = r)}
              width="100%"
              minHeight={1}
              maxHeight={6}
              onContentChange={() => setValue(input.plainText)}
            />
          </PromptPlaceholder>
          <text height={1}>Build · No provider selected</text>
        </box>
        <Show when={modal()}>
          <box position="absolute" top={1} left={1} width={45} height={3} backgroundColor="#343b4a">
            <text>Connect a provider</text>
          </box>
        </Show>
      </box>
    ),
    { width: 75, height: 20 },
  )
  await app.renderOnce()
  return { ...app, input: input!, setText, setModal }
}

test("empty prompt has one hint across focus, dialog and resize changes", async () => {
  const app = await fixture()
  try {
    expect(app.input.placeholder).toBeNull()
    const check = async () => {
      await app.renderOnce()
      expect(app.captureCharFrame().split(hint).length - 1).toBe(1)
      expect(app.input.height).toBe(1)
    }
    await check()
    app.input.focus()
    await check()
    app.input.blur()
    app.setModal(true)
    await check()
    app.setModal(false)
    await check()
    app.resize(100, 30)
    await check()
    app.resize(60, 15)
    await check()
    await app.mockMouse.pressDown(app.input.x + 2, app.input.y)
    await app.mockMouse.release(app.input.x + 2, app.input.y)
    expect(app.input.focused).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("typing hides the hint, and clearing multiline input restores one row", async () => {
  const app = await fixture()
  try {
    app.input.focus()
    await app.mockInput.typeText("hello")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("hello")
    expect(app.captureCharFrame()).not.toContain("Ask anything")
    app.input.setText("hello\nworld\nthird line")
    await app.renderOnce()
    expect(app.input.height).toBe(3)
    expect(app.captureCharFrame()).not.toContain("Ask anything")
    app.input.clear()
    await app.renderOnce()
    expect(app.captureCharFrame().split(hint).length - 1).toBe(1)
    expect(app.input.height).toBe(1)
    app.setText('Run a command… "git status"')
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain('Run a command… "git status"')
    expect(app.captureCharFrame()).not.toContain("Ask anything")
    app.setText(undefined)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Run a command")
  } finally {
    app.renderer.destroy()
  }
})

test("a narrow prompt clips its hint to a single row", async () => {
  const app = await fixture()
  try {
    app.resize(20, 15)
    await app.renderOnce()
    const rows = app.captureCharFrame().split("\n")
    expect(rows.filter((row) => row.includes("Ask anything")).length).toBe(1)
    expect(rows.some((row) => row.includes("broken tests"))).toBe(false)
    expect(app.input.height).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
