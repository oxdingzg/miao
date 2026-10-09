/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { TuiSlotPlugin } from "@miao/plugin/tui"
import messagesPlugin from "../../../src/feature-plugins/sidebar/messages"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

const peer = "ses_peer0000000000000000000"

test("shows inbound and outbound session messages with direction and a summary", async () => {
  const parts = {
    m1: [
      {
        id: "p1",
        sessionID: "s",
        messageID: "m1",
        type: "text",
        text: `<message from session="${peer}">\nplease review the patch\nmore detail\n</message>`,
      },
    ],
    m2: [
      {
        id: "p2",
        sessionID: "s",
        messageID: "m2",
        type: "tool",
        callID: "c",
        tool: "send_message",
        state: {
          status: "completed",
          input: { to: "@helper", message: "on it" },
          output: "",
          title: "",
          metadata: {},
          time: { start: 0, end: 0 },
        },
      },
    ],
  }
  const api = createTuiPluginApi({
    state: {
      session: {
        messages: (() => [{ id: "m1", role: "user" }, { id: "m2", role: "assistant" }]) as never,
      },
      part: ((id: string) => parts[id as keyof typeof parts] ?? []) as never,
    },
  })
  let slot: TuiSlotPlugin | undefined
  api.slots = {
    register(plugin: TuiSlotPlugin) {
      slot = plugin
      return "messages"
    },
  }
  await messagesPlugin.tui(api, undefined, {
    id: "messages",
    source: "internal",
    spec: "messages",
    target: "messages",
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
            return "s"
          },
        },
      ),
    { width: 40, height: 12 },
  )
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Messages")
    expect(frame).toContain("←")
    expect(frame).toContain("please review the patch")
    expect(frame).toContain("→")
    expect(frame).toContain("@helper")
    expect(frame).toContain("on it")
  } finally {
    app.renderer.destroy()
  }
})
