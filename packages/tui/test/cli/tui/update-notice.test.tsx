/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { Event } from "@miao/schema/event-view"
import type { TuiPluginApi } from "@miao/plugin/tui"
import UpdateNotice from "../../../src/feature-plugins/system/update-notice"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

const NOTICE = "✓ Update installed · Restart to update"

async function setup() {
  const handlers = new Map<Event["type"], ((event: Event) => void)[]>()
  const base = createTuiPluginApi({
    event: {
      on: <Type extends Event["type"]>(type: Type, handler: (event: Extract<Event, { type: Type }>) => void) => {
        const list = handlers.get(type) ?? []
        const wrapped = handler as (event: Event) => void
        list.push(wrapped)
        handlers.set(type, list)
        return () => {
          handlers.set(
            type,
            (handlers.get(type) ?? []).filter((item) => item !== wrapped),
          )
        }
      },
    } as TuiPluginApi["event"],
  })
  const slots: Record<string, () => JSX.Element> = {}
  const api = {
    ...base,
    slots: {
      register: (plugin: { slots: Record<string, () => JSX.Element> }) => {
        Object.assign(slots, plugin.slots)
        return "update-notice"
      },
    },
  } as unknown as TuiPluginApi

  await UpdateNotice.tui(api, undefined, {} as never)

  return {
    slots,
    emit(event: Event) {
      for (const handler of handlers.get(event.type) ?? []) handler(event)
    },
  }
}

test("update notice stays hidden until an update is installed", async () => {
  const harness = await setup()
  const app = await testRender(
    () => (
      <box flexDirection="column">
        {harness.slots.home_prompt_right?.()}
        {harness.slots.session_prompt_right?.()}
      </box>
    ),
    { width: 60, height: 4 },
  )
  try {
    expect(app.captureCharFrame()).not.toContain("Update installed")
  } finally {
    app.renderer.destroy()
  }
})

test("update notice renders in both prompt slots after installation.updated", async () => {
  const harness = await setup()
  const app = await testRender(
    () => (
      <box flexDirection="column">
        {harness.slots.home_prompt_right?.()}
        {harness.slots.session_prompt_right?.()}
      </box>
    ),
    { width: 60, height: 4 },
  )
  try {
    expect(app.captureCharFrame()).not.toContain("Update installed")
    harness.emit({ id: "evt_update_1", type: "installation.updated", properties: { version: "9.9.9" } })
    const deadline = Date.now() + 2000
    let frame = app.captureCharFrame()
    while (!frame.includes("Update installed") && Date.now() < deadline) {
      await Bun.sleep(20)
      await app.renderOnce()
      frame = app.captureCharFrame()
    }
    expect(frame).toContain(NOTICE)
    expect(frame.indexOf(NOTICE)).not.toBe(frame.lastIndexOf(NOTICE))
  } finally {
    app.renderer.destroy()
  }
})
