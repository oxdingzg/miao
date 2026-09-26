import { expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"

test("opentui selects the word under a double-click", async () => {
  const setup = await createTestRenderer({ clock: new ManualClock() })
  try {
    const text = new TextRenderable(setup.renderer, {
      content: "hello world",
      width: 20,
      height: 1,
      selectable: true,
    })
    setup.renderer.root.add(text)
    await setup.renderOnce()

    await setup.mockMouse.doubleClick(text.x + 2, text.y)
    await setup.renderOnce()

    expect(text.getSelectedText()).toBe("hello")
  } finally {
    setup.renderer.destroy()
  }
})
