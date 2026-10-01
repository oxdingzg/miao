import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { MarkdownRenderable, SyntaxStyle } from "@opentui/core"

test("finished Markdown coalesces native buffers while preserving transcript prose", async () => {
  const syntax = SyntaxStyle.create()
  const [streaming, setStreaming] = createSignal(true)
  const content = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: 中文 **important** text.`).join("\n\n")
  let markdown!: MarkdownRenderable
  const app = await testRender(
    () => (
      <markdown
        ref={(value) => (markdown = value)}
        syntaxStyle={syntax}
        content={content}
        streaming={streaming()}
        internalBlockMode={streaming() ? "top-level" : "coalesced"}
      />
    ),
    { width: 90, height: 130 },
  )
  try {
    await app.renderOnce()
    const streamingBuffers = markdown.getChildren().length
    expect(streamingBuffers).toBeGreaterThan(50)
    setStreaming(false)
    await app.renderOnce()
    await app.renderOnce()
    expect(markdown.getChildren().length).toBeLessThan(streamingBuffers / 10)
    // Code highlighting/layout completes asynchronously after coalescing.
    for (let i = 0; i < 50 && !app.captureCharFrame().includes("Paragraph 59:"); i++) {
      await Bun.sleep(20)
      await app.renderOnce()
    }
    const screen = app.captureCharFrame()
    expect(screen).toContain("Paragraph 0:")
    expect(screen).toContain("Paragraph 59:")
    expect(markdown.content).toBe(content)
  } finally {
    app.renderer.destroy()
    syntax.destroy()
  }
})
