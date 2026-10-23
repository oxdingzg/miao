import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderGateway } from "../../src/engine/provider-gateway"

const aisdk = {
  language: () => Effect.fail(new Error("not used in this test")),
} as never

const model = (providerID: string, id: string) =>
  ({
    providerID,
    id,
    api: { type: "aisdk", id, package: "@acme/provider" },
    capabilities: { input: ["text"] },
    request: { variant: undefined, body: {}, headers: {} },
    variants: [],
  }) as never

describe("provider gateway", () => {
  test("rejects missing or wrong bearer tokens and unknown models", async () => {
    const gateway = await Effect.runPromise(ProviderGateway.prepare(aisdk))
    try {
      const endpoint = gateway.route(model("acme", "chat-1")).endpoint
      const unauthorized = await fetch(endpoint, { method: "POST", body: "{}" })
      expect(unauthorized.status).toBe(401)
      const unknown = await fetch(endpoint.replace("/acme/", "/other/"), {
        method: "POST",
        headers: { authorization: `Bearer ${gateway.token}` },
        body: "{}",
      })
      expect(unknown.status).toBe(404)
      const wrongPath = await fetch(endpoint.replace("/chat/completions", "/messages"), {
        method: "POST",
        headers: { authorization: `Bearer ${gateway.token}` },
        body: "{}",
      })
      expect(wrongPath.status).toBe(404)
    } finally {
      await Effect.runPromise(gateway.close)
    }
  })

  test("maps an OpenAI Chat history onto AI SDK model messages", () => {
    const { system, conversation } = ProviderGateway.toModelMessages([
      { role: "system", content: "be brief" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      {
        role: "assistant",
        content: "checking",
        reasoning_content: "thinking",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "contents" },
    ])
    expect(system).toBe("be brief")
    expect(conversation).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "file", mediaType: "image/png", data: "AAAA" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "checking" },
          { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            output: { type: "text", value: "contents" },
          },
        ],
      },
    ])
  })

  test("normalizes nested and flat usage shapes", () => {
    expect(
      ProviderGateway.usageOf({
        inputTokens: { total: 100, cacheRead: 40, cacheWrite: 5 },
        outputTokens: { total: 20, reasoning: 7 },
      }),
    ).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 7 },
    })
    expect(ProviderGateway.usageOf({ prompt_tokens: 3, completion_tokens: 4 })).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    })
  })
})
