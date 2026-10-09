/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { TuiPluginApi, TuiSlotPlugin } from "@miao/plugin/tui"
import type { Session } from "@miao/schema/view-models"
import contextPlugin from "../../../src/feature-plugins/sidebar/context"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { testAssistantMessage } from "../../lib/v2-message"

// Anthropic-style per-million rates, the shape the V1 provider view projects.
const PRICES = { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }
const LIMIT = { context: 1_000_000, output: 8192 }
const MODEL = { providerID: "plan", id: "plan-flash" }

function provider(models: Record<string, unknown>): TuiPluginApi["state"]["provider"] {
  return [{ id: "plan", models }] as unknown as TuiPluginApi["state"]["provider"]
}

async function render(providerView: TuiPluginApi["state"]["provider"]) {
  const session = { cost: 0, model: MODEL } as unknown as Session
  const api = createTuiPluginApi({
    state: {
      provider: providerView,
      session: {
        get: () => session,
        messages: () => [
          testAssistantMessage({
            model: MODEL,
            created: 0,
            ttft: 3800,
            tokens: { input: 4000, output: 500, reasoning: 0, cache: { read: 226_000, write: 0 } },
          }),
        ],
      },
    },
  })
  let slot: TuiSlotPlugin | undefined
  api.slots = {
    register(plugin: TuiSlotPlugin) {
      slot = plugin
      return "context"
    },
  }
  await contextPlugin.tui(api, undefined, {
    id: "context",
    source: "internal",
    spec: "context",
    target: "context",
    first_time: 0,
    last_time: 0,
    time_changed: 0,
    load_count: 1,
    fingerprint: "test",
    state: "same",
  })
  const app = await testRender(() => slot!.slots.sidebar_content!({ theme: api.theme }, { session_id: "s1" }), {
    width: 42,
    height: 24,
  })
  await app.renderOnce()
  return app
}

test("a model no table prices reads unknown instead of a fake zero", async () => {
  const app = await render(provider({ "plan-flash": { limit: LIMIT } }))
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("— saved")
    expect(frame).toContain("— spent")
    expect(frame).not.toContain("$0.00")
    expect(frame).toContain("read 226k")
  } finally {
    app.renderer.destroy()
  }
})

test("a priced model keeps quoting real amounts", async () => {
  const app = await render(provider({ "plan-flash": { cost: PRICES, limit: LIMIT } }))
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("$0.61 saved")
    expect(frame).toContain("$0.00 spent")
    expect(frame).not.toContain("— saved")
  } finally {
    app.renderer.destroy()
  }
})
