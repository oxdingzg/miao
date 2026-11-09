import {
  appendEvents,
  createEngineReader,
  type EngineSessionState,
  type EngineSessionSummary,
  type TranscriptRow,
} from "@miao/app"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"

/**
 * Read-only view of the local engine: its Sessions, one Session's header, and
 * that Session's committed events.
 *
 * This is deliberately not `AppInterface`. The shared renderer speaks the HTTP
 * API, while the shipped binary exposes the engine's own control plane, so the
 * window would otherwise stay empty. The surface stays a thin read model over
 * `createEngineReader`; `AppInterface` returns once the engine answers the API
 * the app reads.
 */
export function SessionSurface(props: { url: string; token: string }) {
  const reader = createEngineReader({ url: props.url, token: props.token })
  const [sessions, setSessions] = createSignal<EngineSessionSummary[]>([])
  const [selected, setSelected] = createSignal<string>()
  const [state, setState] = createSignal<EngineSessionState>()
  const [rows, setRows] = createSignal<TranscriptRow[]>([])
  const [live, setLive] = createSignal(false)
  const [error, setError] = createSignal<string>()

  let detach: (() => void) | undefined

  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))

  const open = async (session: EngineSessionSummary) => {
    detach?.()
    detach = undefined
    setSelected(session.id)
    setState(undefined)
    setRows([])
    setLive(false)
    setError(undefined)
    const unsubscribe = await reader
      .subscribe(session.id, (event) => setRows(appendEvents(rows(), [event])))
      .catch((cause: unknown) => {
        fail(cause)
        return undefined
      })
    detach = unsubscribe
    await reader
      .snapshot(session.id)
      .then(setState)
      .catch(fail)
    await reader
      .events(session.id)
      .then((events) => setRows(appendEvents([], events)))
      .catch(fail)
    setLive(true)
  }

  onMount(async () => {
    const list = await reader.sessions().catch((cause: unknown) => {
      fail(cause)
      return [] as EngineSessionSummary[]
    })
    setSessions(list)
    if (list[0]) await open(list[0])
  })

  onCleanup(() => {
    detach?.()
    void reader.close()
  })

  return (
    <div class="flex h-dvh bg-v2-background-bg-deep text-v2-text-text-base">
      <aside class="w-64 shrink-0 border-r border-v2-border-border-weak flex flex-col">
        <header class="px-3 py-2 text-12-medium text-v2-text-text-weak">Sessions</header>
        <div class="flex-1 overflow-y-auto">
          <For each={sessions()}>
            {(session) => (
              <button
                type="button"
                class="block w-full px-3 py-2 text-left hover:bg-v2-background-bg-layer-01"
                classList={{ "bg-v2-background-bg-layer-01": session.id === selected() }}
                onClick={() => void open(session)}
              >
                <div class="truncate text-12-medium">{session.title}</div>
                <div class="truncate text-11-regular text-v2-text-text-weak">{session.id}</div>
              </button>
            )}
          </For>
          <Show when={sessions().length === 0}>
            <p class="px-3 py-2 text-11-regular text-v2-text-text-weak">No sessions in this engine yet.</p>
          </Show>
        </div>
      </aside>
      <main class="flex min-w-0 flex-1 flex-col">
        <header class="border-b border-v2-border-border-weak px-4 py-2">
          <Show when={state()} fallback={<span class="text-12-regular text-v2-text-text-weak">Select a session</span>}>
            {(current) => (
              <div class="flex items-baseline gap-3">
                <h1 class="truncate text-13-medium">{current().title}</h1>
                <span class="text-11-regular text-v2-text-text-weak">
                  cursor {current().cursor} · {current().messageCount} messages
                  {current().pending ? ` · ${current().pending} pending` : ""}
                  {current().approvals ? ` · ${current().approvals} approvals` : ""}
                  {live() ? " · live" : ""}
                </span>
              </div>
            )}
          </Show>
        </header>
        <div class="flex-1 overflow-y-auto px-4 py-2">
          <For each={rows()}>
            {(row) => (
              <div class="flex gap-3 border-b border-v2-border-border-weak py-1 text-12-regular">
                <span class="w-10 shrink-0 text-right text-v2-text-text-weak">{row.seq}</span>
                <span class="w-56 shrink-0 truncate text-v2-text-text-weak">{row.kind}</span>
                <span class="min-w-0 flex-1 truncate">{row.summary}</span>
              </div>
            )}
          </For>
          <Show when={rows().length === 0}>
            <p class="py-2 text-11-regular text-v2-text-text-weak">No committed events yet.</p>
          </Show>
        </div>
        <Show when={error()}>
          {(message) => (
            <footer class="border-t border-v2-border-border-weak px-4 py-2 text-11-regular text-v2-text-text-critical">
              {message()}
            </footer>
          )}
        </Show>
      </main>
    </div>
  )
}
