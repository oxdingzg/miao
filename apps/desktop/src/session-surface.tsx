import {
  createEngineReader,
  type EngineEvent,
  type EngineSessionState,
  type EngineSessionSummary,
} from "@miao/app"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"

/**
 * One local engine's Sessions and the conversation on the selected one: new
 * Session, admitted prompt, and the answer as it commits.
 *
 * This is deliberately not `AppInterface` yet. The shared renderer speaks the
 * HTTP API, while the shipped binary exposes the engine's own control plane;
 * this surface talks that control plane directly through `createEngineReader`
 * and renders the two event kinds a conversation is made of.
 */

type Turn = { role: "user" | "assistant"; text: string }

/** The conversation a viewer reads, derived from the raw event stream. */
const turns = (events: EngineEvent[]): Turn[] => {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const out: Turn[] = []
  for (const event of sorted) {
    const data = (event.data ?? {}) as Record<string, unknown>
    if (event.kind === "input.promoted" && typeof data.prompt === "string") {
      out.push({ role: "user", text: data.prompt })
    } else if (event.kind === "message.committed" && data.role === "assistant") {
      const parts = Array.isArray(data.content) ? data.content : []
      const text = parts
        .filter((part) => (part as { type?: string })?.type === "text")
        .map((part) => String((part as { text?: string }).text ?? ""))
        .join("")
      if (text) out.push({ role: "assistant", text })
    }
  }
  return out
}

/** A run is open when the stream's last lifecycle kind started one. */
const running = (events: EngineEvent[]): boolean => {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const kind = sorted[index].kind
    if (kind === "run.started") return true
    if (kind === "run.finished" || kind === "stop") return false
  }
  return false
}

export function SessionSurface(props: { url: string; token: string }) {
  const reader = createEngineReader({ url: props.url, token: props.token })
  const [sessions, setSessions] = createSignal<EngineSessionSummary[]>([])
  const [selected, setSelected] = createSignal<string>()
  const [state, setState] = createSignal<EngineSessionState>()
  const [events, setEvents] = createSignal<EngineEvent[]>([])
  const [live, setLive] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  let detach: (() => void) | undefined

  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))

  const open = async (session: EngineSessionSummary) => {
    detach?.()
    detach = undefined
    setSelected(session.id)
    setState(undefined)
    setEvents([])
    setLive(false)
    setError(undefined)
    const unsubscribe = await reader
      .subscribe(session.id, (event) =>
        setEvents((current) =>
          current.some((seen) => seen.seq === event.seq) ? current : [...current, event],
        ),
      )
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
      .then((paged) => setEvents((current) => [...current, ...paged]))
      .catch(fail)
    setLive(true)
  }

  const newSession = async () => {
    const id = `ses_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`
    await reader.initialize(id, "Desktop session").catch(fail)
    const list = await reader.sessions().catch(() => sessions())
    setSessions(list)
    await open(
      list.find((session) => session.id === id) ?? {
        id,
        title: "Desktop session",
        updatedAt: 0,
        pinned: false,
        archived: false,
      },
    )
  }

  const send = async () => {
    const sessionID = selected()
    const text = draft().trim()
    if (!sessionID || !text || busy()) return
    setDraft("")
    setBusy(true)
    try {
      await reader.admit(sessionID, text)
    } catch (cause) {
      fail(cause)
    } finally {
      setBusy(false)
    }
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
        <header class="flex items-center justify-between px-3 py-2">
          <span class="text-12-medium text-v2-text-text-weak">Sessions</span>
          <button
            type="button"
            class="rounded bg-v2-background-bg-layer-01 px-2 py-0.5 text-11-regular hover:bg-v2-background-bg-layer-02"
            onClick={() => void newSession()}
          >
            New
          </button>
        </header>
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
                  {current().messageCount} messages
                  {current().pending ? ` · ${current().pending} pending` : ""}
                  {current().approvals ? ` · ${current().approvals} approvals` : ""}
                  {live() ? " · live" : ""}
                </span>
              </div>
            )}
          </Show>
        </header>
        <div class="flex-1 overflow-y-auto px-4 py-2">
          <For each={turns(events())}>
            {(turn) => (
              <Show
                when={turn.role === "assistant"}
                fallback={
                  <div class="flex justify-end py-1.5">
                    <div class="max-w-[80%] rounded bg-v2-background-bg-layer-01 px-3 py-1.5 text-12-regular whitespace-pre-wrap">
                      {turn.text}
                    </div>
                  </div>
                }
              >
                <div class="py-1.5 pr-8 text-12-regular whitespace-pre-wrap">{turn.text}</div>
              </Show>
            )}
          </For>
          <Show when={running(events())}>
            <div class="py-1.5 text-12-regular text-v2-text-text-weak">thinking…</div>
          </Show>
          <Show when={turns(events()).length === 0 && !running(events())}>
            <p class="py-2 text-11-regular text-v2-text-text-weak">Ask anything.</p>
          </Show>
        </div>
        <Show when={error()}>
          {(message) => (
            <footer class="border-t border-v2-border-border-weak px-4 py-2 text-11-regular text-v2-text-text-critical">
              {message()}
            </footer>
          )}
        </Show>
        <footer class="flex items-end gap-2 border-t border-v2-border-border-weak px-3 py-2">
          <textarea
            class="max-h-40 min-h-9 flex-1 resize-none rounded bg-v2-background-bg-layer-01 px-2 py-1.5 text-12-regular outline-none"
            placeholder={selected() ? "Ask anything" : "Create a session first"}
            disabled={!selected()}
            value={draft()}
            rows={2}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <button
            type="button"
            class="rounded bg-v2-background-bg-layer-01 px-3 py-1.5 text-12-medium disabled:opacity-40"
            disabled={!selected() || !draft().trim() || busy()}
            onClick={() => void send()}
          >
            {busy() ? "Sending" : "Send"}
          </button>
        </footer>
      </main>
    </div>
  )
}
