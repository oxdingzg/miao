import { expect, test } from "bun:test"
import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, For } from "solid-js"
import { SessionScrollbox } from "../src/routes/session/scrollbox"

async function fixture(rows = 80) {
  let scroll: ScrollBoxRenderable
  const [always, setAlways] = createSignal(false)
  const app = await testRender(
    () => (
      <box width={50} height={12}>
        <SessionScrollbox
          ref={(value) => (scroll = value)}
          height={10}
          width={50}
          alwaysShow={always()}
          thumbColor="#808080"
          trackColor="#202020"
          hiddenColor="#101010"
        >
          <For each={Array.from({ length: rows }, (_, index) => index)}>
            {(index) => <text height={1}>Message {index}</text>}
          </For>
        </SessionScrollbox>
        <text height={2}>Outside the message list</text>
      </box>
    ),
    { width: 50, height: 12 },
  )
  await app.renderOnce()
  return { ...app, scroll: scroll!, setAlways }
}

test("message thumb shows on hover without reflow and hides outside", async () => {
  const app = await fixture()
  try {
    const width = app.scroll.viewport.width
    const thumb = app.scroll.verticalScrollBar.slider
    expect(thumb.foregroundColor.equals(RGBA.fromHex("#101010"))).toBe(true)
    await app.mockMouse.moveTo(3, 2)
    await app.renderOnce()
    expect(thumb.foregroundColor.equals(RGBA.fromHex("#808080"))).toBe(true)
    await app.mockMouse.moveTo(3, 3)
    await app.renderOnce()
    expect(thumb.foregroundColor.equals(RGBA.fromHex("#808080"))).toBe(true)
    expect(app.scroll.viewport.width).toBe(width)
    await app.mockMouse.moveTo(3, 11)
    await app.renderOnce()
    expect(thumb.foregroundColor.equals(RGBA.fromHex("#101010"))).toBe(true)
    app.setAlways(true)
    await app.renderOnce()
    expect(thumb.foregroundColor.equals(RGBA.fromHex("#808080"))).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("dragging the message thumb scrolls history and preserves hover until release", async () => {
  const app = await fixture()
  try {
    const thumb = app.scroll.verticalScrollBar.slider
    const x = thumb.x
    await app.mockMouse.moveTo(x, thumb.y)
    await app.renderOnce()
    await app.mockMouse.pressDown(x, thumb.y)
    await app.mockMouse.emitMouseEvent("drag", x, 3)
    await app.mockMouse.emitMouseEvent("drag", x, 11)
    await app.renderOnce()
    expect(app.scroll.scrollTop).toBeGreaterThan(0)
    expect(thumb.foregroundColor.equals(RGBA.fromHex("#808080"))).toBe(true)
    await app.mockMouse.release(x, 11)
    await app.renderOnce()
    expect(thumb.foregroundColor.equals(RGBA.fromHex("#101010"))).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("a short conversation has no unnecessary scrollbar", async () => {
  const app = await fixture(2)
  try {
    app.setAlways(true)
    await app.mockMouse.moveTo(3, 2)
    await app.renderOnce()
    expect(app.scroll.verticalScrollBar.visible).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})
