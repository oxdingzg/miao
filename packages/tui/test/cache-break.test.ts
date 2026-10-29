import { describe, expect, test } from "bun:test"
import type { SessionMessage, TranscriptAssistantMessage } from "@miao/schema/view-models"
import { cacheBreak } from "../src/util/cache-break"
import { testAssistantMessage } from "./lib/v2-message"

function turn(options: {
  read: number
  input?: number
  write?: number
  model?: { id: string; providerID: string }
  agent?: string
  error?: boolean
}): TranscriptAssistantMessage {
  const message = testAssistantMessage({
    model: options.model,
    agent: options.agent,
    tokens: {
      input: options.input ?? 0,
      output: 0,
      reasoning: 0,
      cache: { read: options.read, write: options.write ?? 0 },
    },
  })
  return options.error ? ({ ...message, error: { type: "unknown", message: "failed" } } as TranscriptAssistantMessage) : message
}

function compaction(reason: "auto" | "manual"): SessionMessage {
  return {
    id: "msg_compaction",
    type: "compaction",
    reason,
    summary: "summary",
    recent: "recent",
    time: { created: 0 },
  } as SessionMessage
}

function modelSwitched(id: string): SessionMessage {
  return {
    id: "msg_switch",
    type: "model-switched",
    model: { id, providerID: "some-provider" },
    time: { created: 0 },
  } as SessionMessage
}

function agentSwitched(agent: string): SessionMessage {
  return {
    id: "msg_agent",
    type: "agent-switched",
    agent,
    time: { created: 0 },
  } as SessionMessage
}

/** A working turn: most billed input was a cache hit. */
const healthy = () => turn({ read: 900, input: 100 })

/** A collapsed turn: the prefix was almost entirely re-sent as uncached input. */
const collapsed = () => turn({ read: 20, input: 900 })

describe("cacheBreak", () => {
  test("names a compaction that precedes the collapse", () => {
    const detail = cacheBreak([healthy(), compaction("auto"), collapsed()])?.detail
    expect(detail).toBe("context compressed (auto)")
  })

  test("names a recorded model switch", () => {
    const result = cacheBreak([healthy(), modelSwitched("next-model"), collapsed()])
    expect(result?.cause).toBe("model")
    expect(result?.detail).toBe("model switched to next-model")
  })

  test("detects a model move between turns without a meta message", () => {
    const result = cacheBreak([healthy(), turn({ read: 20, input: 900, model: { id: "other-model", providerID: "some-provider" } })])
    expect(result?.cause).toBe("model")
    expect(result?.detail).toBe("model switched to other-model")
  })

  test("names a recorded agent switch", () => {
    const result = cacheBreak([healthy(), agentSwitched("review"), collapsed()])
    expect(result?.cause).toBe("agent")
    expect(result?.detail).toBe("agent switched to review")
  })

  test("detects an agent move between turns without a meta message", () => {
    const result = cacheBreak([healthy(), turn({ read: 20, input: 900, agent: "plan" })])
    expect(result?.cause).toBe("agent")
    expect(result?.detail).toBe("agent switched to plan")
  })

  test("reports nothing when the collapse has no recorded cause", () => {
    expect(cacheBreak([healthy(), collapsed()])).toBeUndefined()
  })

  test("stops reporting once the cache rebuilds", () => {
    expect(cacheBreak([healthy(), compaction("manual"), collapsed(), healthy()])).toBeUndefined()
  })

  test("reports nothing while a session is still building its cache", () => {
    expect(cacheBreak([collapsed(), collapsed()])).toBeUndefined()
  })

  test("holds the notice across a sustained collapse without rewriting it", () => {
    const detail = cacheBreak([healthy(), compaction("manual"), collapsed(), collapsed(), collapsed()])?.detail
    expect(detail).toBe("context compressed (manual)")
  })

  test("picks the newest collapse after a rebuild", () => {
    const detail = cacheBreak([
      healthy(),
      compaction("auto"),
      collapsed(),
      healthy(),
      modelSwitched("next-model"),
      collapsed(),
    ])?.detail
    expect(detail).toBe("model switched to next-model")
  })

  test("skips error turns when reading the cache shares", () => {
    const detail = cacheBreak([healthy(), turn({ read: 20, input: 900, error: true }), compaction("auto"), collapsed()])?.detail
    expect(detail).toBe("context compressed (auto)")
  })

  test("ignores turns with no billed input at all", () => {
    expect(cacheBreak([turn({ read: 0 }), compaction("auto"), turn({ read: 0 })])).toBeUndefined()
  })
})
