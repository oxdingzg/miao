import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../src"
import { AnthropicMessages, OpenAIChat } from "../src/protocols"
import { ToolSchemaProjection } from "../src/protocols/utils/tool-schema"
import { Auth, LLMClient } from "../src/route"
import { it } from "./lib/effect"

describe("tool schema projections", () => {
  test("moonshot strips $ref siblings and converts tuple arrays to a schema object", () => {
    expect(
      ToolSchemaProjection.moonshot({
        type: "object",
        properties: {
          linked: { $ref: "#/$defs/Linked", description: "drop me" },
          tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
          prefixTuple: { type: "array", prefixItems: [{ type: "boolean" }, { type: "string" }] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        linked: { $ref: "#/$defs/Linked" },
        tuple: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        prefixTuple: { type: "array", items: { anyOf: [{ type: "boolean" }, { type: "string" }] } },
      },
    })
  })

  test("gemini handles numeric enums, dangling required fields, untyped arrays, and scalar object keys", () => {
    expect(
      ToolSchemaProjection.gemini({
        type: "object",
        required: ["status", "missing"],
        properties: {
          status: { type: "integer", enum: [1, 2] },
          tags: { type: "array" },
          name: { type: "string", properties: { ignored: { type: "string" } }, required: ["ignored"] },
        },
      }),
    ).toEqual({
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["1", "2"] },
        tags: { type: "array", items: { type: "string" } },
        name: { type: "string" },
      },
    })
  })

  test("openai keeps one flat object top-level schema", () => {
    expect(
      ToolSchemaProjection.openAI({
        anyOf: [
          {
            type: "object",
            properties: {
              path: { type: "string" },
              maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
          },
          { type: "object", properties: { resource: { type: "string" } } },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        maybe: { type: "string" },
        resource: { type: "string" },
      },
      additionalProperties: false,
    })
  })

  test("model compatibility forces a provider-safe object root", () => {
    expect(ToolSchemaProjection.modelCompatibility({ properties: {} }, undefined)).toEqual({
      type: "object",
      properties: {},
    })
    expect(
      ToolSchemaProjection.modelCompatibility(
        {
          anyOf: [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "object", properties: { b: { type: "number" } } },
          ],
        },
        undefined,
      ),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      additionalProperties: false,
    })
    expect(
      ToolSchemaProjection.modelCompatibility({ oneOf: [{ type: "object", properties: { a: { type: "string" } } }] }, undefined),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    })
  })

  test("model compatibility leaves a valid object root untouched", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    }
    expect(ToolSchemaProjection.modelCompatibility(schema, undefined)).toBe(schema)
  })

  it.effect("normalizes a malformed tool schema before an Anthropic request", () =>
    Effect.gen(function* () {
      const model = AnthropicMessages.route.with({ auth: Auth.header("x-api-key", "test") }).model({
        id: "claude-haiku-4-5",
      })
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.request({
          model,
          prompt: "Use the tool.",
          tools: [
            { name: "typeless", description: "No root type.", inputSchema: {} },
            {
              name: "combinator",
              description: "Top-level anyOf.",
              inputSchema: { anyOf: [{ type: "object", properties: { a: { type: "string" } } }] },
            },
          ],
        }),
      )

      expect(prepared.body.tools?.[0]?.input_schema).toEqual({ type: "object" })
      expect(prepared.body.tools?.[1]?.input_schema).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: false,
      })
    }),
  )

  it.effect("applies model compatibility before protocol projection", () =>
    Effect.gen(function* () {
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
        .model({ id: "kimi-k2", compatibility: { toolSchema: "moonshot" } })
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          prompt: "Use the tool.",
          tools: [
            {
              name: "lookup",
              description: "Lookup data.",
              inputSchema: {
                type: "object",
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
                      linked: { $ref: "#/$defs/Linked", description: "drop me" },
                    },
                  },
                ],
              },
            },
          ],
        }),
      )

      expect(prepared.body.tools?.[0]?.function.parameters).toEqual({
        type: "object",
        properties: {
          tuple: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
          linked: { $ref: "#/$defs/Linked" },
        },
        additionalProperties: false,
      })
    }),
  )
})
