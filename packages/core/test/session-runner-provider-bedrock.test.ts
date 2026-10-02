import { describe, expect } from "bun:test"
import { LLM } from "@miao/llm"
import { Effect } from "effect"
import { Credential } from "@miao/core/credential"
import { ModelV2 } from "@miao/core/model"
import { ProviderV2 } from "@miao/core/provider"
import { SessionRunnerModel } from "@miao/core/session/runner/model"
import { it } from "./lib/effect"
import { exchange, sse } from "./lib/llm-wire"

// Amazon Bedrock through the V2 route layer, against an in-process fake API.

const bedrock = (input: {
  readonly id: string
  readonly package?: string
  readonly url?: string
  readonly settings?: Record<string, unknown>
  readonly body?: Record<string, unknown>
}) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make(input.id),
    providerID: ProviderV2.ID.amazonBedrock,
    name: input.id,
    api: {
      id: ModelV2.ID.make(input.id),
      type: "aisdk",
      package: input.package ?? "@ai-sdk/amazon-bedrock",
      ...(input.url ? { url: input.url } : {}),
      settings: input.settings ?? {},
    },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    request: { headers: {}, body: (input.body ?? {}) as Record<string, never> },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
  })

// One AWS event-stream frame: prelude (lengths + CRC32), string headers, JSON payload, message CRC32.
const frame = (type: string, payload: object) => {
  const text = new TextEncoder()
  const header = (name: string, value: string) => {
    const n = text.encode(name)
    const v = text.encode(value)
    const out = new Uint8Array(1 + n.length + 1 + 2 + v.length)
    out[0] = n.length
    out.set(n, 1)
    out[1 + n.length] = 7
    new DataView(out.buffer).setUint16(2 + n.length, v.length)
    out.set(v, 4 + n.length)
    return out
  }
  const headers = concat([
    header(":message-type", "event"),
    header(":event-type", type),
    header(":content-type", "application/json"),
  ])
  const body = text.encode(JSON.stringify(payload))
  const total = 12 + headers.length + body.length + 4
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, total)
  view.setUint32(4, headers.length)
  view.setUint32(8, Bun.hash.crc32(out.subarray(0, 8)))
  out.set(headers, 12)
  out.set(body, 12 + headers.length)
  view.setUint32(total - 4, Bun.hash.crc32(out.subarray(0, total - 4)))
  return out
}

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  parts.reduce((offset, part) => {
    out.set(part, offset)
    return offset + part.length
  }, 0)
  return out
}

const converseStream = concat([
  frame("messageStart", { role: "assistant" }),
  frame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hi" } }),
  frame("contentBlockStop", { contentBlockIndex: 0 }),
  frame("messageStop", { stopReason: "end_turn" }),
  frame("metadata", { usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }),
])
const eventStream = { headers: { "content-type": "application/vnd.amazon.eventstream" } }

const withEnv = <A, E, R>(vars: Record<string, string | undefined>, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        if (value !== undefined) process.env[key] = value
      })
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          if (value !== undefined) process.env[key] = value
        }),
      ),
  )

const noAws = {
  AWS_BEARER_TOKEN_BEDROCK: undefined,
  AWS_PROFILE: undefined,
  AWS_REGION: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  AWS_SESSION_TOKEN: undefined,
}

