/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { Logo } from "../../../src/component/logo"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { tmpdir } from "../../fixture/fixture"

function fingerprint(app: Awaited<ReturnType<typeof testRender>>) {
  return app
    .captureSpans()
    .lines.flatMap((line) => line.spans.map((span) => `${span.text}:${span.fg.r},${span.fg.g},${span.fg.b}`))
    .join("|")
}

async function sampleFrames(idle: boolean, samples = 8) {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state }}>
        <TuiConfigProvider config={createTuiResolvedConfig({})}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <Logo idle={idle} />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 24, height: 6 },
  )

  try {
    const frames = new Set<string>()
    for (let i = 0; i < samples; i++) {
      await Bun.sleep(180)
      await app.renderOnce()
      frames.add(fingerprint(app))
    }
    return frames
  } finally {
    app.renderer.destroy()
  }
}

test("idle logo shimmer repaints the cat over time", async () => {
  expect((await sampleFrames(true)).size).toBeGreaterThan(1)
})

test("idle logo stays still when animations are off", async () => {
  expect((await sampleFrames(false)).size).toBe(1)
})
