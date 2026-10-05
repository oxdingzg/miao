/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ANIMATION_INTERVAL, ScannerSpinner } from "../../../src/component/spinner"

test("scanner frames repaint without dirtying layout or replacing render nodes", async () => {
  const color = RGBA.fromInts(255, 100, 100)
  const app = await testRender(() => <ScannerSpinner frames={["ABC", "DEF"]} color={() => color} />, {
    width: 10,
    height: 3,
  })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("ABC")
    const view = app.renderer.root.getChildren()[0]!
    expect(view.width).toBe(3)
    expect(view.height).toBe(1)
    await Bun.sleep(ANIMATION_INTERVAL + 10)
    expect(view["yogaNode"].isDirty()).toBe(false)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("DEF")
    expect(app.renderer.root.getChildren()[0]).toBe(view)
    expect(view.getChildren()).toHaveLength(0)
  } finally {
    app.renderer.destroy()
  }
})
