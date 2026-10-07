export * as ContextNotice from "./context-notice"

/** First ratio at which the notice fires; then once per additional 10% band. */
export const NOTICE_THRESHOLD = 0.7

/** Synthetic-event metadata marker so consumers can recognize these notices. */
export const MARKER = "miao:context-notice"

export type Notice = {
  readonly announce: boolean
  readonly band: number
  readonly percent: number
  readonly observed: number
  readonly context: number
}

/**
 * Models cannot introspect their remaining context; left to guess, they read
 * routine pruning markers as "nearly exhausted" (observed live). Compute the
 * notice from the provider-reported prompt tokens against the model's window:
 * announce on first crossing of the threshold, then once per 10% band. The
 * caller stores `band` per session and resets it when compaction rewrites the
 * history.
 */
export const notice = (input: {
  readonly observedTokens: number
  readonly context: number
  readonly announced: number
}): Notice | undefined => {
  if (input.context <= 0 || input.observedTokens <= 0) return undefined
  const ratio = input.observedTokens / input.context
  if (ratio < NOTICE_THRESHOLD) return undefined
  const band = Math.floor(ratio * 10) / 10
  if (band <= input.announced) return undefined
  return {
    announce: true,
    band,
    percent: Math.round(ratio * 100),
    observed: input.observedTokens,
    context: input.context,
  }
}
