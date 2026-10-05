/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { TuiSlotPlugin } from "@miao/plugin/tui"
import filesPlugin from "../../../src/feature-plugins/sidebar/files"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

test("large modified-file lists stay bounded and every page remains reachable", async () => {
  const [sessionID, setSessionID] = createSignal("large")
  const files = Array.from({ length: 272 }, (_, index) => ({
    file: `file-${String(index).padStart(3, "0")}.ts`,
    additions: 1,
    deletions: 1,
    patch: "",
  }))
  const api = createTuiPluginApi({ state: { session: { diff: (id) => (id === "large" ? files : files.slice(0, 2)) } } })
  let slot: TuiSlotPlugin | undefined
  api.slots = {
    register(plugin: TuiSlotPlugin) {
      slot = plugin
      return "files"
    },
  }
  await filesPlugin.tui(api, undefined, {
    id: "files",
    source: "internal",
    spec: "files",
    target: "files",
    first_time: 0,
    last_time: 0,
    time_changed: 0,
    load_count: 1,
    fingerprint: "test",
    state: "same",
  })
  const app = await testRender(
    () =>
      slot!.slots.sidebar_content!(
        { theme: api.theme },
        {
          get session_id() {
            return sessionID()
          },
        },
      ),
    { width: 38, height: 32 },
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Modified Files (272)")
    expect(app.captureCharFrame()).not.toContain("file-000")
    await app.mockMouse.click(4, 0)
    await app.waitForFrame((frame) => frame.includes("file-000"))
    expect(app.captureCharFrame()).toContain("file-023")
    expect(app.captureCharFrame()).not.toContain("file-024")
    for (let page = 1; page < 12; page++) {
      await app.mockMouse.click(37, 25)
      await app.waitForFrame((frame) => frame.includes(`file-${String(page * 24).padStart(3, "0")}`))
    }
    expect(app.captureCharFrame()).toContain("file-271")
    setSessionID("small")
    await app.waitForFrame((frame) => frame.includes("file-000"))
    expect(app.captureCharFrame()).toContain("file-001")
    expect(app.captureCharFrame()).not.toContain("file-271")
  } finally {
    app.renderer.destroy()
  }
})