describe("Amazon Bedrock V2 route", () => {
  it.effect("SigV4-signs Converse with credentials from the AWS provider chain", () =>
    withEnv(
      { ...noAws, AWS_ACCESS_KEY_ID: "AKIDTEST", AWS_SECRET_ACCESS_KEY: "secret-test", AWS_SESSION_TOKEN: "session-test" },
      Effect.gen(function* () {
        // models.dev lists AWS_ACCESS_KEY_ID first, so the env connection resolves to it.
        const model = yield* SessionRunnerModel.fromCatalogModel(
          bedrock({ id: "anthropic.claude-sonnet-5-v1:0", settings: { region: "us-west-2" } }),
          Credential.Key.make({ type: "key", key: "AKIDTEST" }),
        )
        const { wire, response } = yield* exchange(LLM.request({ model, prompt: "Hello" }), converseStream, eventStream)

        // US regions need the cross-region inference profile prefix for Claude.
        expect(wire.url).toBe(
          "https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-sonnet-5-v1%3A0/converse-stream",
        )
        expect(wire.headers.authorization).toStartWith("AWS4-HMAC-SHA256 Credential=AKIDTEST/")
        expect(wire.headers.authorization).toContain("/us-west-2/bedrock/aws4_request")
        expect(wire.headers["x-amz-security-token"]).toBe("session-test")
        expect(wire.headers).toHaveProperty("x-amz-date")
        expect(wire.body).not.toHaveProperty("region")
        expect(wire.body).toMatchObject({ modelId: "us.anthropic.claude-sonnet-5-v1:0" })
        expect(response.text).toBe("Hi")
      }),
    ),
  )

  it.effect("sends a Bedrock API key as a bearer token", () =>
    withEnv(
      { ...noAws, AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key", AWS_REGION: "eu-central-1" },
      Effect.gen(function* () {
        const model = yield* SessionRunnerModel.fromCatalogModel(
          bedrock({ id: "amazon.nova-pro-v1:0", body: { additionalModelRequestFields: { top_k: 5 } } }),
        )
        const { wire } = yield* exchange(LLM.request({ model, prompt: "Hello" }), converseStream, eventStream)

        expect(wire.url).toBe(
          "https://bedrock-runtime.eu-central-1.amazonaws.com/model/amazon.nova-pro-v1%3A0/converse-stream",
        )
        expect(wire.headers.authorization).toBe("Bearer bedrock-api-key")
        expect(wire.body).toMatchObject({ additionalModelRequestFields: { top_k: 5 } })
      }),
    ),
  )

  it.effect("uses a configured VPC endpoint", () =>
    withEnv(
      { ...noAws, AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key" },
      Effect.gen(function* () {
        const model = yield* SessionRunnerModel.fromCatalogModel(
          bedrock({ id: "global.anthropic.claude-opus-5-v1:0", url: "https://vpce-1.bedrock-runtime.example" }),
        )
        const { wire } = yield* exchange(LLM.request({ model, prompt: "Hello" }), converseStream, eventStream)
        expect(wire.url).toStartWith("https://vpce-1.bedrock-runtime.example/model/global.anthropic.claude-opus-5-v1")
      }),
    ),
  )

  it.effect("fails the request clearly when no AWS credentials resolve", () =>
    withEnv(
      {
        ...noAws,
        AWS_PROFILE: "miao-test-profile-that-does-not-exist",
        AWS_CONFIG_FILE: "/nonexistent",
        AWS_SHARED_CREDENTIALS_FILE: "/nonexistent",
        // Keep the chain off the instance metadata service.
        AWS_EC2_METADATA_DISABLED: "true",
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
        AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
      },
      Effect.gen(function* () {
        const model = yield* SessionRunnerModel.fromCatalogModel(bedrock({ id: "amazon.nova-pro-v1:0" }))
        const failure = yield* exchange(LLM.request({ model, prompt: "Hello" }), converseStream, eventStream).pipe(
          Effect.flip,
        )
        expect(failure.message).toContain("Missing AWS credentials for profile miao-test-profile-that-does-not-exist")
      }),
    ),
  )

  it.effect("sends Bedrock Mantle models through Responses with the API key", () =>
    withEnv(
      { ...noAws, AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key", AWS_REGION: "us-east-1" },
      Effect.gen(function* () {
        const model = yield* SessionRunnerModel.fromCatalogModel(
          bedrock({
            id: "openai.gpt-5.5",
            package: "@ai-sdk/amazon-bedrock/mantle",
            url: "https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1",
          }),
        )
        const { wire, response } = yield* exchange(
          LLM.request({ model, prompt: "Hello" }),
          sse([
            { type: "response.output_text.delta", item_id: "msg_1", delta: "Hi" },
            { type: "response.completed", response: { id: "resp_1" } },
          ]),
        )
        expect(wire.url).toBe("https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses")
        expect(wire.headers.authorization).toBe("Bearer bedrock-api-key")
        expect(wire.body).toMatchObject({ store: false })
        expect(response.text).toBe("Hi")
      }),
    ),
  )
})
