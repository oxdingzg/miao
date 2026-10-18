import { expect, test } from "bun:test"
import { LLM, LLMEvent, Message, SystemPart, type LLMRequest } from "@miao/llm"
import { OpenAIChat } from "@miao/llm/protocols/openai-chat"
import { DateTime, Effect, Exit, Fiber, Stream } from "effect"
import { SessionMessage } from "@miao/core/session/message"
import { Token } from "@miao/core/util/token"
import { SessionCompaction } from "@miao/core/session/compaction"
import { SessionSchema } from "@miao/core/session/schema"

const model = (id: string, context: number) =>
  OpenAIChat.route.with({ limits: { context, output: 4_096 } }).model({ id })

/** A model whose endpoint declares a smaller input ceiling than its context. */
const capped = (id: string, context: number, input: number) =>
  OpenAIChat.route.with({ limits: { context, input, output: 4_096 } }).model({ id })

const compactionInput = (main: ReturnType<typeof model>, small: ReturnType<typeof model>) =>
  ({
    sessionID: SessionSchema.ID.make("ses_compaction_fallback"),
    entries: [{ seq: 1, message: { type: "user", id: "msg_1", text: "hello world" } }],
    model: main,
    summarizeModel: small,
    request: LLM.request({ model: main, messages: [] }),
  }) as never

const summarizeHarness = (
  attempts: Array<Stream.Stream<never, never>>,
  config: unknown = [{ type: "document", info: { compaction: { summarize_small: true, keep: { tokens: 1 } } } }],
) => {
  const requests: LLMRequest[] = []
  const published: string[] = []
  let index = 0
  const compaction = SessionCompaction.make({
    events: {
      publish: (_schema: unknown, data: { text?: string }) => {
        if (typeof data?.text === "string") published.push(data.text)
        return Effect.succeed(undefined)
      },
    } as never,
    llm: {
      stream: (request: LLMRequest) => {
        requests.push(request)
        return attempts[Math.min(index++, attempts.length - 1)] as never
      },
    },
    config: config as never,
  })
  return { compaction, requests, published }
}

/**
 * The staged strategy is the fallback for a prefix that cannot hold the instruction,
 * so these cases turn the cached-prefix strategy off to pin that path.
 */
const stagedHarness = (attempts: Array<Stream.Stream<never, never>>) =>
  summarizeHarness(attempts, [
    { type: "document", info: { compaction: { summarize_small: true, hot_prefix: false, keep: { tokens: 1 } } } },
  ])

const empty = Stream.empty as Stream.Stream<never, never>
const summary = (text: string) => Stream.make(LLMEvent.textDelta({ id: "c", text })) as Stream.Stream<never, never>

const overflowHarness = () => {
  const requests: LLMRequest[] = []
  const compaction = SessionCompaction.make({
    events: { publish: () => Effect.succeed(undefined) } as never,
    llm: {
      stream: (request: LLMRequest) => {
        requests.push(request)
        return summary("summary") as never
      },
    },
    config: [] as never,
  })
  return { compaction, requests }
}

// Long enough that the summary prompt keeps a head to summarize: `select` holds
// the most recent 8k tokens back as recent context.
const overflowEntries = () => [
  { seq: 1, message: { type: "user", id: "msg_1", text: "x".repeat(40_000) } },
  { seq: 2, message: { type: "user", id: "msg_2", text: "y".repeat(20_000) } },
  { seq: 3, message: { type: "user", id: "msg_3", text: "what is in this screenshot?" } },
]

const inlineImage = (bytes: number) => `data:image/png;base64,${"A".repeat(bytes)}`

test("compaction falls back to the session model when the small model returns no summary", async () => {
  const main = model("main", 100_000)
  const small = model("small", 100_000)
  const { compaction, requests, published } = summarizeHarness([empty, summary("fallback summary")])

  const ok = await Effect.runPromise(compaction.compactAfterOverflow(compactionInput(main, small)))

  expect(ok).toBe(true)
  expect(requests.map((request) => request.model)).toEqual([small, main])
  expect(published).toEqual(["fallback summary"])
})

