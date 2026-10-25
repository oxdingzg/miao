import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { createSessionContextFormatter } from "./session-context-format"
import type { SessionContextBreakdownKey, estimateSessionContextHistory } from "./session-context-breakdown"

export function SessionContextComposition(props: {
  points: ReturnType<typeof estimateSessionContextHistory>
  colors: Record<SessionContextBreakdownKey, string>
  label: (key: SessionContextBreakdownKey) => string
}) {
  const language = useLanguage()
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const [state, setState] = createStore({ selected: undefined as string | undefined })
  const axis = createMemo(() => Math.max(1, ...props.points.map((point) => point.total)))
  const selected = createMemo(() => props.points.find((point) => point.id === state.selected) ?? props.points.at(-1))
  const label = (point: (typeof props.points)[number]) =>
    language.t("context.history.point", {
      time: formatter().time(point.time ?? undefined),
      tokens: formatter().number(point.total),
    })
  return (
    <Show when={props.points.length}>
      <section
        class="flex min-w-0 flex-col gap-3"
        data-component="context-composition"
        aria-label={language.t("context.history.title")}
      >
        <div class="flex items-center justify-between gap-3">
          <span class="text-12-medium text-text-strong">{language.t("context.history.title")}</span>
          <span class="text-11-regular text-text-weaker">{formatter().number(axis())}</span>
        </div>
        <div class="flex h-20 items-end gap-0.5 border-b border-border-weak-base">
          <For each={props.points}>
            {(point) => (
              <button
                type="button"
                class="flex h-full min-w-0 flex-1 flex-col justify-end outline-none focus-visible:ring-2 focus-visible:ring-border-selected-base"
                title={label(point)}
                aria-label={label(point)}
                aria-pressed={selected()?.id === point.id}
                onMouseEnter={() => setState("selected", point.id)}
                onFocus={() => setState("selected", point.id)}
                onClick={() => setState("selected", point.id)}
              >
                <For each={point.segments.toReversed()}>
                  {(segment) => (
                    <span
                      class="w-2 max-w-full self-center"
                      style={{
                        height: `${(segment.tokens / axis()) * 100}%`,
                        "background-color": props.colors[segment.key],
                      }}
                    />
                  )}
                </For>
              </button>
            )}
          </For>
        </div>
        <Show when={selected()}>
          {(point) => (
            <div class="flex flex-col gap-1 text-11-regular text-text-weak" aria-live="polite">
              <span>{label(point())}</span>
              <div class="flex flex-wrap gap-x-3 gap-y-1">
                <For each={point().segments}>
                  {(segment) => (
                    <span>
                      <span
                        class="mr-1 inline-block size-2"
                        style={{ "background-color": props.colors[segment.key] }}
                      />
                      {props.label(segment.key)} {formatter().number(segment.tokens)}
                    </span>
                  )}
                </For>
              </div>
            </div>
          )}
        </Show>
        <p class="text-11-regular text-text-weaker">{language.t("context.history.note")}</p>
      </section>
    </Show>
  )
}
