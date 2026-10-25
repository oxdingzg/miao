import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@miao/ui/button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import type { SessionMessageInfo } from "@/utils/server"
import { contextTimeline, type UsageStep } from "./session-context-timeline-model"
import { createSessionContextFormatter } from "./session-context-format"

export function SessionContextTimeline(props: {
  sessionID: string
  revision: number
  messages: readonly SessionMessageInfo[]
}) {
  const sdk = useSDK()
  const language = useLanguage()
  const providers = useProviders(() => sdk().directory)
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const [state, setState] = createStore({
    sessionID: "",
    items: [] as UsageStep[],
    next: undefined as string | undefined,
    loading: false,
    pending: true,
    headError: false,
    refresh: 0,
    error: false,
    selected: undefined as string | undefined,
  })
  createEffect(
    on(
      () => [props.sessionID, props.revision, state.refresh] as const,
      ([sessionID]) => {
        const controller = new AbortController()
        onCleanup(() => controller.abort())
        setState({ pending: true, headError: false })
        void sdk()
          .api.sessions.usageHistory({ sessionID, limit: 100 }, { signal: controller.signal })
          .then((value) => {
            if (controller.signal.aborted) return
            const previous = state.sessionID === sessionID ? state.items : []
            const items = [...new Map([...previous, ...value.items].map((item) => [item.id, item])).values()].sort(
              (a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            )
            setState({
              sessionID,
              items,
              pending: false,
              next: state.sessionID === sessionID && state.items.length > value.items.length ? state.next : value.next,
            })
          })
          .catch(() => {
            if (!controller.signal.aborted) setState({ pending: false, headError: true })
          })
      },
    ),
  )
  const segments = createMemo(() =>
    contextTimeline(
      state.sessionID === props.sessionID ? state.items : [],
      props.messages,
      new Map(
        [...providers.all().values()].flatMap((provider) =>
          Object.entries(provider.models).map(
            ([id, model]) => [JSON.stringify([provider.id, id]), model.limit.context] as const,
          ),
        ),
      ),
    ),
  )
  const selected = createMemo(
    () =>
      segments()
        .flatMap((segment) => segment.points)
        .find((point) => point.id === state.selected) ?? segments().at(-1)?.points.at(-1),
  )
  const load = async () => {
    if (state.loading || !state.next) return
    const sessionID = props.sessionID
    setState({ loading: true, error: false })
    await sdk()
      .api.sessions.usageHistory({ sessionID, before: state.next, limit: 100 })
      .then((value) => {
        if (props.sessionID !== sessionID) return
        setState({
          items: [...new Map([...value.items, ...state.items].map((item) => [item.id, item])).values()],
          next: value.next,
        })
      })
      .catch(() => {
        if (props.sessionID === sessionID) setState("error", true)
      })
    if (props.sessionID === sessionID) setState("loading", false)
  }
  const label = (point: ReturnType<typeof contextTimeline>[number]["points"][number]) =>
    language.t("context.timeline.step", {
      model: point.model.id,
      time: formatter().time(point.time),
      input: formatter().number(point.input),
      read: formatter().number(point.tokens.cache.read),
      write: formatter().number(point.tokens.cache.write),
    })
  return (
    <section
      class="flex min-w-0 flex-col gap-3"
      data-component="context-timeline"
      aria-label={language.t("context.timeline.title")}
    >
      <div class="flex items-center justify-between gap-3">
        <div class="text-12-medium text-text-strong">{language.t("context.timeline.title")}</div>
        <Show when={state.next}>
          <Button size="small" variant="ghost" disabled={state.loading} onClick={load}>
            {language.t("common.loadMore")}
          </Button>
        </Show>
      </div>
      <Show when={state.pending && !segments().length}>
        <div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>
      </Show>
      <Show when={state.headError || state.error}>
        <Button
          size="small"
          variant="ghost"
          onClick={() => (state.error ? load() : setState("refresh", (value) => value + 1))}
        >
          {language.t("context.timeline.retry")}
        </Button>
      </Show>
      <Show when={!state.pending && !state.headError && !segments().length}>
        <p class="text-12-regular text-text-weak">{language.t("context.timeline.empty")}</p>
      </Show>
      <Show when={segments().length}>
        <div class="overflow-x-auto pb-1">
          <div class="flex min-w-full gap-4">
            <For each={segments()}>
              {(segment) => (
                <div
                  class="flex flex-1 flex-col gap-2"
                  style={{ "min-width": `${Math.max(92, segment.points.length * 10)}px` }}
                >
                  <div class="flex items-center justify-between gap-2 text-10-regular text-text-weak">
                    <span class="truncate" title={segment.points[0]?.model.id}>
                      {segment.points[0]?.model.id}
                    </span>
                    <span>{formatter().number(segment.axis)}</span>
                  </div>
                  <div class="relative flex h-24 items-end gap-0.5 border-b border-border-weak-base">
                    <Show when={segment.window && segment.window <= segment.axis}>
                      <div
                        class="pointer-events-none absolute inset-x-0 border-t border-dashed border-border-strong-base"
                        style={{ bottom: `${Math.min(100, ((segment.window ?? 0) / segment.axis) * 100)}%` }}
                      />
                    </Show>
                    <For each={segment.points}>
                      {(point) => (
                        <button
                          type="button"
                          title={label(point)}
                          aria-label={label(point)}
                          aria-pressed={selected()?.id === point.id}
                          class="relative flex h-full min-w-1 flex-1 flex-col justify-end rounded-t-sm outline-none focus-visible:ring-2 focus-visible:ring-border-selected-base"
                          onMouseEnter={() => setState("selected", point.id)}
                          onFocus={() => setState("selected", point.id)}
                          onClick={() => setState("selected", point.id)}
                        >
                          <Show when={point.compacted}>
                            <span
                              class="absolute inset-y-0 left-0 border-l-2 border-syntax-warning"
                              title={language.t("context.timeline.compaction")}
                            />
                          </Show>
                          <span
                            class="w-2 max-w-full self-center bg-syntax-warning"
                            style={{ height: `${(Math.max(0, point.tokens.cache.write) / segment.axis) * 100}%` }}
                          />
                          <span
                            class="w-2 max-w-full self-center bg-syntax-success"
                            style={{ height: `${(Math.max(0, point.tokens.cache.read) / segment.axis) * 100}%` }}
                          />
                          <span
                            class="w-2 max-w-full self-center bg-syntax-info"
                            style={{ height: `${(Math.max(0, point.tokens.input) / segment.axis) * 100}%` }}
                          />
                        </button>
                      )}
                    </For>
                  </div>
                  <div class="text-10-regular text-text-weaker">
                    {segment.window
                      ? language.t(
                          segment.source === "request"
                            ? "context.timeline.requestWindow"
                            : "context.timeline.catalogWindow",
                          { value: formatter().number(segment.window) },
                        )
                      : language.t("context.timeline.unknownWindow")}
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-11-regular text-text-weak">
          <span>
            <span class="mr-1 inline-block size-2 bg-syntax-info" />
            {language.t("context.stats.inputTokens")}
          </span>
          <span>
            <span class="mr-1 inline-block size-2 bg-syntax-success" />
            {language.t("context.timeline.cacheRead")}
          </span>
          <span>
            <span class="mr-1 inline-block size-2 bg-syntax-warning" />
            {language.t("context.timeline.cacheWrite")}
          </span>
        </div>
        <Show when={selected()}>
          {(point) => (
            <div class="flex flex-col gap-1 text-11-regular text-text-weak" aria-live="polite">
              <div>{label(point())}</div>
              <div>
                {language.t("context.stats.totalCost")}:{" "}
                {new Intl.NumberFormat(language.intl(), { style: "currency", currency: "USD" }).format(point().cost)}
                <Show when={point().ttftMs !== undefined}>
                  {" "}
                  · {language.t("context.timeline.ttft", { value: formatter().number(point().ttftMs) })}
                </Show>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </section>
  )
}
