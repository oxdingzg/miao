import { Schema } from "effect"
import { Model } from "@miao/schema/model"
import { expect, test } from "bun:test"
import { Agent } from "@miao/schema/agent"
import { agentManifest, modelRoute } from "../../src/engine/product-agent"
import { EngineTranslator, type EngineSessionEvent } from "../../src/engine/session"

test("agent manifests preserve ordered exceptions, generation settings and model variants", () => {
  const agent = {
    ...Agent.Info.empty(Agent.ID.make("reviewer")),
    system: "Review first",
    steps: 7,
    budget: 40_000,
    model: { providerID: "host", id: "model", variant: "high" },
    request: { body: { temperature: 0.2 }, headers: { "x-test": "agent" } },
    permissions: [
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "edit", resource: ".miao/plans/*.md", effect: "allow" as const },
    ],
  }
  const decoded = Schema.decodeUnknownSync(Agent.Info)(agent)
  const manifest = agentManifest(decoded, [
    { route_id: "host/model", protocol: "openai-chat", model: "wire", variants: ["high"] },
  ])
  expect(manifest.ordered_permissions.rules).toEqual(agent.permissions)
  expect(manifest.instructions).toBe("Review first")
  expect(manifest.request).toEqual(agent.request)
  expect(manifest.steps).toBe(7)
  expect(manifest.budget).toBe(40_000)
  expect(manifest.model).toEqual({
    route_id: "host/model",
    protocol: "openai-chat",
    model: "wire",
    variant: Model.VariantID.make("high"),
  })
})

test("agent switches replay with stable product event identities", () => {
  const outputs: EngineSessionEvent[] = []
  const translator = new EngineTranslator((event) => outputs.push(event))
  translator.dispatch({
    session_id: "ses_agent",
    seq: 2,
    kind: "session.agent.selected",
    recorded_at_ms: 1000,
    data: { agent: { name: "reviewer" }, agent_hash: "hash" },
  })
  expect(outputs).toHaveLength(1)
  expect(outputs[0].type).toBe("session.next.agent.switched")
  expect(outputs[0].source).toMatchObject({ sessionID: "ses_agent", seq: 2, index: 0 })
  expect(outputs[0].data).toMatchObject({ sessionID: "ses_agent", agent: "reviewer", messageID: "msg_ses_agent_2" })
})

test("external directory rules stay with the ordered manifest", () => {
  const agent = Schema.decodeUnknownSync(Agent.Info)({
    ...Agent.Info.empty(Agent.ID.make("build")),
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "ask" },
    ],
  })
  expect(agentManifest(agent, []).ordered_permissions.rules).toEqual(agent.permissions)
})

test("auto-classifier mode rides the manifest for the engine to settle", () => {
  const agent = Schema.decodeUnknownSync(Agent.Info)({
    ...Agent.Info.empty(Agent.ID.make("auto-agent")),
    permission_mode: "auto",
  })
  expect(agentManifest(agent, []).permission_mode).toBe("auto")
  const plain = Schema.decodeUnknownSync(Agent.Info)(Agent.Info.empty(Agent.ID.make("plain-agent")))
  expect("permission_mode" in agentManifest(plain, [])).toBe(false)
})

test("an explicit engine route binds its primary model by identity", () => {
  // An explicit provider/endpoint engine reports one primary route with no id.
  const catalog = [{ route_id: null, protocol: "openai-chat", model: "fixture/fixture" }] as const
  const model = Schema.decodeUnknownSync(Model.Ref)({ providerID: "fixture", id: "fixture" })
  expect(modelRoute(model, catalog)).toEqual({
    route_id: null,
    protocol: "openai-chat",
    model: "fixture/fixture",
  })
  // The engine can report the provider's api model id without the provider name.
  expect(modelRoute(model, [{ route_id: null, protocol: "openai-chat", model: "fixture" }])).toMatchObject({
    route_id: null,
    model: "fixture",
  })
  const other = Schema.decodeUnknownSync(Model.Ref)({ providerID: "fixture", id: "other" })
  expect(() => modelRoute(other, catalog)).toThrow()
})
