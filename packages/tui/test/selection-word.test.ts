import { expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import * as Selection from "../src/util/selection"

async function setup(content: string) {
  const test = await createTestRenderer({ width: 40, height: 5, useThread: false })
  const text = new TextRenderable(test.renderer, { content })
  test.renderer.root.add(text)
  await test.renderOnce()
  return { test, text }
}

test("selectWordAt selects the word under the cursor", async () => {
  const { test, text } = await setup("hello world")
  try {
    expect(Selection.selectWordAt(test.renderer, text, text.x + 2, text.y)).toBe(true)
    expect(test.renderer.getSelection()?.getSelectedText()).toBe("hello")

    expect(Selection.selectWordAt(test.renderer, text, text.x + 8, text.y)).toBe(true)
    expect(test.renderer.getSelection()?.getSelectedText()).toBe("world")
  } finally {
    test.renderer.destroy()
  }
})

test("selectWordAt ignores whitespace and punctuation", async () => {
  const { test, text } = await setup("hello, world")
  try {
    expect(Selection.selectWordAt(test.renderer, text, text.x + 5, text.y)).toBe(false)
    expect(Selection.selectWordAt(test.renderer, text, text.x + 7, text.y)).toBe(true)
    expect(test.renderer.getSelection()?.getSelectedText()).toBe("world")
  } finally {
    test.renderer.destroy()
  }
})