test("compaction does not persist an empty summary from any model", async () => {
  const main = model("main", 100_000)
  const small = model("small", 100_000)
  const { compaction, requests, published } = stagedHarness([empty, empty])

  const ok = await Effect.runPromise(compaction.compactAfterOverflow(compactionInput(main, small)))

  expect(ok).toBe(false)
  expect(requests).toHaveLength(2)
  expect(published).toEqual([])
})

test("compaction prefers the small model when the prompt fits its context", () => {
  const main = model("main", 100_000)
  const small = model("small", 100_000)

  expect(SessionCompaction.pickSummarizeModel({ model: main, summarizeModel: small }, 10, 4_096)).toBe(small)
})

test("compaction falls back to the session model when the prompt exceeds the small context", () => {
  const main = model("main", 100_000)
  const small = model("small", 1_000)

  expect(SessionCompaction.pickSummarizeModel({ model: main, summarizeModel: small }, 10_000, 4_096)).toBe(main)
})

test("compaction falls back to the session model without a small model", () => {
  const main = model("main", 100_000)

  expect(SessionCompaction.pickSummarizeModel({ model: main }, 10, 4_096)).toBe(main)
})

test("hot-prefix prompt summarizes the conversation already in context", () => {
  const prompt = SessionCompaction.buildHotPrompt()

  expect(prompt).toContain("Summarize the conversation above")
  expect(prompt).not.toContain("<conversation>")
  expect(prompt).toContain("## Work State\n### Completed")
})

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
})

test("compaction charges inline media per attachment instead of per base64 character", async () => {
  const main = model("main", 60_000)
  const { compaction, requests } = overflowHarness()
  const input = {
    sessionID: SessionSchema.ID.make("ses_compaction_media"),
    entries: overflowEntries(),
    model: main,
    request: LLM.request({
      model: main,
      messages: [
        Message.user([
          { type: "text", text: "what is in this screenshot?" },
          { type: "media", mediaType: "image/png", data: inlineImage(400_000), filename: "shot.png" },
        ]),
      ],
    }),
  } as never

  // 400k base64 characters is one image, not 100k tokens.
  expect(await Effect.runPromise(compaction.compactIfNeeded(input))).toBe(false)
  expect(requests).toHaveLength(0)
})

test("compaction charges inline tool attachment data per attachment", async () => {
  const main = model("main", 60_000)
  const { compaction, requests } = overflowHarness()
  const input = {
    sessionID: SessionSchema.ID.make("ses_compaction_tool_media"),
    entries: overflowEntries(),
    model: main,
    request: LLM.request({
      model: main,
      messages: [
        Message.tool({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Image read successfully" },
              { type: "file", uri: inlineImage(400_000), mime: "image/png", name: "shot.png" },
            ],
          },
        }),
      ],
    }),
  } as never

  expect(await Effect.runPromise(compaction.compactIfNeeded(input))).toBe(false)
  expect(requests).toHaveLength(0)
})

test("compaction still triggers when the request text fills the window", async () => {
  const main = model("main", 60_000)
  const { compaction, requests } = overflowHarness()
  const input = {
    sessionID: SessionSchema.ID.make("ses_compaction_text"),
    entries: overflowEntries(),
    model: main,
    request: LLM.request({ model: main, messages: [Message.user("z".repeat(400_000))] }),
  } as never

  expect(await Effect.runPromise(compaction.compactIfNeeded(input))).toBe(true)
  expect(requests.length).toBeGreaterThan(0)
})

