/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { TextRenderable, type RGBA } from "@opentui/core"
import { expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { ProviderFailure, ProviderRetryStatus } from "../../../src/routes/session/provider-failure"
import { wait } from "../cmd/tui/sync-fixture"

test("provider failures render API Error copy with the error foreground", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const [{ KVProvider }, { ThemeProvider, useTheme }, { TuiConfigProvider }] = await Promise.all([
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
  ])
  const expected: { read?: () => RGBA } = {}
  function Notice() {
    const theme = useTheme()
    expected.read = () => theme.theme.error
    return (
      <box>
        <ProviderFailure message="429 · Too many requests" />
        <ProviderRetryStatus
          status={{ type: "retry", attempt: 2, next: Date.now() - 100, message: "Too many requests" }}
        />
      </box>
    )
  }
  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <Notice />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 10 },
  )
  try {
    await wait(() => app.renderer.root.findDescendantById("provider-error-message") instanceof TextRenderable)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("API Error: 429 · Too many requests")
    expect(app.captureCharFrame()).toContain("Retrying · attempt #2")
    expect(app.captureCharFrame()).not.toContain("in 0s")
    const label = app.renderer.root.findDescendantById("provider-error-message")
    if (!(label instanceof TextRenderable)) throw new Error("Provider error text was not rendered")
    expect(label.fg.equals(expected.read?.())).toBe(true)
    expect(label.fg.r).toBeGreaterThan(label.fg.g)
  } finally {
    app.renderer.destroy()
  }
})
