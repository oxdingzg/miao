import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { EventSource } from "../../src/context/sdk"

export const worktree = "/tmp/opencode"
export const directory = `${worktree}/packages/tui`

export function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
}

export function eventSource(): EventSource {
  return { subscribe: async () => () => {} }
}

export function createEventSource() {
  let fn: ((event: GlobalEvent) => void) | undefined
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const pending: Uint8Array[] = []
  const send = (event: GlobalEvent) => {
    if (!("properties" in event.payload)) return
    const chunk = new TextEncoder().encode(
      `data: ${JSON.stringify({
        ...event.payload,
        location: { directory: event.directory, workspaceID: event.workspace },
        data: event.payload.properties,
      })}\n\n`,
    )
    if (stream) return stream.enqueue(chunk)
    pending.push(chunk)
  }
  return {
    source: {
      subscribe: async (handler: (event: GlobalEvent) => void) => {
        fn = handler
        return () => {
          if (fn === handler) fn = undefined
        }
      },
    } satisfies EventSource,
    emit(event: GlobalEvent) {
      if (!fn) throw new Error("event source not ready")
      fn(event)
      send(event)
    },
    // Writes only the `/api/event` stream, for a TUI attached over HTTP.
    send,

    response() {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
            for (const chunk of pending.splice(0)) controller.enqueue(chunk)
          },
          cancel() {
            stream = undefined
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  }
}

export type FetchHandler = (url: URL, request?: Request) => Response | Promise<Response> | undefined

export function createFetch(override?: FetchHandler, events?: ReturnType<typeof createEventSource>) {
  const session = [] as URL[]
  const fetch = (async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : String(input))
    if (url.pathname === "/api/session") session.push(url)
    const overridden = await override?.(url, input instanceof Request ? input : undefined)
    if (overridden) return overridden
    if (url.pathname === "/api/event" && events) return events.response()

    if (
      [
        "/agent",
        "/command",
        "/experimental/workspace",
        "/experimental/workspace/status",
        "/formatter",
        "/lsp",
      ].includes(url.pathname)
    )
      return json([])
    if (["/config", "/experimental/resource", "/mcp", "/provider/auth", "/session/status"].includes(url.pathname))
      return json({})
    if (url.pathname === "/config/providers") return json({ providers: {}, default: {} })
    if (url.pathname === "/api/capabilities")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: { backgroundSubagents: false },
      })
    if (url.pathname === "/path") return json({ home: "", state: "", config: "", worktree, directory })
    if (url.pathname === "/api/location") return json({ directory, project: { id: "proj_test", directory: worktree } })
    if (url.pathname === "/api/vcs")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: { branch: "main" },
      })
    if (url.pathname === "/api/vcs/status")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: [],
      })
    if (url.pathname === "/api/workspace")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data:
          request?.method === "POST"
            ? {
                id: "wrk_test",
                type: "worktree",
                name: "test",
                branch: null,
                directory,
                extra: null,
                projectID: "proj_test",
                timeUsed: 0,
              }
            : [],
      })
    if (url.pathname === "/api/workspace/status")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: [],
      })
    if (url.pathname === "/api/workspace/adapter")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: [],
      })
    if (url.pathname === "/api/workspace/sync" || url.pathname === "/api/workspace/warp")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: true,
      })
    if (/^\/api\/workspace\/[^/]+$/.test(url.pathname))
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: undefined,
      })
    if (url.pathname === "/api/config")
      return json({ location: { directory, project: { id: "proj_test", directory: worktree } }, data: {} })
    if (url.pathname === "/api/config/providers")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: { providers: [], default: {} },
      })
    if (url.pathname === "/api/config/catalog")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: { all: [], default: {}, connected: [] },
      })
    if (url.pathname === "/api/mcp")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: {},
      })
    if (url.pathname === "/api/mcp/resources")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: {},
      })
    if (/^\/api\/mcp\/[^/]+\/(connect|disconnect)$/.test(url.pathname))
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: true,
      })
    if (
      [
        "/api/agent",
        "/api/model",
        "/api/provider",
        "/api/integration",
        "/api/command",
        "/api/skill",
        "/api/formatter",
        "/api/lsp",
      ].includes(url.pathname)
    )
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: [],
      })
    if (url.pathname === "/project/current") return json({ id: "proj_test" })
    if (url.pathname === "/api/reference")
      return json({ location: { directory, project: { id: "proj_test", directory } }, data: [] })
    if (url.pathname === "/provider") return json({ all: [], default: {}, connected: [] })
    if (url.pathname === "/session") return json([])
    if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
    if (url.pathname === "/api/session/active") return json({ data: {} })
    if (/^\/api\/project\/[^/]+\/directories$/.test(url.pathname))
      return json({ location: { directory, project: { id: "proj_test", directory } }, data: [] })
    if (url.pathname === "/api/project/current")
      return json({
        location: { directory, project: { id: "proj_test", directory } },
        data: { id: "proj_test", directory },
      })
    // V2 hydration pages the projected timeline alongside `session.context` so
    // compacted history stays reachable in the transcript.
    if (/^\/api\/session\/[^/]+\/message$/.test(url.pathname)) return json({ data: [], cursor: {} })
    if (/^\/api\/session\/[^/]+\/context$/.test(url.pathname)) return json({ data: [] })
    if (/^\/api\/session\/[^/]+\/todo$/.test(url.pathname)) return json({ data: [] })
    if (/^\/api\/session\/[^/]+\/diff$/.test(url.pathname)) return json({ data: [] })
    if (/^\/api\/session\/[^/]+\/status$/.test(url.pathname)) return json({ data: { type: "idle" } })
    if (/^\/api\/session\/[^/]+$/.test(url.pathname))
      return json({
        data: {
          id: decodeURIComponent(url.pathname.slice("/api/session/".length)),
          projectID: "proj_test",
          title: "",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
          location: { directory },
          subpath: "",
        },
      })
    if (url.pathname === "/vcs") return json({ branch: "main" })
    throw new Error(`unexpected request: ${url.pathname}`)
  }) as typeof globalThis.fetch
  return { fetch, session }
}
