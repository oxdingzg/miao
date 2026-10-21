import { type JSX, useRenderer } from "@opentui/solid"
import { createMemo, onCleanup, Show } from "solid-js"
import { createMarkdownBudget, markdownCost } from "../util/markdown-budget"

const budgets = new WeakMap<object, ReturnType<typeof createMarkdownBudget>>()

/** Keep all source text readable when rich Markdown would exhaust native handles. */
export function Markdown(props: JSX.IntrinsicElements["markdown"]) {
  const renderer = useRenderer()
  let budget = budgets.get(renderer)
  if (!budget) {
    budget = createMarkdownBudget()
    budgets.set(renderer, budget)
  }
  const lease = budget.lease()
  const rich = createMemo(() => lease.reserve(markdownCost(props.content ?? "")))
  onCleanup(() => lease.release())
  return (
    <Show
      when={rich()}
      fallback={
        <text fg={props.fg} bg={props.bg} width={props.width} flexGrow={props.flexGrow} flexShrink={props.flexShrink}>
          {props.content}
        </text>
      }
    >
      <markdown {...props} />
    </Show>
  )
}