test("compaction reserves the requested output instead of the model output ceiling", async () => {
  const main = OpenAIChat.route.with({ limits: { context: 60_000, output: 393_216 } }).model({ id: "main" })
  const { compaction, requests } = overflowHarness()
  const input = {
    sessionID: SessionSchema.ID.make("ses_compaction_reserve"),
    entries: overflowEntries(),
    model: main,
    request: LLM.request({ model: main, messages: [Message.user("z".repeat(40_000))] }),
  } as never

  // A 393k output ceiling is not a reserve: the window keeps its real size.
  expect(await Effect.runPromise(compaction.compactIfNeeded(input))).toBe(false)
  expect(requests).toHaveLength(0)
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

const recentHarness = () => {
  const recents: string[] = []
  const compaction = SessionCompaction.make({
    events: {
      publish: (_schema: unknown, data: { recent?: string }) => {
        if (typeof data?.recent === "string") recents.push(data.recent)
        return Effect.succeed(undefined)
      },
    } as never,
    llm: { stream: () => summary("summary") as never },
    config: [] as never,
  })
  return { compaction, recents }
}

test("compaction pins the latest goal into the retained context", async () => {
  const main = model("main", 100_000)
  const { compaction, recents } = recentHarness()
  const goal = {
    seq: 1,
    message: {
      type: "synthetic",
      id: "msg_goal",
      text: '<goal status="active">\nShip the release\n</goal>',
      metadata: { goal: { objective: "Ship the release", status: "active" } },
    },
  }
  const input = {
    sessionID: SessionSchema.ID.make("ses_goal_pin"),
    entries: [goal, ...overflowEntries().map((entry, index) => ({ ...entry, seq: index + 2 }))],
    model: main,
    request: LLM.request({ model: main, messages: [] }),
  } as never

  expect(await Effect.runPromise(compaction.compactAfterOverflow(input))).toBe(true)
  expect(recents).toHaveLength(1)
  // The goal sits above the retained tail, so the summary alone would be free to
  // drop it; the pin keeps it verbatim in <recent-context>.
  expect(recents[0]).toContain('<goal status="active">')
  expect(recents[0]).toContain("Ship the release")
})

const customHarness = (config: unknown, attempt: Stream.Stream<never, never>) => {
  const requests: LLMRequest[] = []
  const compaction = SessionCompaction.make({
    events: { publish: () => Effect.succeed(undefined) } as never,
    llm: {
      stream: (request: LLMRequest) => {
        requests.push(request)
        return attempt as never
      },
    },
    config: config as never,
  })
  return { compaction, requests }
}

const observedInput = (sessionID: string, route: ReturnType<typeof model>, observedTokens: number) =>
  ({
    sessionID: SessionSchema.ID.make(sessionID),
    entries: overflowEntries(),
    model: route,
    request: LLM.request({ model: route, messages: [Message.user("continue")] }),
    observedTokens,
  }) as never

test("compaction triggers on the provider's reported usage even when the local request estimate is small", async () => {
  const main = model("main", 100_000)
  const { compaction, requests } = customHarness([], summary("summary"))

  // The request text estimates far below the window; the provider counted 95k.
  expect(await Effect.runPromise(compaction.compactIfNeeded(observedInput("ses_observed_trigger", main, 95_000)))).toBe(
    true,
  )
  expect(requests).toHaveLength(1)
})

test("compaction stays put when the reported usage is below the threshold window", async () => {
  const main = model("main", 100_000)
  const { compaction, requests } = customHarness([], summary("summary"))

  expect(await Effect.runPromise(compaction.compactIfNeeded(observedInput("ses_observed_skip", main, 50_000)))).toBe(
    false,
  )
  expect(requests).toHaveLength(0)
})

test("compaction threshold config triggers earlier than the default", async () => {
  const main = model("main", 100_000)
  const early = customHarness([{ type: "document", info: { compaction: { threshold: 0.5 } } }], summary("summary"))
  const standard = customHarness([], summary("summary"))

  // 55k sits inside the default 90% window but past a 50% window.
  expect(
    await Effect.runPromise(standard.compaction.compactIfNeeded(observedInput("ses_threshold", main, 55_000))),
  ).toBe(false)
  expect(await Effect.runPromise(early.compaction.compactIfNeeded(observedInput("ses_threshold", main, 55_000)))).toBe(
    true,
  )
  expect(standard.requests).toHaveLength(0)
  expect(early.requests).toHaveLength(1)
})

test("compaction ignores an out-of-range threshold instead of thrashing", async () => {
  const main = model("main", 100_000)
  const zero = customHarness([{ type: "document", info: { compaction: { threshold: 0 } } }], summary("summary"))

  // `0` would compact every turn; it falls back to the default 0.9, so 50k waits.
  expect(
    await Effect.runPromise(zero.compaction.compactIfNeeded(observedInput("ses_threshold_bad", main, 50_000))),
  ).toBe(false)
  expect(zero.requests).toHaveLength(0)
})

test("compaction plans against the endpoint's input ceiling, not the raw context", async () => {
  // gpt-6.1-sol publishes context 1,050,000 with an input ceiling of 922,000: the
  // output the model reserves is not usable input, and a request above the ceiling
  // is refused outright. 930k sits inside `context` and still has to compact.
  const main = capped("main", 1_050_000, 922_000)
  const { compaction, requests } = customHarness([], summary("summary"))

  expect(
    await Effect.runPromise(compaction.compactIfNeeded(observedInput("ses_input_ceiling", main, 930_000))),
  ).toBe(true)
  expect(requests).toHaveLength(1)
  expect(
    await Effect.runPromise(compaction.compactIfNeeded(observedInput("ses_input_ceiling_below", main, 700_000))),
  ).toBe(false)
  expect(requests).toHaveLength(1)
})

test("compaction carries the configured ratio only as far as the window's headroom allows", async () => {
  const main = model("main", 1_000_000)
  const { compaction, requests } = customHarness([], summary("summary"))

  // The ratio alone would fire at 0.9 of the window. The headroom a step needs for
  // its protected tool output, the summary it will write, and the configured slack
  // carries a large window later, to about 94%, which is where other harnesses
  // compact too.
  expect(
    await Effect.runPromise(compaction.compactIfNeeded(observedInput("ses_headroom_below", main, 930_000))),
  ).toBe(false)
  expect(requests).toHaveLength(0)
  expect(
    await Effect.runPromise(compaction.compactIfNeeded(observedInput("ses_headroom_above", main, 940_000))),
  ).toBe(true)
  expect(requests).toHaveLength(1)
})

test("compaction sizes the request from the provider's count plus what was appended", async () => {
  const main = model("main", 1_000_000)
  const { compaction, requests } = customHarness([], summary("summary"))
  const appended = Message.user("lorem ipsum dolor sit amet consectetur ".repeat(10_000))
  const input = (sessionID: string, observedMessages: number) =>
    ({
      sessionID: SessionSchema.ID.make(sessionID),
      entries: overflowEntries(),
      model: main,
      request: LLM.request({ model: main, messages: [Message.user("counted"), appended] }),
      observedTokens: 900_000,
      observedMessages,
      observedPrefix: SessionCompaction.prefix(
        LLM.request({ model: main, messages: [Message.user("counted"), appended] }), observedMessages,
      ),
    }) as never

  // The report covered the first message only, so the second is this request's own
  // growth and belongs in the size: 900k plus its tokens passes the window's limit.
  expect(await Effect.runPromise(compaction.compactIfNeeded(input("ses_delta_counted", 1)))).toBe(true)
  expect(requests).toHaveLength(1)
  // The same report already covered both messages, so nothing arrived since and the
  // request is the 900k the provider counted, below the limit.
  expect(await Effect.runPromise(compaction.compactIfNeeded(input("ses_delta_covered", 2)))).toBe(false)
  expect(requests).toHaveLength(1)
})

test("auto-compaction stops after repeated summary failures until it is reset", async () => {
  const main = model("main", 100_000)
  const { compaction, requests } = customHarness([], empty)

  const run = () => Effect.runPromise(compaction.compactIfNeeded(observedInput("ses_breaker", main, 95_000)))
  expect(await run()).toBe(false)
  expect(await run()).toBe(false)
  expect(await run()).toBe(false)
  // Three failures trip the breaker: the fourth decision makes no new request.
  expect(await run()).toBe(false)
  expect(requests).toHaveLength(3)

  // A manual compaction resets it, so the next turn tries again.
  await Effect.runPromise(compaction.reset(SessionSchema.ID.make("ses_breaker")))
  expect(await run()).toBe(false)
  expect(requests).toHaveLength(4)
})

test("proactive compaction summarizes once over the warm request prefix", async () => {
  const main = model("main", 100_000)
  const { compaction, requests } = customHarness([], summary("summary"))
  const input = observedInput("ses_hot_prefix", main, 95_000)

  expect(await Effect.runPromise(compaction.compactIfNeeded(input))).toBe(true)

  // One call over the prefix the turn already built: the conversation stays in
  // place and the instruction is appended, so the provider serves the prefix from
  // its prompt cache instead of re-reading a re-embedded history.
  expect(requests).toHaveLength(1)
  expect(requests[0].messages).toHaveLength(2)
  expect(requests[0].toolChoice?.type).toBe("none")
  const instruction = requests[0].messages[1]?.content[0]
  if (instruction?.type !== "text") throw new Error("expected text instruction")
  expect(instruction.text).toStartWith("Summarize the conversation above")
})

test("compaction falls back to the staged strategy when the prefix cannot hold the instruction", async () => {
  const main = model("main", 20_000)
  const { compaction, requests } = customHarness([], summary("summary"))

  // The prefix alone is already at the window with the output reserve turned
  // down to nothing, so there is no room for the instruction. The truncated head
  // is summarized instead, which re-embeds the conversation as one prompt.
  const input = {
    sessionID: SessionSchema.ID.make("ses_staged_fallback"),
    entries: overflowEntries(),
    model: main,
    request: LLM.request({
      model: main,
      messages: [Message.user("filler".repeat(14_000))],
      generation: { maxTokens: 1 },
    }),
    observedTokens: 19_000,
  } as never

  expect(await Effect.runPromise(compaction.compactIfNeeded(input))).toBe(true)
  expect(requests).toHaveLength(1)
  expect(requests[0].messages).toHaveLength(1)
  const prompt = requests[0].messages[0]?.content[0]
  if (prompt?.type !== "text") throw new Error("expected text summary request")
  expect(prompt.text).toStartWith("Here is the conversation so far:")
})

test("a compaction reports the compacting phase while it runs", async () => {
  const main = model("main", 100_000)
  const phases: string[] = []
  const compaction = SessionCompaction.make({
    events: { publish: () => Effect.succeed(undefined) } as never,
    llm: { stream: () => summary("summary") as never },
    config: [] as never,
  })
  const input = (sessionID: string, observedTokens: number) =>
    ({
      ...(observedInput(sessionID, main, observedTokens) as Record<string, unknown>),
      report: (phase: string) => {
        phases.push(phase)
        return Effect.void
      },
    }) as never

  // The drain is neither requesting nor streaming while a summary is in flight.
  expect(await Effect.runPromise(compaction.compactIfNeeded(input("ses_phase", 95_000) as never))).toBe(true)
  expect(phases).toEqual(["compacting"])

  // A decision that never reaches the provider reports nothing.
  expect(await Effect.runPromise(compaction.compactIfNeeded(input("ses_phase_idle", 50_000) as never))).toBe(false)
  expect(phases).toEqual(["compacting"])
})

test("compaction asks the provider to count only when the decision is close", async () => {
  const main = model("main", 1_000_000)
  const counts: LLMRequest[] = []
  const counted = { value: 0 }
  const compaction = SessionCompaction.make({
    events: { publish: () => Effect.succeed(undefined) } as never,
    llm: {
      stream: () => summary("summary") as never,
      count: (request: LLMRequest) => {
        counts.push(request)
        return Effect.succeed(counted.value)
      },
    },
    config: [] as never,
  })

  // Far below the limit: the estimated delta cannot flip the outcome, so no count
  // request is spent.
  expect(
    await Effect.runPromise(compaction.compactIfNeeded(observedInput("ses_count_far", main, 600_000))),
  ).toBe(false)
  expect(counts).toHaveLength(0)

  // Close to the limit, the provider's own count decides the outcome either way.
  const near = observedInput("ses_count_near", main, 920_000)
  counted.value = 900_000
  expect(await Effect.runPromise(compaction.compactIfNeeded(near))).toBe(false)
  expect(counts).toHaveLength(1)
  counted.value = 950_000
  expect(await Effect.runPromise(compaction.compactIfNeeded(near))).toBe(true)
  expect(counts).toHaveLength(2)
})

test("an attempt that never reached the model does not count against the breaker", async () => {
  const main = model("main", 100_000)
  const requests: LLMRequest[] = []
  const compaction = SessionCompaction.make({
    events: { publish: () => Effect.succeed(undefined) } as never,
    llm: {
      stream: (request: LLMRequest) => {
        requests.push(request)
        return empty as never
      },
    },
    config: [] as never,
  })

  // No room for the instruction, and nothing left to summarize: both strategies
  // decline without contacting a model.
  const declined = {
    sessionID: SessionSchema.ID.make("ses_skipped_breaker"),
    entries: [{ seq: 1, message: { type: "compaction", id: "msg_c", summary: "earlier", recent: "tail" } }],
    model: model("main", 1_000),
    request: LLM.request({ model: main, messages: [Message.user("continue")] }),
    observedTokens: 95_000,
  } as never
  for (let attempt = 0; attempt < 5; attempt++)
    expect(await Effect.runPromise(compaction.compactIfNeeded(declined))).toBe(false)
  expect(requests).toHaveLength(0)

  // Those attempts spent none of the breaker's budget, so a refused summary still
  // gets its three tries before the breaker trips.
  const refused = observedInput("ses_skipped_breaker", main, 95_000)
  for (let attempt = 0; attempt < 3; attempt++)
    expect(await Effect.runPromise(compaction.compactIfNeeded(refused))).toBe(false)
  expect(requests).toHaveLength(3)
  expect(await Effect.runPromise(compaction.compactIfNeeded(refused))).toBe(false)
  expect(requests).toHaveLength(3)
})

const largeRecoveryInput = () => {
  const main = model("main", 1_000_000)
  const history = `BEGIN_HISTORY ${"目录 状态 验证。\n".repeat(12_000)} END_HISTORY`
  return {
    history,
    input: {
      sessionID: SessionSchema.ID.make("ses_bounded_recovery"),
      entries: [
        {
          seq: 1,
          message: SessionMessage.User.make({
            id: SessionMessage.ID.create(),
            type: "user",
            text: history,
            time: { created: DateTime.makeUnsafe(123) },
          }),
        },
      ],
      model: main,
      request: LLM.request({ model: main, messages: [Message.user(history)] }),
    },
  }
}

test("overflow recovery summarizes every part of a large multilingual history under a bounded request budget", async () => {
  const { history, input } = largeRecoveryInput()
  const { compaction, requests, published } = stagedHarness([summary("anchored checkpoint")])
  expect(await Effect.runPromise(compaction.compactAfterOverflow(input))).toBe(true)
  expect(requests.length).toBeGreaterThan(1)
  const prompts = requests.map((request) => {
    const prompt = request.messages[0].content[0]
    if (prompt.type !== "text") throw new Error("expected text summary request")
    expect(
      Token.measureValue({ system: request.system, messages: request.messages }, Token.count) +
        (request.generation?.maxTokens ?? 0),
    ).toBeLessThanOrEqual(64_000)
    return prompt.text
  })
  const segments = prompts
    .filter((text) => text.includes("<conversation>\n"))
    .map((text) => text.split("<conversation>\n")[1].split("\n</conversation>")[0])
  expect(segments.join("")).toBe(`[User]: ${history}`)
  expect(published).toEqual(["anchored checkpoint"])
  // Slices are independent and merged once, rather than each slice carrying the
  // summary produced by the one before it.
  expect(prompts.at(-1)).toContain("<partial-summaries>")
})

test("overflow recovery summarizes the cached prefix in one call when the summary still fits", async () => {
  // The refused turn could not carry the model's whole output allowance; the summary
  // reserves only its own, so the prefix still fits and one cached call finishes the
  // checkpoint instead of minutes of re-embedded slices.
  const { input } = largeRecoveryInput()
  const { compaction, requests, published } = summarizeHarness([summary("anchored checkpoint")])

  expect(await Effect.runPromise(compaction.compactAfterOverflow(input))).toBe(true)
  expect(requests).toHaveLength(1)
  expect(requests[0].messages).toHaveLength(2)
  expect(requests[0].toolChoice?.type).toBe("none")
  expect(published).toEqual(["anchored checkpoint"])
})

test("a failed intermediate summary never replaces the original long conversation", async () => {
  const { input } = largeRecoveryInput()
  const { compaction, requests, published } = stagedHarness([summary("intermediate only"), empty])
  expect(await Effect.runPromise(compaction.compactAfterOverflow(input))).toBe(false)
  expect(requests).toHaveLength(2)
  expect(published).toEqual([])
})

test("a staged compaction publishes its slice plan and then each slice", async () => {
  const { input } = largeRecoveryInput()
  const reports: Array<{ phase: string; progress?: { stage: number; stages: number } }> = []
  const { compaction, requests } = stagedHarness([summary("first"), summary("second")])

  expect(
    await Effect.runPromise(
      compaction.compactAfterOverflow({
        ...input,
        report: (phase: string, progress?: { stage: number; stages: number }) => {
          reports.push({ phase, progress })
          return Effect.void
        },
      } as never),
    ),
  ).toBe(true)

  // The plan arrives before the first slice, then every slice in order, so a client
  // can show 0/N turning into real movement instead of an indeterminate wait.
  const compacting = reports.filter((entry) => entry.phase === "compacting")
  expect(compacting[0]?.progress?.stage).toBe(0)
  const stages = compacting[0]?.progress?.stages ?? 0
  expect(stages).toBeGreaterThan(0)
  expect(compacting.slice(1).map((entry) => entry.progress?.stage)).toEqual(
    Array.from({ length: stages }, (_, index) => index + 1),
  )
  expect(requests.length).toBeGreaterThan(1)
})

test("an interrupted staged compaction stops without publishing a checkpoint", () =>
  Effect.gen(function* () {
    const { input } = largeRecoveryInput()
    const published: string[] = []
    const compaction = SessionCompaction.make({
      events: {
        publish: (_schema: unknown, data: { text?: string }) => {
          if (typeof data?.text === "string") published.push(data.text)
          return Effect.succeed(undefined)
        },
      } as never,
      // The summarizer accepts the request and then never answers, so only an
      // interrupt ends the run.
      llm: { stream: () => Stream.fromEffect(Effect.never) as never },
      config: [] as never,
    })

    const fiber = yield* compaction.compactAfterOverflow(input).pipe(Effect.forkChild)
    yield* Effect.sleep("20 millis")
    // The summarizer never answered, so the run is still in flight.
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* Fiber.interrupt(fiber)
    const exit = fiber.pollUnsafe()

    // The staged run has to stay interruptible: an escaping user must be able to end
    // it, and it must end without a summary, because a partial chain of slices would
    // drop the history it had not summarized yet.
    expect(exit === undefined ? "still running" : Exit.hasInterrupts(exit)).toBe(true)
    expect(published).toEqual([])
  }).pipe(Effect.runPromise),
)


test("request calibration is invalidated by changed instructions, tools, route, or history", async () => {
  const main = model("main", 1_000_000)
  const { compaction } = customHarness([], summary("summary"))
  const request = LLM.request({ model: main, messages: [Message.user("counted")] })
  const observation = {
    observedTokens: 900_000,
    observedMessages: 1,
    observedPrefix: SessionCompaction.prefix(request),
  }
  const changed = [
    LLM.request({ ...request, system: [SystemPart.make("new instructions")] }),
    LLM.request({ ...request, tools: [{ name: "new_tool", description: "new tool", inputSchema: { type: "object" } }] }),
    LLM.request({ ...request, model: model("other", 1_000_000) }),
    LLM.request({ ...request, model: model("main", 2_000_000) }),
    LLM.request({ ...request, messages: [Message.user("rewritten"), Message.user("new")] }),
    LLM.request({ ...request, messages: [] }),
  ]
  for (const next of changed) {
    const budget = await Effect.runPromise(compaction.budget({
      sessionID: SessionSchema.ID.make("ses_changed_prefix"), entries: [], model: next.model,
      request: next, ...observation,
    }))
    expect(budget.input).toBeLessThan(100)
    expect(budget.source).toBe("estimated")
  }
  const appended = Message.user("new content".repeat(100))
  const budget = await Effect.runPromise(compaction.budget({
    sessionID: SessionSchema.ID.make("ses_valid_prefix"), entries: [], model: main,
    request: LLM.request({ ...request, messages: [...request.messages, appended] }), ...observation,
  }))
  expect(budget.input).toBe(900_000 + Token.measureValue([appended]))
})

test("a larger changed prefix cannot hide behind a small previous provider count", async () => {
  const main = model("main", 100_000)
  const { compaction, requests } = customHarness([], summary("summary"))
  const request = LLM.request({ model: main, messages: [Message.user("counted")] })
  expect(await Effect.runPromise(compaction.compactIfNeeded({
    sessionID: SessionSchema.ID.make("ses_larger_prefix"), entries: overflowEntries() as never, model: main,
    request: LLM.request({ ...request, system: [SystemPart.make("lorem ipsum ".repeat(30_000))],
      messages: [...request.messages, Message.user("new")] }),
    observedTokens: 100, observedMessages: 1, observedPrefix: SessionCompaction.prefix(request),
  }))).toBe(true)
  expect(requests.length).toBeGreaterThan(0)
})

test("the sending budget exposes provider counting and reserves generation space", async () => {
  const main = model("main", 100_000)
  let counts = 0
  const compaction = SessionCompaction.make({
    events: { publish: () => Effect.void } as never,
    llm: { stream: () => Stream.empty, count: () => { counts++; return Effect.succeed(69_000) } },
    config: [],
  })
  const request = LLM.request({ model: main, messages: [Message.user("counted")] })
  const input = { sessionID: SessionSchema.ID.make("ses_sending_budget"), entries: [], model: main, request,
    observedTokens: 68_000, observedMessages: 1, observedPrefix: SessionCompaction.prefix(request) }
  const budget = await Effect.runPromise(compaction.budget(input))
  expect(budget).toMatchObject({ input: 69_000, source: "counted", window: 100_000, limit: 70_000, observed: 68_000 })
  expect(await Effect.runPromise(compaction.compactIfNeeded(input, budget))).toBe(false)
  expect(counts).toBe(1)
})

test("hot compaction fits the request against the size the decision measured", async () => {
  const main = model("main", 100_000)
  const { compaction, requests } = customHarness([], summary("summary"))
  const input = {
    sessionID: SessionSchema.ID.make("ses_hot_measured"),
    entries: overflowEntries(),
    model: main,
    request: LLM.request({
      model: main,
      messages: [Message.user("filler".repeat(80_000))],
      generation: { maxTokens: 4_096 },
    }),
    // The provider counted this request at 40k; re-measuring the text locally
    // would read 120k and push it onto the staged path for no reason.
    tokens: 40_000,
  } as never

  expect(await Effect.runPromise(compaction.compact(input))).toMatchObject({ result: "compacted" })
  expect(requests).toHaveLength(1)
  // The cached-prefix signature: the whole request plus one instruction message.
  expect(requests[0].messages).toHaveLength(2)
})

test("a summary pins the cheapest reasoning tier of its own model", async () => {
  const main = model("main", 100_000)
  const { compaction, requests } = customHarness([], summary("summary"))
  const input = {
    sessionID: SessionSchema.ID.make("ses_summary_tier"),
    entries: overflowEntries(),
    model: main,
    modelInfo: {
      providerID: "openai",
      id: "main",
      api: { type: "aisdk", package: "@ai-sdk/openai", id: "gpt-6.1" },
      variants: [
        { id: "high", headers: {}, body: { reasoning: { effort: "high" } } },
        { id: "low", headers: {}, body: { reasoning: { effort: "low" } } },
      ],
    },
    request: LLM.request({
      model: main,
      messages: [Message.user("continue")],
      http: { body: { reasoning: { effort: "high" } } },
    }),
  } as never

  expect(await Effect.runPromise(compaction.compact(input))).toMatchObject({ result: "compacted" })
  expect(requests).toHaveLength(1)
  // The selected variant wrote "high" into the route body; the summary overrides
  // it without dropping the rest of the overlay.
  expect(requests[0].http?.body).toMatchObject({ reasoning: { effort: "low" } })
})

test("a merge prompt folds partials once with the prior summary", () => {
  const prompt = SessionCompaction.buildMergePrompt({
    previousSummary: "earlier",
    parts: ["first part", "second part"],
  })

  expect(prompt).toContain("<partial-summaries>\nfirst part\n\nsecond part\n</partial-summaries>")
  expect(prompt).toContain("<prior-summary>\nearlier\n</prior-summary>")
  expect(prompt.indexOf("<partial-summaries>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt).toContain("## Work State")
})
