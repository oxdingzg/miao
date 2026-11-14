import {
  createEngineReader,
  type EngineEvent,
  type EngineSessionState,
  type EngineSessionSummary,
} from "@miao/app"
import { Markdown } from "@miao/session-ui/markdown"
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"

/**
 * One local engine's Sessions and the conversation on the selected one, with
 * a WorkBuddy-style welcome screen while the Session has no turns yet.
 *
 * This is deliberately not `AppInterface` yet. The shared renderer speaks the
 * HTTP API, while the shipped binary exposes the engine's own control plane;
 * this surface talks that control plane directly through `createEngineReader`
 * and renders the two event kinds a conversation is made of.
 */

type Turn = { role: "user" | "assistant" | "tool"; text: string }

const SUGGESTIONS = ["分析一份调查数据", "创作一篇产品文档", "做一份深度研究", "写一份周报", "审查一段代码", "策划一个方案"]

const isToday = (updatedAt: number) => {
  if (updatedAt === 0) return true
  const then = new Date(updatedAt)
  const now = new Date()
  return then.toDateString() === now.toDateString()
}

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
    } else if (event.kind === "message.committed" && data.role === "tool") {
      const parts = Array.isArray(data.content) ? data.content : []
      const text = parts
        .map((part) => {
          const result = (part ?? {}) as { type?: string; content?: unknown }
          if (result.type !== "tool_result") return ""
          if (typeof result.content === "string") return result.content
          if (Array.isArray(result.content))
            return result.content
              .filter((inner) => (inner as { type?: string })?.type === "text")
              .map((inner) => String((inner as { text?: string }).text ?? ""))
              .join("")
          return ""
        })
        .filter(Boolean)
        .join("\n")
      if (text) out.push({ role: "tool" as Turn["role"], text })
    }
  }
  return out
}

/** Which model and agent the last turn answered with. */
const identity = (events: EngineEvent[]): { model?: string; agent?: string } => {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const event = sorted[index]
    if (event.kind !== "assistant.identity") continue
    const data = (event.data ?? {}) as {
      agent?: string
      provider?: { model?: string }
    }
    return { model: data.provider?.model, agent: data.agent }
  }
  return {}
}

/** The streamed answer in flight: deltas after the last committed assistant turn. */
const streamingText = (events: EngineEvent[]): string => {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  let cut = 0
  for (const event of sorted)
    if (event.kind === "message.committed" && (event.data as { role?: string })?.role === "assistant")
      cut = event.seq
  return sorted
    .filter((event) => event.seq > cut && event.kind === "provider.delta")
    .map((event) => {
      const data = event.data
      if (typeof data === "string") return data
      const part = (data ?? {}) as Record<string, unknown>
      return String(part.text ?? part.delta ?? "")
    })
    .join("")
}

/** Runs that ended failed, after the last committed answer. */
const failures = (events: EngineEvent[]): string[] => {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  let cut = 0
  for (const event of sorted)
    if (event.kind === "message.committed" && (event.data as { role?: string })?.role === "assistant")
      cut = event.seq
  return sorted
    .filter((event) => event.seq > cut && event.kind === "run.finished")
    .map((event) => String((event.data as { reason?: string })?.reason ?? ""))
    .filter((reason) => reason !== "" && reason !== "completed")
}

