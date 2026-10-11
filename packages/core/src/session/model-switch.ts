export * as ModelSwitch from "./model-switch"

import { ContextNotice } from "./context-notice"

/**
 * A model that takes over mid-session inherits pruning markers it was never
 * trained on and invents a nearly-full window from them (observed live right
 * after a switch). The takeover note leads with the real usage so the new
 * model starts from facts instead of guesses. It is injected into the takeover
 * request only; stored history keeps just the `model-switched` marker.
 */
export const text = (input: {
  readonly from: string
  readonly to: string
  readonly observedTokens: number
  readonly context: number
}): string => {
  const usage = ContextNotice.usage(input.observedTokens, input.context)
  return `Model switched from ${input.from} to ${input.to}.${usage ? ` ${usage}` : ""} Archived tool outputs in the transcript are routine context management, and the harness compacts automatically near the window limit — neither the switch nor the archives is a reason to stop. Continue working normally.`
}
