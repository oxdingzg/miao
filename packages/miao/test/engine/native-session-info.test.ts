import { expect, test } from "bun:test"
import { SessionID } from "@miao/schema/session-id"
import { Location } from "@miao/schema/location"
import { Project } from "@miao/schema/project"
import { DateTime, Schema } from "effect"
import { ModelV2 } from "@miao/core/model"
import { ProviderV2 } from "@miao/core/provider"
import { nativeSessionInfo, nativeSessionUsage } from "@miao/server/native-session"

const sessionID = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))("ses_native") as never
const projectID = Schema.decodeUnknownSync(Project.ID)("prj_one")
const location = Schema.decodeUnknownSync(Location.Ref)({ directory: "/workspace" })

test("engine snapshot projects to the product record without inventing facts", () => {
  const info = nativeSessionInfo({
    sessionID,
    projectID,
    location,
    snapshot: {
      session_id: "ses_native",
      title: "First title",
      created_at_ms: 1_700_000_000_000,
      updated_at_ms: 1_700_000_001_000,
    },
  })
  expect(info.id).toBe(sessionID)
  expect(info.projectID).toBe(projectID)
  expect(info.title).toBe("First title")
  expect(info.location).toEqual(location)
  expect(info.cost).toBe(0)
  expect(info.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
  expect(DateTime.toEpochMillis(info.time.created)).toBe(1_700_000_000_000)
  expect(DateTime.toEpochMillis(info.time.updated)).toBe(1_700_000_001_000)
  // The engine knows collaboration mode, not product identities.
  expect(info.agent).toBeUndefined()
  expect(info.model).toBeUndefined()
})

test("unknown metadata degrades honestly instead of fabricating", () => {
  const info = nativeSessionInfo({
    sessionID,
    projectID,
    location,
    snapshot: { session_id: "ses_native", title: null, created_at_ms: null, updated_at_ms: null },
  })
  expect(info.title).toBe("")
  expect(DateTime.toEpochMillis(info.time.created)).toBe(0)
  expect(DateTime.toEpochMillis(info.time.updated)).toBe(0)
})

test("fork lineage comes from the engine snapshot rather than a fabricated catalog parent", () => {
  const input = { sessionID: SessionID.make("ses_child"), projectID, location }
  expect(nativeSessionInfo({ ...input, snapshot: { parent_session_id: "ses_parent" } }).parentID).toBe(
    SessionID.make("ses_parent"),
  )
  expect(nativeSessionInfo({ ...input, snapshot: { parent_session_id: null } }).parentID).toBeUndefined()
  expect(() => nativeSessionInfo({ ...input, snapshot: { parent_session_id: "invalid" } })).toThrow()
})

test("a usage-less engine report projects to no usage block", () => {
  expect(nativeSessionUsage({ report: {}, models: [], snapshot: {} })).toBeUndefined()
  expect(
    nativeSessionUsage({
      report: { turns: 0, tools: { calls: 0, failures: 0 }, turnsDetail: [] },
      models: [],
      snapshot: {},
    }),
  ).toBeUndefined()
})

test("billed turns price through the catalog at each turn's own tier", () => {
  const base = { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }
  const model = {
    ...ModelV2.Info.empty(ProviderV2.ID.make("openai"), ModelV2.ID.make("gpt-x")),
    cost: [
      {
        ...base,
        tier: { type: "context" as const, size: 200_000 },
        input: 3,
        output: 4,
        cache: { read: 0.3, write: 0.4 },
      },
    ],
  }
  const usage = nativeSessionUsage({
    report: {
      turns: 1,
      partialTurns: 1,
      tools: { calls: 2, failures: 1 },
      turnsDetail: [
        {
          protocol: "openai-chat",
          model: "openai/gpt-x",
          runID: "r1",
          step: 0,
          turnMs: 1_700_000_001_000,
          usage: {
            inputTokens: 300_000,
            outputTokens: 10,
            nonCachedInputTokens: 50_000,
            cacheReadInputTokens: 150_000,
          },
        },
      ],
    },
    models: [model],
    snapshot: { updated_at_ms: 1_700_000_002_000 },
  })
  expect(usage).toBeDefined()
  expect(usage!.turns).toBe(1)
  expect(usage!.tools).toEqual({ calls: 2, failures: 1 })
  expect(usage!.models).toHaveLength(1)
  expect(usage!.models[0].providerID).toBe(ProviderV2.ID.make("openai"))
  expect(usage!.models[0].id).toBe(ModelV2.ID.make("gpt-x"))
  // The 300k input crosses the 200k tier, so the 3/1 rates price the turn.
  expect(usage!.models[0].cost).toBeCloseTo((50_000 * 3 + 10 * 4 + 150_000 * 0.3) / 1_000_000)
  expect(usage!.models[0].tokens).toEqual({
    input: 300_000,
    output: 10,
    reasoning: 0,
    cache: { read: 150_000, write: 0 },
  })
  expect(DateTime.toEpochMillis(usage!.models[0].lastTurnAt)).toBe(1_700_000_001_000)
})

test("turns the timing table predates keep tokens and degrade the display time", () => {
  const usage = nativeSessionUsage({
    report: {
      turns: 1,
      tools: { calls: 0, failures: 0 },
      turnsDetail: [{ model: "unknown/model", usage: { inputTokens: 10, outputTokens: 1 } }],
    },
    models: [],
    snapshot: { updated_at_ms: 1_700_000_003_000 },
  })
  expect(usage!.models[0].cost).toBe(0)
  expect(usage!.models[0].tokens.input).toBe(10)
  expect(DateTime.toEpochMillis(usage!.models[0].lastTurnAt)).toBe(1_700_000_003_000)
})

test("projected usage fills the session record's cost and token totals", () => {
  const usage = nativeSessionUsage({
    report: {
      turns: 1,
      tools: { calls: 1, failures: 0 },
      turnsDetail: [{ model: "openai/gpt-x", usage: { inputTokens: 100, outputTokens: 5 } }],
    },
    models: [],
    snapshot: {},
  })
  const info = nativeSessionInfo({
    sessionID,
    projectID,
    location,
    snapshot: { session_id: "ses_native", title: "T", created_at_ms: 1, updated_at_ms: 2 },
    usage,
  })
  expect(info.usage).toBe(usage)
  expect(info.tokens).toEqual({ input: 100, output: 5, reasoning: 0, cache: { read: 0, write: 0 } })
  expect(info.cost).toBe(0)
})

test("native accounting prices rejected auxiliary usage and keeps unknown attempts out of measured-zero rows", () => {
  const model = (id: string, input: number, output: number, read: number, write: number) => ({
    ...ModelV2.Info.empty(ProviderV2.ID.make("provider"), ModelV2.ID.make(id)),
    cost: [{ input, output, cache: { read, write } }],
  })
  const usage = nativeSessionUsage({
    report: {
      turns: 1,
      tools: { calls: 0, failures: 0 },
      providerUsage: {
        observations: 3,
        missingUsageObservations: 1,
        coverage: { input: 2, output: 2, cacheRead: 2, cacheWrite: 1, nonCached: 2, reasoning: 0 },
      },
      auxiliary: { usage: { observations: 2 } },
      providerDetail: [
        {
          kind: "primary",
          model: "provider/main",
          observedUsage: { inputTokens: 100, outputTokens: 10, nonCachedInputTokens: 20, cacheReadInputTokens: 80 },
        },
        {
          kind: "auxiliary",
          role: "summarize",
          accepted: false,
          providerSuccess: true,
          model: "provider/cheap",
          usage: {
            inputTokens: 50,
            outputTokens: 5,
            nonCachedInputTokens: 15,
            cacheReadInputTokens: 30,
            cacheWriteInputTokens: 5,
          },
        },
        {
          kind: "auxiliary",
          role: "summarize",
          accepted: false,
          providerSuccess: false,
          model: "provider/cheap",
          usage: {},
        },
      ],
    },
    models: [model("main", 1, 2, 0.1, 0.2), model("cheap", 0.5, 1, 0.05, 0.1)],
    snapshot: { updated_at_ms: 1700000000000 },
  })
  if (!usage) throw new Error("expected observed usage")
  expect(usage.turns).toBe(1)
  const cheap = usage.models.find((entry) => entry.id === "cheap")
  if (!cheap) throw new Error("expected auxiliary model")
  expect(cheap.turns).toBe(1)
  expect(cheap.tokens.input).toBe(50)
  expect(cheap.cost).toBeCloseTo(14.5 / 1_000_000, 10)
  expect(usage.models.reduce((sum, entry) => sum + entry.cost, 0)).toBeCloseTo(62.5 / 1_000_000, 10)
  expect(usage.coverage).toMatchObject({
    observations: 3,
    auxiliaryObservations: 2,
    missingUsageObservations: 1,
    unknownPriceObservations: 0,
  })
})

test("observed-usage coverage takes precedence over legacy zero-filled compatibility values", () => {
  const usage = nativeSessionUsage({
    report: {
      turns: 1,
      providerUsage: { observations: 1, missingUsageObservations: 1, coverage: {} },
      providerDetail: [{ model: "unknown/model", observedUsage: {}, usage: { inputTokens: 0, outputTokens: 0 } }],
    },
    models: [],
    snapshot: {},
  })
  if (!usage) throw new Error("expected incomplete observation")
  expect(usage.models).toEqual([])
  expect(usage.coverage).toMatchObject({
    observations: 1,
    missingUsageObservations: 1,
    unknownPriceObservations: 1,
    axes: { input: 0, output: 0 },
  })
})

test("observed token totals survive an unknown auxiliary model identity", () => {
  const usage = nativeSessionUsage({
    report: {
      turns: 0,
      providerUsage: {
        observations: 1,
        missingUsageObservations: 0,
        tokens: { input: 50, output: 5, cacheRead: 20 },
        coverage: { input: 1, output: 1, cacheRead: 1 },
      },
      auxiliary: { usage: { observations: 1 } },
      providerDetail: [
        { kind: "auxiliary", model: null, usage: { inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 20 } },
      ],
    },
    models: [],
    snapshot: {},
  })
  if (!usage) throw new Error("expected unattributed usage")
  const info = nativeSessionInfo({ sessionID, projectID, location, snapshot: { session_id: "ses_native" }, usage })
  expect(info.tokens).toEqual({ input: 50, output: 5, reasoning: 0, cache: { read: 20, write: 0 } })
  expect(usage.models).toEqual([])
  expect(usage.coverage?.unknownPriceObservations).toBe(1)
})

test("a bare engine model id prices when exactly one catalog model claims it", () => {
  const model = {
    ...ModelV2.Info.empty(ProviderV2.ID.make("opencode-go"), ModelV2.ID.make("deepseek-v4.1-flash")),
    cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
  }
  const usage = nativeSessionUsage({
    report: {
      turns: 1,
      tools: { calls: 0, failures: 0 },
      turnsDetail: [
        {
          protocol: "openai-chat",
          model: "deepseek-v4.1-flash",
          usage: { inputTokens: 10_000, outputTokens: 100, nonCachedInputTokens: 1_000, cacheReadInputTokens: 9_000 },
        },
      ],
    },
    models: [model],
    snapshot: { updated_at_ms: 1 },
  })
  expect(usage!.models).toHaveLength(1)
  expect(usage!.models[0].providerID).toBe(ProviderV2.ID.make("opencode-go"))
  expect(usage!.models[0].cost).toBeCloseTo((1_000 * 1 + 100 * 2 + 9_000 * 0.1) / 1_000_000)
})

test("an explicit primary binding projects the same model identity as resetting to the host default", () => {
  const info = nativeSessionInfo({
    sessionID,
    projectID,
    location,
    snapshot: { model_selection: { protocol: "openai-chat", model: "wire", route_id: null } },
  })
  expect(info.model).toMatchObject({ providerID: "native-engine-default", id: "default" })
})
