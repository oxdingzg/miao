import type { TranscriptMessage } from "@miao/schema/view-models"

export type CacheBreak = {
  readonly cause: "compaction" | "model" | "agent"
  readonly detail: string
}

/** The stored toggle for showing a recorded cache-break cause in the sidebar. */
export namespace CacheBreakNotice {
  export const KV = "cache_break_notices"
  export const DEFAULT = true
}

/** Read shares at which a turn counts as reusing the cache / as not reusing it. */
const RECOVERED = 0.5
const BROKEN = 0.1

type Turn = {
  readonly model: { readonly providerID: string; readonly id: string } | null
  readonly agent: string | null
  readonly share: number
}

function settled(messages: ReadonlyArray<TranscriptMessage>): Turn[] {
  const turns: Turn[] = []
  for (const message of messages) {
    if (message.type !== "assistant" || message.tokens === undefined || message.error) continue
    const tokens = message.tokens
    const total = tokens.input + tokens.cache.read + tokens.cache.write
    turns.push({
      model: message.model,
      agent: message.agent,
      share: total > 0 ? tokens.cache.read / total : 0,
    })
  }
  return turns
}

function modelSwitched(id: string | undefined): CacheBreak | undefined {
  return id ? { cause: "model", detail: `model switched to ${id}` } : undefined
}

/**
 * The recorded cause of the latest cache collapse, when the transcript holds
 * one. A turn that bills almost no cached reads right after a turn that billed
 * mostly cached reads did not reuse its prefix, and the meta messages between
 * them say why: a compaction replaced the prefix, or a model or agent switch
 * moved the request to a different cache entry. The notice holds until the
 * cache demonstrably rebuilds on a later turn; a collapse with no recorded
 * cause stays unreported rather than guessed, and events that arrive after the
 * collapse never rewrite it.
 */
export function cacheBreak(messages: ReadonlyArray<TranscriptMessage>): CacheBreak | undefined {
  const turns = settled(messages)
  let notice: CacheBreak | undefined
  let pending: CacheBreak | undefined
  let previous: Turn | undefined
  let cursor = 0
  for (const message of messages) {
    if (message.type === "compaction") {
      pending = { cause: "compaction", detail: `context compressed (${message.reason})` }
      continue
    }
    if (message.type === "model-switched") {
      pending = modelSwitched(message.model?.id)
      continue
    }
    if (message.type === "agent-switched") {
      pending = message.agent
        ? { cause: "agent", detail: `agent switched to ${message.agent}` }
        : undefined
      continue
    }
    if (message.type !== "assistant" || message.tokens === undefined || message.error) continue
    const turn = turns[cursor++]
    // A recorded switch without a meta message: the request moved to another
    // model or agent between two settled turns.
    if (previous) {
      const moved = turn.model && previous.model && (turn.model.providerID !== previous.model.providerID || turn.model.id !== previous.model.id)
      if (moved) pending = modelSwitched(turn.model?.id)
      else if (turn.agent && previous.agent && turn.agent !== previous.agent)
        pending = { cause: "agent", detail: `agent switched to ${turn.agent}` }
    }
    if (turn.share >= RECOVERED) {
      // The cache rebuilt, so the notice and every earlier event are history.
      notice = undefined
      pending = undefined
    } else if (previous && previous.share >= RECOVERED && turn.share < BROKEN && pending) {
      notice = pending
    }
    previous = turn
  }
  return notice
}
