import type { Session } from "@miao/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiTranscriptAssistant } from "@miao/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { Currency } from "../../util/currency"
import { cacheEconomy } from "../../util/cache-economy"
import { CachePricing, isOffPeak, isTimeOfDayPriced, priceMultiplier } from "../../util/cache-pricing"
import { cacheTrend } from "../../util/cache-trend"
import { cacheTtl } from "../../util/cache-ttl"
import { Locale } from "../../util/locale"
import { turnSpeed } from "../../util/turn-speed"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

const id = "internal:sidebar-context"

/** Cache freshness reads as a health signal, so it borrows the theme's status colors. */
const TTL_COLOR = { fresh: "success", aging: "warning", stale: "error" } as const
const TREND_ARROW = { up: "↑", down: "↓", flat: "-" } as const

/** Sidebar rows are 42 columns wide, so cache counts stay abbreviated. */
function compact(value: number) {
  if (value < 10000) return value.toLocaleString()
  if (value < 1000000) return `${Math.round(value / 1000)}k`
  return `${(value / 1000000).toFixed(1)}m`
}

/** A subagent's agent name reads better than its generated title, which is the fallback. */
function childLabel(child: Session) {
  const name = Locale.titlecase(child.agent ?? child.title)
  return name.length > 20 ? `${name.slice(0, 19)}…` : name
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)
  const currency = createMemo(() => props.api.kv.get(Currency.KV, Currency.DEFAULT))
  // Session cost is already denominated in the model's native currency when the
  // model declares one, and in USD otherwise; the cache figures are derived
  // from the same price table, so every amount follows that split. A subagent
  // row can run a different model, so it resolves its own currency rather than
  // borrowing the parent's.
  const money = (value: number, model = session()?.model) => {
    const native = Currency.native(props.api.state.provider, model?.providerID, model?.id)
    return native ? Currency.amount(value, native) : Currency.format(value, currency())
  }

  const state = createMemo(() => {
    const last = msg().findLast((item): item is TuiTranscriptAssistant => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
        cacheHit: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const cacheTotal = last.tokens.cache.read + last.tokens.cache.write + last.tokens.input
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
      cacheHit: cacheTotal > 0 ? Math.round((last.tokens.cache.read / cacheTotal) * 100) : null,
    }
  })

  // The turn above reports the current context; this reports what caching has
  // earned over the whole session, which is only visible across turns.
  const offPeakProviders = createMemo(() => props.api.kv.get(CachePricing.KV, CachePricing.DEFAULT))
  const assistants = createMemo(() => msg().filter((item): item is TuiTranscriptAssistant => item.role === "assistant"))
  const economy = createMemo(() =>
    cacheEconomy(
      assistants(),
      props.api.state.provider,
      (message) =>
        priceMultiplier(message.time.created, message.providerID, message.modelID, {
          providers: offPeakProviders(),
        }),
    ),
  )

  // The badge names the rate the saved figure was billed at, so it only shows
  // for a model whose price actually moves with the clock.
  const pricing = createMemo(() => {
    const last = assistants().at(-1)
    if (!last) return
    if (!isTimeOfDayPriced(last.providerID, last.modelID, { providers: offPeakProviders() })) return
    return isOffPeak(last.time.created) ? "off-peak" : "peak"
  })

  // No provider reports an expiry, so the age is counted locally and the row has
  // to tick for it to stay true. A tick is not one signal write: it repaints the
  // whole screen, transcript included, which on a long session idled at 15-25%
  // CPU for hours. So the clock runs only while the cache can still be saved;
  // once stale the row reads "expired" and the clock stops until a new turn
  // touches the cache, which makes the age negative against the frozen clock
  // and therefore fresh, restarting it.
  const [now, setNow] = createSignal(Date.now())
  const ttl = createMemo(() => cacheTtl(assistants(), now()))
  const ticking = createMemo(() => ttl()?.state === "fresh" || ttl()?.state === "aging")
  createEffect(() => {
    if (!ticking()) return
    setNow(Date.now())
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      // The row shows tenths below a minute, seconds below an hour and minutes
      // above it. Tick at that rate instead of waking (and repainting the whole
      // screen) every second for a cache that can stay fresh for hours.
      const elapsed = Date.now() - (ttl()?.startedAt ?? Date.now())
      const step = elapsed < 60_000 ? 1000 : elapsed < 3_600_000 ? 5000 : 60_000
      timer = setTimeout(() => {
        if (cancelled) return
        setNow(Date.now())
        schedule()
      }, step)
    }
    schedule()
    onCleanup(() => {
      cancelled = true
      if (timer) clearTimeout(timer)
    })
  })

  // The hit rate alone says nothing about whether caching is still working, so
  // it carries the direction the recent turns moved in.
  const cached = createMemo(() => {
    const hit = `${state().cacheHit ?? 0}% cached`
    const direction = cacheTrend(assistants())
    return direction ? `${hit} ${TREND_ARROW[direction]}` : hit
  })

  // Throughput is labelled as the whole turn rather than as generation: its span
  // includes the tool calls the turn made, so it reads slower than the model's
  // own output rate. Time to first token answers the other half of the question,
  // so the two share a row rather than competing for the sidebar's width.
  const speed = createMemo(() => {
    const last = assistants().at(-1)
    const rate = last ? turnSpeed(last) : undefined
    return [
      last?.ttft === undefined ? undefined : `ttft ${Locale.duration(last.ttft)}`,
      rate ? `turn ${rate.tps.toFixed(1)} tok/s` : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(" · ")
  })

  // A parent's cost already folds in every descendant step, so the agent rows
  // break down that same spend rather than adding to it.
  const children = createMemo(() => props.api.state.session.children(props.session_id))
  const childCost = createMemo(() => children().reduce((total, child) => total + (child.cost ?? 0), 0))

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      <text fg={theme().textMuted}>{cached()}</text>
      <text fg={theme().textMuted}>
        read {compact(economy().read)} · write {compact(economy().write)}
      </text>
      <text fg={theme().textMuted}>
        {economy().saved < 0 ? `${money(-economy().saved)} cache cost` : `${money(economy().saved)} saved`}
        {pricing() ? ` · ${pricing()}` : ""}
      </text>
      <Show when={ttl()}>
        {(cache) => (
          <text fg={theme()[TTL_COLOR[cache().state]]}>
            {cache().state === "stale"
              ? "cache expired"
              : `cache ${Locale.duration(cache().elapsed)} / ${Locale.duration(cache().ttl)}`}
          </text>
        )}
      </Show>
      <Show when={speed()}>
        <text fg={theme().textMuted}>{speed()}</text>
      </Show>
      <text fg={theme().textMuted}>{money(cost())} spent</text>
      <Show when={children().length > 0}>
        <text fg={theme().text}>
          <b>Agents</b> {children().length}
        </text>
        <For each={children()}>
          {(child) => (
            <text fg={theme().textMuted}>
              {childLabel(child)} {money(child.cost ?? 0, child.model)}
            </text>
          )}
        </For>
        <text fg={theme().textMuted}>
          total {money(childCost())} / {money(cost())}
        </text>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
