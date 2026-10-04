import { OpenCode } from "@miao/client"
import type { Event, V2Event } from "@miao/schema/event-view"
import type { OpenCodeEvent } from "@miao/client"
import { createSimpleContext } from "./helper"
import { batch, onCleanup, onMount } from "solid-js"

// The GlobalBus envelope the TUI dispatches: an event with the directory and workspace it belongs to.
// The in-process bus also carries `sync` copies of durable events, which the TUI skips.
export type GlobalEvent = {
  directory: string
  project?: string
  workspace?: string
  payload: Event | { id?: string; type: "sync"; syncEvent: unknown }
}

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined

    const headers = new Headers(props.headers)
    if (props.directory) headers.set("x-opencode-directory", encodeURIComponent(props.directory))
    const api = OpenCode.make({
      baseUrl: props.url,
      headers,
      fetch: Object.assign(
        (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const request = new Request(input, init)
          return (props.fetch ?? fetch)(
            new Request(request, { signal: AbortSignal.any([abort.signal, request.signal]) }),
          )
        },
        { preconnect: (props.fetch ?? fetch).preconnect },
      ),
    })

    const handlers = new Set<(event: GlobalEvent) => void>()
    const emitter = {
      emit(_type: "event", event: GlobalEvent) {
        for (const handler of handlers) handler(event)
      },
      on(_type: "event", handler: (event: GlobalEvent) => void) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          await (async () => {
            for await (const event of api.events.subscribe({ signal: ctrl.signal })) {
              if (ctrl.signal.aborted) break
              attempt = 0
              handleEvent(toGlobalEvent(event))
            }
          })().catch(() => {})

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          attempt += 1
          if (abort.signal.aborted || ctrl.signal.aborted) break

          // Exponential backoff
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      })().catch(() => {})
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        onCleanup(unsub)
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
      handlers.clear()
    })

    return {
      get api() {
        return api
      },
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      url: props.url,
    }
  },
})

// `/api/event` carries `{ id, type, data, location }`. The TUI dispatches the GlobalBus shape
// the in-process worker forwards, so an attached TUI sees events the same way.
function toGlobalEvent(event: OpenCodeEvent): GlobalEvent {
  return {
    directory: event.location?.directory ?? "global",
    workspace: event.location?.workspaceID,
    payload: { id: event.id, type: event.type, properties: event.data } as Event,
  }
}