/** Tool calls this run started, after the last committed answer. */
const toolRows = (events: EngineEvent[]): Array<{ tool: string; resource: string }> => {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  let cut = 0
  for (const event of sorted)
    if (event.kind === "message.committed" && (event.data as { role?: string })?.role === "assistant")
      cut = event.seq
  return sorted
    .filter((event) => event.seq > cut && event.kind === "tool.started")
    .map((event) => {
      const data = (event.data ?? {}) as Record<string, unknown>
      return { tool: String(data.tool ?? "tool"), resource: String(data.resource ?? "") }
    })
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
  const [attached, setAttached] = createSignal<Array<{ name: string; data: string; mime: string }>>([])
  const [busy, setBusy] = createSignal(false)

  let detach: (() => void) | undefined
  let composer: HTMLTextAreaElement | undefined
  // Questions this window already answered; the effect below must not
  // re-answer the same question.requested on every repaint.
  const answered = new Set<string>()

  // Unattended like the TUI's --auto: a question is answered with the first
  // option of each asked question instead of blocking the conversation.
  createEffect(() => {
    const sessionID = selected()
    if (!sessionID) return
    for (const event of events()) {
      if (event.kind !== "question.requested") continue
      const data = (event.data ?? {}) as {
        question_id?: string
        input_hash?: string
        input?: { questions?: Array<{ options?: Array<{ label?: string }> }> }
      }
      const id = data.question_id
      if (!id || answered.has(id)) continue
      answered.add(id)
      const questions = Array.isArray(data.input?.questions) ? data.input.questions : []
      const answers = questions.map((question) => {
        const option = question?.options?.[0]
        return option?.label ? [String(option.label)] : []
      })
      void reader.answer(sessionID, { question_id: id, input_hash: String(data.input_hash ?? ""), answers }).catch(fail)
    }
  })
  let scroller: HTMLDivElement | undefined

  // Follow the tail while the reader is already near it; a scrollback the
  // operator is reading must not be dragged back down by a streamed delta.
  createEffect(() => {
    events()
    const element = scroller
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 160) {
      queueMicrotask(() => {
        if (scroller) scroller.scrollTop = scroller.scrollHeight
      })
    }
  })

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

  const attach = async (files: FileList) => {
    const next: Array<{ name: string; data: string; mime: string }> = []
    for (const file of Array.from(files)) {
      if (!file.type) continue
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "")
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      next.push({ name: file.name, data, mime: file.type })
    }
    if (next.length > 0) setAttached((current) => [...current, ...next])
  }

  const renameSession = async (session: EngineSessionSummary) => {
    const title = window.prompt("重命名任务", session.title)
    if (!title || title.trim() === session.title) return
    try {
      await reader.rename(session.id, title.trim())
      const list = await reader.sessions()
      setSessions(list)
      if (state()?.title !== undefined && session.id === selected()) {
        const current = list.find((row) => row.id === session.id)
        if (current) setState((previous) => (previous ? { ...previous, title: current.title } : previous))
      }
    } catch (cause) {
      fail(cause)
    }
  }

  const submit = async (text: string) => {
    const trimmed = text.trim()
    if ((!trimmed && attached().length === 0) || busy()) return
    // The two commands a conversation needs on day one, matching the TUI's
    // spelling. Everything else waits for the full command surface.
    if (trimmed === "/new") {
      setDraft("")
      await newSession()
      return
    }
    if (trimmed === "/clear") {
      const sessionID = selected()
      if (!sessionID) return
      setDraft("")
      try {
        await reader.clear(sessionID)
        setEvents([])
      } catch (cause) {
        fail(cause)
      }
      return
    }
    if (!selected()) await newSession()
    const sessionID = selected()
    if (!sessionID) return
    setDraft("")
    setBusy(true)
    try {
      await reader.admit(sessionID, trimmed, attached().map(({ data, mime }) => ({ data, mime })))
      setAttached([])
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
        <div class="px-4 pb-1 pt-4 text-11-medium text-v2-text-text-weak">
          任务 · {sessions().length}
        </div>
        <div class="flex-1 overflow-y-auto pb-2">
          <For each={[{ label: "今天", rows: sessions().filter((row) => isToday(row.updatedAt)) }, { label: "更早", rows: sessions().filter((row) => !isToday(row.updatedAt)) }]}>
            {(group) => (
              <Show when={group.rows.length > 0}>
                <div class="px-4 pb-1 pt-3 text-10-medium tracking-wide text-v2-text-text-weak">{group.label}</div>
                <For each={group.rows}>
                  {(session) => (
                    <button
                      type="button"
                      class="mx-1 flex w-[calc(100%-0.5rem)] items-center justify-between gap-2 rounded px-3 py-1.5 text-left hover:bg-v2-background-bg-layer-01"
                      classList={{ "bg-v2-background-bg-layer-01": session.id === selected() }}
                      onDblClick={() => void renameSession(session)}
                      onClick={() => void open(session)}
                    >
                      <span class="min-w-0 flex-1 truncate text-12-regular">{session.title}</span>
                      <span class="shrink-0 text-10-regular text-v2-text-text-weak">{dayLabel(session.updatedAt)}</span>
                    </button>
                  )}
                </For>
              </Show>
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
              <h1 class="text-32-medium">miao，我帮你</h1>
              <p class="mt-2 text-13-regular text-v2-text-text-weak">一句话交代任务，剩下的交给我</p>
              <div class="mt-8 flex w-full max-w-3xl flex-col rounded-2xl border border-v2-border-border-weak bg-v2-background-bg-layer-01 shadow-sm transition-shadow focus-within:border-v2-text-text-weak focus-within:shadow-md">
                <textarea
                  ref={composer}
                  class="max-h-48 min-h-24 w-full resize-none bg-transparent px-4 pt-3 text-13-regular outline-none"
                  placeholder="今天帮你做些什么？"
                  value={draft()}
                  rows={3}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  onPaste={(event) => {
                    if (event.clipboardData?.files.length) {
                      event.preventDefault()
                      void attach(event.clipboardData.files)
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") event.currentTarget.blur()
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
                      class="rounded-full border border-v2-border-border-weak px-3.5 py-1.5 text-12-regular transition-colors hover:border-v2-text-text-weak hover:bg-v2-background-bg-layer-01"
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
                    {identity(events()).model ? `${identity(events()).model} · ` : ""}
                    {identity(events()).agent ? `${identity(events()).agent} · ` : ""}
                    {current().messageCount} messages
                    {current().pending ? ` · ${current().pending} pending` : ""}
                    {current().approvals ? ` · ${current().approvals} approvals` : ""}
                    {live() ? " · live" : ""}
                  </span>
                </div>
              )}
            </Show>
          </header>
          <div ref={scroller} class="flex-1 overflow-y-auto px-6 py-3">
            <For each={conversation()}>
              {(turn) => (
                <Show
                  when={turn.role === "user"}
                  fallback={
                    <Show
                      when={turn.role === "assistant"}
                      fallback={
                        <div class="py-1 pl-1 text-11-regular text-v2-text-text-weak">
                          <Markdown text={turn.text} />
                        </div>
                      }
                    >
                      <div class="py-2 pr-8 text-13-regular">
                        <Markdown text={turn.text} />
                      </div>
                    </Show>
                  }
                >
                  <div class="flex justify-end py-2">
                    <div class="max-w-[80%] rounded-2xl bg-v2-background-bg-layer-01 px-4 py-2 text-13-regular whitespace-pre-wrap">
                      {turn.text}
                    </div>
                  </div>
                </Show>
              )}
            </For>
            <For each={toolRows(events())}>
              {(row) => (
                <div class="flex items-center gap-2 py-1 pl-1 text-11-regular text-v2-text-text-weak">
                  <span class="rounded border border-v2-border-border-weak px-1.5 py-0.5">tool</span>
                  <span class="truncate">{row.tool}</span>
                  <span class="min-w-0 flex-1 truncate opacity-70">{row.resource}</span>
                </div>
              )}
            </For>
            <Show when={streamingText(events())}>
              {(text) => (
                <div class="py-2 pr-8 text-13-regular">
                  <Markdown text={text()} streaming={true} />
                </div>
              )}
            </Show>
            <For each={failures(events())}>
              {(reason) => (
                <div class="py-1 pl-1 text-11-regular text-v2-text-text-critical">运行失败：{reason}</div>
              )}
            </For>
            <Show when={running(events()) && !streamingText(events())}>
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
                if (event.key === "Escape") {
                  event.preventDefault()
                  const sessionID = selected()
                  if (sessionID && running(events())) void reader.cancel(sessionID).catch(fail)
                  return
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  void submit(draft())
                }
              }}
            />
            <button
              type="button"
              class="rounded-full px-4 py-2 text-12-medium disabled:opacity-40"
              classList={{
                "bg-v2-text-text-base text-v2-background-bg-deep": !running(events()),
                "border border-v2-border-border-weak": running(events()),
              }}
              disabled={!draft().trim() && !running(events())}
              onClick={() => {
                const sessionID = selected()
                if (running(events()) && sessionID) {
                  void reader.cancel(sessionID).catch(fail)
                  return
                }
                void submit(draft())
              }}
            >
              {running(events()) ? "停止" : busy() ? "发送中" : "发送"}
            </button>
          </div>
          <div class="px-4 pb-2 text-right text-10-regular text-v2-text-text-weak">内容由 AI 生成，请核对重要信息</div>
        </Show>
      </main>
    </div>
  )
}
