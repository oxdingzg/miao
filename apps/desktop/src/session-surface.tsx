import {
  createEngineReader,
  type EngineEvent,
  type EngineSessionState,
  type EngineSessionSummary,
} from "@miao/app"
import { Markdown } from "@miao/session-ui/markdown"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"

/**
 * One local engine's Sessions and the conversation on the selected one, with
 * a WorkBuddy-style welcome screen while the Session has no turns yet.
 *
 * This is deliberately not `AppInterface` yet. The shared renderer speaks the
 * HTTP API, while the shipped binary exposes the engine's own control plane;
 * this surface talks that control plane directly through `createEngineReader`
 * and renders the two event kinds a conversation is made of.
 */

type Turn = { role: "user" | "assistant"; text: string }

const SUGGESTIONS = ["分析一份调查数据", "创作一篇产品文档", "做一份深度研究", "写一份周报", "审查一段代码", "策划一个方案"]

const dayLabel = (updatedAt: number) =>
  updatedAt === 0
    ? "刚刚"
    : new Date(updatedAt).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })

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
  let composer: HTMLTextAreaElement | undefined

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
    await reader.initialize(id, "新的任务").catch(fail)
    const list = await reader.sessions().catch(() => sessions())
    setSessions(list)
    await open(
      list.find((session) => session.id === id) ?? {
        id,
        title: "新的任务",
        updatedAt: 0,
        pinned: false,
        archived: false,
      },
    )
    composer?.focus()
  }

  const submit = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || busy()) return
    if (!selected()) await newSession()
    const sessionID = selected()
    if (!sessionID) return
    setDraft("")
    setBusy(true)
    try {
      await reader.admit(sessionID, trimmed)
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

  const conversation = () => turns(events())
  const welcome = () => selected() !== undefined && conversation().length === 0 && !running(events())

  return (
    <div class="flex h-dvh bg-v2-background-bg-deep text-v2-text-text-base">
      <aside class="flex w-64 shrink-0 flex-col border-r border-v2-border-border-weak">
        <div class="px-4 pb-2 pt-4">
          <div class="text-15-medium">miao</div>
          <div class="text-11-regular text-v2-text-text-weak">local engine</div>
        </div>
        <div class="px-3">
          <button
            type="button"
            class="w-full rounded bg-v2-background-bg-layer-01 px-3 py-2 text-left text-13-medium hover:bg-v2-background-bg-layer-02"
            onClick={() => void newSession()}
          >
            + 新的任务
          </button>
        </div>
        <div class="px-4 pb-1 pt-4 text-11-regular text-v2-text-text-weak">
          任务 ({sessions().length})
        </div>
        <div class="flex-1 overflow-y-auto">
          <For each={sessions()}>
            {(session) => (
              <button
                type="button"
                class="flex w-full items-center justify-between gap-2 px-4 py-2 text-left hover:bg-v2-background-bg-layer-01"
                classList={{ "bg-v2-background-bg-layer-01": session.id === selected() }}
                onClick={() => void open(session)}
              >
                <span class="min-w-0 flex-1 truncate text-12-regular">{session.title}</span>
                <span class="shrink-0 text-11-regular text-v2-text-text-weak">{dayLabel(session.updatedAt)}</span>
              </button>
            )}
          </For>
          <Show when={sessions().length === 0}>
            <p class="px-4 py-2 text-11-regular text-v2-text-text-weak">暂无任务</p>
          </Show>
        </div>
        <div class="border-t border-v2-border-border-weak px-4 py-3 text-11-regular text-v2-text-text-weak">
          由本机 miao 引擎驱动
        </div>
      </aside>
      <main class="flex min-w-0 flex-1 flex-col">
        <Show
          when={!welcome()}
          fallback={
            <div class="flex flex-1 flex-col items-center justify-center px-8 pb-10">
              <h1 class="text-28-medium">miao，我帮你</h1>
              <div class="mt-6 flex w-full max-w-2xl flex-col rounded-2xl border border-v2-border-border-weak bg-v2-background-bg-layer-01 shadow-sm">
                <textarea
                  ref={composer}
                  class="max-h-48 min-h-24 w-full resize-none bg-transparent px-4 pt-3 text-13-regular outline-none"
                  placeholder="今天帮你做些什么？"
                  value={draft()}
                  rows={3}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault()
                      void submit(draft())
                    }
                  }}
                />
                <div class="flex items-center justify-between px-3 pb-3">
                  <span class="text-11-regular text-v2-text-text-weak">Enter 发送 · Shift+Enter 换行</span>
                  <button
                    type="button"
                    class="rounded-full bg-v2-text-text-base px-4 py-1.5 text-12-medium text-v2-background-bg-deep disabled:opacity-40"
                    disabled={!draft().trim() || busy()}
                    onClick={() => void submit(draft())}
                  >
                    {busy() ? "发送中" : "发送"}
                  </button>
                </div>
              </div>
              <div class="mt-5 flex flex-wrap justify-center gap-2">
                <For each={SUGGESTIONS}>
                  {(suggestion) => (
                    <button
                      type="button"
                      class="rounded-full border border-v2-border-border-weak px-3 py-1.5 text-12-regular hover:bg-v2-background-bg-layer-01"
                      onClick={() => void submit(suggestion)}
                    >
                      {suggestion}
                    </button>
                  )}
                </For>
              </div>
              <div class="mt-auto pt-8 text-11-regular text-v2-text-text-weak">内容由 AI 生成，请核对重要信息</div>
            </div>
          }
        >
          <header class="border-b border-v2-border-border-weak px-4 py-2">
            <Show when={state()} fallback={<span class="text-12-regular text-v2-text-text-weak">选择一个任务</span>}>
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
          <div class="flex-1 overflow-y-auto px-6 py-3">
            <For each={conversation()}>
              {(turn) => (
                <Show
                  when={turn.role === "assistant"}
                  fallback={
                    <div class="flex justify-end py-2">
                      <div class="max-w-[80%] rounded-2xl bg-v2-background-bg-layer-01 px-4 py-2 text-13-regular whitespace-pre-wrap">
                        {turn.text}
                      </div>
                    </div>
                  }
                >
                  <div class="py-2 pr-8 text-13-regular">
                    <Markdown text={turn.text} />
                  </div>
                </Show>
              )}
            </For>
            <Show when={running(events())}>
              <div class="py-2 text-12-regular text-v2-text-text-weak">thinking…</div>
            </Show>
          </div>
          <Show when={error()}>
            {(message) => (
              <div class="border-t border-v2-border-border-weak px-4 py-2 text-11-regular text-v2-text-text-critical">
                {message()}
              </div>
            )}
          </Show>
          <div class="flex items-end gap-2 border-t border-v2-border-border-weak px-4 py-3">
            <textarea
              class="max-h-40 min-h-9 flex-1 resize-none rounded bg-v2-background-bg-layer-01 px-3 py-2 text-13-regular outline-none"
              placeholder="继续这个任务…"
              value={draft()}
              rows={2}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  void submit(draft())
                }
              }}
            />
            <button
              type="button"
              class="rounded-full bg-v2-text-text-base px-4 py-2 text-12-medium text-v2-background-bg-deep disabled:opacity-40"
              disabled={!draft().trim() || busy()}
              onClick={() => void submit(draft())}
            >
              {busy() ? "发送中" : "发送"}
            </button>
          </div>
          <div class="px-4 pb-2 text-right text-10-regular text-v2-text-text-weak">内容由 AI 生成，请核对重要信息</div>
        </Show>
      </main>
    </div>
  )
}
