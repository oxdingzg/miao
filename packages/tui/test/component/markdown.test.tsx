/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Renderable, TextRenderable, SyntaxStyle } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import { Markdown } from "../../src/component/markdown"

const table = (rows: number) =>
  "| one | two |\n| --- | --- |\n" + Array.from({ length: rows }, (_, i) => `| cell-${i} | value |`).join("\n")

test("a single dense table keeps all source text without allocating thousands of native cells", async () => {
  const before = Renderable.renderablesByNumber.size
  const source = table(30000)
  const syntax = SyntaxStyle.create()
  const app = await testRender(() => <Markdown content={source} syntaxStyle={syntax} />, { width: 80, height: 25 })
  try {
    await app.renderOnce()
    expect(Renderable.renderablesByNumber.size - before).toBeLessThan(10)
    const fallback = [...Renderable.renderablesByNumber.values()].find(
      (node) => node instanceof TextRenderable && node.plainText.includes("cell-29999"),
    )
    if (!(fallback instanceof TextRenderable)) throw new Error("Complete source text was not retained")
    expect(fallback.plainText).toBe(source)
    expect(app.captureCharFrame()).toContain("one")
  } finally {
    app.renderer.destroy()
    syntax.destroy()
  }
})

test("many modest messages share the native budget, and unmount releases it for the next view", async () => {
  const before = Renderable.renderablesByNumber.size
  const syntax = SyntaxStyle.create()
  const [shown, setShown] = createSignal(true)
  const [content, setContent] = createSignal(table(80))
  const app = await testRender(
    () => (
      <Show when={shown()}>
        <box flexDirection="column">
          <For each={Array.from({ length: 300 }, (_, i) => i)}>
            {() => <Markdown content={content()} syntaxStyle={syntax} />}
          </For>
        </box>
      </Show>
    ),
    { width: 80, height: 25 },
  )
  try {
    for (let i = 0; i < 4; i++) {
      setShown(true)
      setContent(table(80 + i))
      await app.renderOnce()
      expect(Renderable.renderablesByNumber.size - before).toBeLessThan(2000)
      setShown(false)
      await new Promise((resolve) => setTimeout(resolve, 0))
      await app.renderOnce()
      expect(Renderable.renderablesByNumber.size - before).toBeLessThan(5)
    }
  } finally {
    app.renderer.destroy()
    syntax.destroy()
  }
}, 30000)
