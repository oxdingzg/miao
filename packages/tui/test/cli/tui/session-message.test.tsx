/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { parseSessionMessage } from "../../../src/util/session-message"

for (const width of [100, 55]) {
  test(`inter-session content shows its source and readable Markdown at ${width} columns`, async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state")
    await mkdir(state, { recursive: true })
    await Bun.write(path.join(state, "kv.json"), "{}")
    const [{ SessionMessageContent }, { KVProvider }, { ThemeProvider }, { TuiConfigProvider }] = await Promise.all([
      import("../../../src/routes/session/session-message"),
      import("../../../src/context/kv"),
      import("../../../src/context/theme"),
      import("../../../src/config"),
    ])
    const id = "ses_f0eaecb6affeBw57SfwTo74Ohs"
    const body =
      "## 调查结论\n\n- **原因**：刷新延迟\n- 已修复 `sync.tsx`\n\n```ts\nawait refresh()\n```\n\n下一步：运行回归测试。"
    const message = parseSessionMessage(`<message from session="${id}">\n${body}\n</message>`)
    if (!message) throw new Error("Expected session envelope")
    const app = await testRender(
      () => (
        <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
          <TuiConfigProvider config={createTuiResolvedConfig()}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <SessionMessageContent {...message} title="性能排查" conceal={true} />
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </TestTuiContexts>
      ),
      { width, height: 30 },
    )
    try {
      const deadline = Date.now() + 2000
      while (!app.captureCharFrame().includes("运行回归测试") && Date.now() < deadline) {
        await Bun.sleep(20)
        await app.renderOnce()
      }
      const frame = app.captureCharFrame()
      expect(frame).toContain("Session message")
      expect(frame).toContain("性能排查")
      expect(frame).toContain("ses_f0eaecb6…o74Ohs")
      expect(frame).toContain("调查结论")
      expect(frame).toContain("刷新延迟")
      expect(frame).toContain("sync.tsx")
      expect(frame).toContain("await refresh()")
      expect(frame).toContain("运行回归测试")
      expect(frame).not.toContain("<message")
      expect(frame).not.toContain("</message>")
      expect(frame).not.toContain("**原因**")
      expect(frame).not.toContain("```")
    } finally {
      app.renderer.destroy()
    }
  })
}
