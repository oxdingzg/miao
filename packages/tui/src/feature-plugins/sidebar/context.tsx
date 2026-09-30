import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { Currency } from "../../util/currency"
import { cacheEconomy } from "../../util/cache-economy"
import { createMemo } from "solid-js"

const id = "internal:sidebar-context"

/** Sidebar rows are 42 columns wide, so cache counts stay abbreviated. */
function compact(value: number) {
  if (value < 10000) return value.toLocaleString()
  if (value < 1000000) return `${Math.round(value / 1000)}k`
  return `${(value / 1000000).toFixed(1)}m`
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)
  const currency = createMemo(() => props.api.kv.get(Currency.KV, Currency.DEFAULT))
  const nativeCurrency = createMemo(() =>
    Currency.native(props.api.state.provider, session()?.model?.providerID, session()?.model?.id),
  )
  // Session cost is already denominated in the model's native currency when the
  // model declares one, and in USD otherwise; the cache figures are derived
  // from the same price table, so every amount follows that split.
  const money = (value: number) => {
    const native = nativeCurrency()
    return native ? Currency.amount(value, native) : Currency.format(value, currency())
  }

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
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
  const economy = createMemo(() =>
    cacheEconomy(
      msg().filter((item): item is AssistantMessage => item.role === "assistant"),
      props.api.state.provider,
    ),
  )

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      <text fg={theme().textMuted}>{state().cacheHit ?? 0}% cached</text>
      <text fg={theme().textMuted}>
        read {compact(economy().read)} · write {compact(economy().write)}
      </text>
      <text fg={theme().textMuted}>
        {economy().saved < 0 ? `${money(-economy().saved)} cache cost` : `${money(economy().saved)} saved`}
      </text>
      <text fg={theme().textMuted}>{money(cost())} spent</text>
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
