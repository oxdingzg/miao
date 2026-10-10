import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { Global } from "@miao/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

test("the terminal title is re-asserted when the renderer reports focus", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const session = {
    id: "ses_title",
    projectID: "proj_test",
    title: "查看历史消息无内容问题（v0.1.31）",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory },
    subpath: "",
  }
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === "/api/session/ses_title") return json({ data: session })
    return undefined
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { sessionID: "ses_title" },
        onSessionChange: () => {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    const waitFor = async (predicate: () => boolean, timeout = 3000) => {
      const start = Date.now()
      while (!predicate()) {
        if (Date.now() - start > timeout) throw new Error(`timed out; titles=${JSON.stringify(titles)}`)
        await Bun.sleep(10)
      }
    }
    const expected = "miao | 查看历史消息无内容问题（v0.1.31）"
    await waitFor(() => titles.includes(expected))

    // A terminal that restored its tab lost the title; focus brings it back.
    const before = titles.length
    setup.renderer.emit("focus")
    await waitFor(() => titles.length > before && titles.at(-1) === expected)

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
