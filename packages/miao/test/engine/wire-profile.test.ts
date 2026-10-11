import { expect, test } from "bun:test"
import { EngineWireProfile } from "../../src/engine/wire-profile"

const agent = { name: "build", instructions: "Keep changes focused" }
const permissions = {
  rules: [
    { tool: "read", action: "allow" },
    { tool: "write", action: "ask" },
  ],
}
const request = {
  model: "fixture-model",
  messages: [
    { role: "system", content: "project rules" },
    { role: "user", content: "first task" },
  ],
  temperature: 0,
  stream: true,
  tools: [
    {
      type: "function",
      function: { name: "read", parameters: { type: "object", properties: { file: { type: "string" } } } },
    },
  ],
}
const capture = (body: unknown, descriptor = agent, policy = permissions) =>
  EngineWireProfile.captureWireProfile({
    protocol: "openai-chat",
    request: body,
    agent: descriptor,
    permissions: policy,
  })

test("profile uses actual wire identity and effective descriptors, returning only hashes and model", () => {
  const result = capture(request)
  expect(result.model).toBe("fixture-model")
  expect(Object.keys(result)).toEqual([
    "model",
    "modelParametersHash",
    "agentManifestHash",
    "permissionHash",
    "toolSurfaceHash",
  ])
  Object.entries(result)
    .filter(([key]) => key !== "model")
    .forEach(([, value]) => expect(value).toMatch(/^[a-f0-9]{64}$/))
  expect(JSON.stringify(result)).not.toContain("project rules")
  expect(JSON.stringify(result)).not.toContain("first task")
  expect(capture({ ...request, model: "literal%2Fidentity" }).model).toBe("literal%2Fidentity")
})

test("object key order and task history do not change profiles, effective instructions do", () => {
  expect(
    capture({ tools: request.tools, stream: true, temperature: 0, messages: request.messages, model: request.model }),
  ).toEqual(capture(request))
  expect(capture({ ...request, messages: [request.messages[0], { role: "user", content: "another task" }] })).toEqual(
    capture(request),
  )
  expect(
    capture({ ...request, messages: [{ role: "system", content: "different rules" }] }).agentManifestHash,
  ).not.toBe(capture(request).agentManifestHash)
  expect(capture(request, { ...agent, instructions: "different agent" }).agentManifestHash).not.toBe(
    capture(request).agentManifestHash,
  )
})

test("every additional generation parameter and ordered tool or permission difference remains significant", () => {
  expect(capture({ ...request, temperature: 0.5 }).modelParametersHash).not.toBe(capture(request).modelParametersHash)
  expect(capture({ ...request, reasoning_effort: "high" }).modelParametersHash).not.toBe(
    capture(request).modelParametersHash,
  )
  expect(capture({ ...request, tools: [] }).toolSurfaceHash).not.toBe(capture(request).toolSurfaceHash)
  expect(capture(request, agent, { rules: permissions.rules.toReversed() }).permissionHash).not.toBe(
    capture(request).permissionHash,
  )
  expect(() => capture({ ...request, tools: undefined })).toThrow()
})

test("missing actual requests, agent identity, or permission descriptor fail instead of guessing", () => {
  expect(() => capture(null)).toThrow("Missing actual provider request")
  expect(() => capture({ messages: [] })).toThrow("Missing on-wire model identity")
  expect(() => capture(request, { name: "", instructions: "" })).toThrow("Missing explicit agent descriptor")
  expect(() =>
    EngineWireProfile.captureWireProfile({ protocol: "openai-chat", request, agent, permissions: null }),
  ).toThrow("Missing effective permission descriptor")
})

test("native model endpoint and protocol-specific generation configuration are captured", () => {
  const result = EngineWireProfile.captureWireProfile({
    protocol: "gemini",
    endpoint: "https://example.test/v1beta/models/fixture%2Dmodel:streamGenerateContent?alt=sse",
    request: {
      contents: [{ role: "user", parts: [{ text: "task" }] }],
      systemInstruction: { parts: [{ text: "project rules" }] },
      generationConfig: { temperature: 0 },
      tools: [],
    },
    agent,
    permissions,
  })
  expect(result.model).toBe("fixture-model")
  expect(result.modelParametersHash).not.toBe(capture(request).modelParametersHash)
  expect(() =>
    EngineWireProfile.captureWireProfile({
      protocol: "gemini",
      endpoint: "https://example.test/v1beta/generate",
      request: {},
      agent,
      permissions,
    }),
  ).toThrow("Missing on-wire model identity")
})

test("packet observations retain unknown policies and match proven complete-profile body hashes", () => {
  const observed = EngineWireProfile.captureRequestObservation({ protocol: "openai-chat", request })
  expect(observed.model).toBe("fixture-model")
  expect(observed.coverage).toBe("request-body-only")
  expect(observed.agentManifestHash).toBeNull()
  expect(observed.permissionHash).toBeNull()
  expect(observed.modelParametersHash).toBe(capture(request).modelParametersHash)
  expect(observed.toolSurfaceHash).toBe(capture(request).toolSurfaceHash)
  expect(JSON.stringify(observed)).not.toContain("project rules")
  expect(JSON.stringify(observed)).not.toContain("first task")
})
