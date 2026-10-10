import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { Global } from "@miao/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

test("terminal reports follow hydrated checklist and execution events", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const reports: { state: string }[] = []
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
  let status: "busy" | "idle" = "idle"
  let background = false
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_title/status") return json({ data: { type: status } })
    if (url.pathname === "/api/session/ses_title/activity")
      return json({
        data: {
          observedAt: Date.now(),
          status: { type: status },
          pendingNotifications: 0,
          schedules: [],
          jobs: background ? [{ id: "ci", status: "running", startedAt: 100 }] : [],
        },
      })
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === "/api/session/ses_title") return json({ data: session })
    if (url.pathname.endsWith("/todo"))
      return json({ data: [{ content: "Finish verification", status: "in_progress", priority: "high" }] })
    if (url.pathname.endsWith("/message"))
      return json({
        data: [
          {
            id: "msg_done",
            type: "assistant",
            agent: "build",
            model: { providerID: "test", id: "test" },
            content: [],
            finish: "stop",
            time: { created: 100, completed: 200 },
          },
        ],
        cursor: {},
      })
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
        onSessionChange: (session) => {
          if (session) reports.push(session)
        },
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
        if (Date.now() - start > timeout) throw new Error(`timed out; reports=${JSON.stringify(reports)}`)
        await Bun.sleep(10)
      }
    }
    await waitFor(() => reports.at(-1)?.state === "incomplete")
    events.emit({
      directory,
      payload: {
        type: "todo.updated",
        properties: {
          sessionID: "ses_title",
          todos: [{ content: "Finish verification", status: "completed", priority: "high" }],
        },
      },
    })
    await waitFor(() => reports.at(-1)?.state === "completed")
    status = "busy"
    events.emit({
      directory,
      payload: {
        type: "session.next.status",
        properties: { timestamp: Date.now(), sessionID: "ses_title", status: { type: "busy", phase: "requesting" } },
      },
    })
    await waitFor(() => reports.at(-1)?.state === "processing")
    status = "idle"
    background = true
    const afterTurn = reports.length
    events.emit({
      directory,
      payload: {
        type: "session.next.status",
        properties: { timestamp: Date.now(), sessionID: "ses_title", status: { type: "idle" } },
      },
    })
    await waitFor(() => reports.at(-1)?.state === "waiting")
    expect(reports.slice(afterTurn).some((report) => report.state === "completed")).toBe(false)
    events.emit({
      directory,
      payload: {
        type: "session.next.failed",
        properties: {
          timestamp: Date.now(),
          sessionID: "ses_title",
          error: { type: "unknown", message: "provider failed" },
        },
      },
    })
    await waitFor(() => reports.at(-1)?.state === "error")

    expect(reports.map((report) => report.state)).toEqual(
      expect.arrayContaining(["unknown", "incomplete", "completed", "processing", "waiting", "error"]),
    )
    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
