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
  expect(nativeSessionInfo({ ...input, snapshot: { parent_session_id: "ses_parent" } }).parentID).toBe(SessionID.make("ses_parent"))
  expect(nativeSessionInfo({ ...input, snapshot: { parent_session_id: null } }).parentID).toBeUndefined()
  expect(() => nativeSessionInfo({ ...input, snapshot: { parent_session_id: "invalid" } })).toThrow()
})

test("a usage-less engine report projects to no usage block", () => {
  expect(nativeSessionUsage({ report: {}, models: [], snapshot: {} })).toBeUndefined()
  expect(nativeSessionUsage({ report: { turns: 0, tools: { calls: 0, failures: 0 }, turnsDetail: [] }, models: [], snapshot: {} })).toBeUndefined()
})

test("billed turns price through the catalog at each turn's own tier", () => {
  const base = { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }
  const model = {
    ...ModelV2.Info.empty(ProviderV2.ID.make("openai"), ModelV2.ID.make("gpt-x")),
    cost: [{ ...base, tier: { type: "context" as const, size: 200_000 }, input: 3, output: 4, cache: { read: 0.3, write: 0.4 } }],
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
          usage: { inputTokens: 300_000, outputTokens: 10, nonCachedInputTokens: 50_000, cacheReadInputTokens: 150_000 },
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
