export * as ProviderGateway from "./provider-gateway"

import { AISDK } from "./aisdk"
import { ModelV2 } from "./model"
import type { ModelMessage } from "ai"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Effect, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"

/**
 * Host-side provider gateway: when a plugin provider's AI SDK wire is not one
 * of the engine's native transports, the engine still talks OpenAI Chat
 * Completions — to this localhost gateway, which translates the request into
 * the plugin's own `LanguageModel` via AISDK and streams the answer back as
 * Chat Completions SSE. The gateway binds 127.0.0.1, requires a per-engine
 * bearer secret, and never sees engine-side session state; credentials stay
 * inside the plugin SDK exactly like a TypeScript Session.
 */

const TOKEN_ENV = "MIAO_PROVIDER_GATEWAY_TOKEN"

type ChatTool = { type: "function"; function: { name: string; description?: string; parameters?: unknown } }

export const ChatRequestSchema = Schema.Struct({
  model: Schema.optional(Schema.String),
  messages: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.Literal("function"),
        function: Schema.Struct({
          name: Schema.String,
          description: Schema.optional(Schema.String),
          parameters: Schema.optional(Schema.Unknown),
        }),
      }),
    ),
  ),
  stream: Schema.optional(Schema.Boolean),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  max_tokens: Schema.optional(Schema.Number),
  max_completion_tokens: Schema.optional(Schema.Number),
  stop: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
})
export type ChatRequest = typeof ChatRequestSchema.Type

export interface Gateway {
  /** Register a model and return the `openai-chat` transport that reaches it. */
  readonly route: (model: ModelV2.Info) => { provider: "openai-chat"; endpoint: string }
  /** The env var name the engine must read its bearer secret from. */
  readonly tokenEnv: string
  readonly token: string
  readonly close: Effect.Effect<void>
}

export const prepare = Effect.fn("Engine.providerGateway")(function* (aisdk: AISDK.Interface) {
  const models = new Map<string, ModelV2.Info>()
  const token = randomUUID() + randomUUID()

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return json({ error: { message: "gateway authorization failed" } }, 401)
      }
      const url = new URL(request.url)
      const parts = url.pathname.split("/").filter(Boolean)
      if (request.method !== "POST" || parts.length !== 3 || parts[2] !== "chat/completions") {
        return json({ error: { message: "gateway accepts POST /:provider/:model/chat/completions" } }, 404)
      }
      const info = models.get(`${decodeURIComponent(parts[0])}/${decodeURIComponent(parts[1])}`)
      if (!info) return json({ error: { message: "unknown gateway model" } }, 404)
      const body = (await request.json().catch(() => undefined)) as ChatRequest | undefined
      if (!body) return json({ error: { message: "invalid JSON body" } }, 400)
      if (body.stream === false) {
        return json({ error: { message: "the gateway streams only" } }, 400)
      }
      try {
        return await completions(aisdk, info, body, request.signal)
      } catch (error) {
        return json({ error: { message: error instanceof Error ? error.message : String(error) } }, 500)
      }
    },
  })

  return {
    route: (model: ModelV2.Info) => {
      const key = `${model.providerID}/${model.id}`
      models.set(key, model)
      const base = server.url.href.replace(/\/$/, "")
      return {
        provider: "openai-chat" as const,
        endpoint: `${base}/${encodeURIComponent(model.providerID)}/${encodeURIComponent(model.id)}/chat/completions`,
      }
    },
    tokenEnv: TOKEN_ENV,
    token,
    close: Effect.promise(() => server.stop(true)),
  } satisfies Gateway
})

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const completions = async (
  aisdk: AISDK.Interface,
  info: ModelV2.Info,
  body: ChatRequest,
  signal: AbortSignal | null,
): Promise<Response> => {
  const language = await Effect.runPromise(aisdk.language(info))
  return reply(language, body, signal, `${info.providerID}/${info.id}`)
}

export type ToolSignatures = { get(id: string): string | undefined; set(id: string, value: string): void }

/** Translate a model's stream without running tools or a nested agent loop. */
export const reply = async (
  language: LanguageModelV3,
  body: ChatRequest,
  signal: AbortSignal | null,
  model: string,
  signatures?: ToolSignatures,
): Promise<Response> => {
  const { streamText } = await import("ai")
  const abort = new AbortController()
  const abortSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  let detached = false
  const messages = toModelMessages(body.messages ?? [], signatures)
  const tools = await toTools(body.tools ?? [])
  const result = streamText({
    model: language,
    // The caller owns retries and durable tool admission. SDK retries here
    // otherwise multiply rejected requests behind one native provider turn.
    maxRetries: 0,
    ...(messages.system ? { system: messages.system } : {}),
    messages: messages.conversation,
    ...(tools ? { tools } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { topP: body.top_p } : {}),
    ...(typeof body.max_tokens === "number" ? { maxOutputTokens: body.max_tokens } : {}),
    ...(typeof body.max_completion_tokens === "number" ? { maxOutputTokens: body.max_completion_tokens } : {}),
    ...(body.stop ? { stopSequences: Array.isArray(body.stop) ? body.stop : [body.stop] } : {}),
    abortSignal,
  })
  const id = `chatcmpl-gw-${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 24)}`
  const created = Math.floor(Date.now() / 1000)
  const frame = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: body.model ?? model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const push = (payload: string) => {
        if (!detached) controller.enqueue(encoder.encode(payload))
      }
      let toolIndex = 0
      let finished = "stop"
      try {
        for await (const part of result.fullStream) {
          if (part.type === "text-delta" && part.text) {
            push(frame({ content: part.text }, null))
          } else if (part.type === "reasoning-delta" && part.text) {
            push(frame({ reasoning_content: part.text }, null))
          } else if (part.type === "tool-call") {
            const google = part.providerMetadata?.google
            if (google && typeof google.thoughtSignature === "string")
              signatures?.set(part.toolCallId, google.thoughtSignature)
            push(
              frame(
                {
                  tool_calls: [
                    {
                      index: toolIndex++,
                      id: part.toolCallId,
                      type: "function",
                      function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
                    },
                  ],
                },
                null,
              ),
            )
          } else if (part.type === "finish") {
            finished = part.finishReason === "tool-calls" ? "tool_calls" : "stop"
          } else if (part.type === "error") {
            throw part.error
          }
        }
        const usage = usageOf(await result.usage)
        push(frame({}, finished))
        push(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model ?? model, choices: [], usage })}\n\n`,
        )
        push("data: [DONE]\n\n")
      } catch (error) {
        if (detached || abortSignal.aborted) return
        push(
          `data: ${JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: "gateway_error",
              ...(typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
                ? { status: error.status }
                : {}),
              ...(typeof error === "object" &&
              error !== null &&
              "statusCode" in error &&
              typeof error.statusCode === "number"
                ? { status: error.statusCode }
                : {}),
            },
          })}\n\n`,
        )
        push("data: [DONE]\n\n")
      } finally {
        if (!detached) controller.close()
      }
    },
    cancel(reason) {
      detached = true
      abort.abort(reason)
    },
  })
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  })
}

export const toModelMessages = (history: ReadonlyArray<Record<string, unknown>>, signatures?: ToolSignatures) => {
  const system: string[] = []
  const conversation: ModelMessage[] = []
  const toolNames = new Map<string, string>()
  for (const message of history) {
    const role = typeof message["role"] === "string" ? message["role"] : ""
    if (role === "system") {
      if (typeof message["content"] === "string") system.push(message["content"])
      continue
    }
    if (role === "user") {
      const content = message["content"]
      if (typeof content === "string") {
        conversation.push({ role: "user", content })
        continue
      }
      const parts: Array<Record<string, unknown>> = []
      for (const part of Array.isArray(content) ? content : []) {
        const type = part?.["type"]
        if (type === "text" && typeof part["text"] === "string") parts.push({ type: "text", text: part["text"] })
        if (type === "image_url" && typeof part?.["image_url"] === "object" && part["image_url"] !== null) {
          const url = (part["image_url"] as { url?: unknown }).url
          if (typeof url === "string" && url.startsWith("data:")) {
            const match = /^data:([^;]+);base64,(.*)$/s.exec(url)
            if (match) parts.push({ type: "file", mediaType: match[1], data: match[2] })
          }
        }
      }
      conversation.push({ role: "user", content: parts } as unknown as ModelMessage)
      continue
    }
    if (role === "assistant") {
      const parts: Array<Record<string, unknown>> = []
      if (typeof message["reasoning_content"] === "string" && message["reasoning_content"]) {
        parts.push({ type: "reasoning", text: message["reasoning_content"] })
      }
      if (typeof message["content"] === "string" && message["content"]) {
        parts.push({ type: "text", text: message["content"] })
      }
      for (const call of Array.isArray(message["tool_calls"])
        ? (message["tool_calls"] as Array<Record<string, unknown>>)
        : []) {
        const fn = call["function"] as { name?: unknown; arguments?: unknown } | undefined
        if (typeof call["id"] !== "string" || typeof fn?.name !== "string") continue
        toolNames.set(call["id"], fn.name)
        let input: unknown = {}
        if (typeof fn.arguments === "string") {
          try {
            input = JSON.parse(fn.arguments)
          } catch {
            input = { raw: fn.arguments }
          }
        }
        const signature = !parts.some((part) => part.type === "tool-call") ? signatures?.get(call["id"]) : undefined
        parts.push({
          type: "tool-call",
          toolCallId: call["id"],
          toolName: fn.name,
          input,
          ...(signature ? { providerOptions: { google: { thoughtSignature: signature } } } : {}),
        })
      }
      conversation.push({ role: "assistant", content: parts } as unknown as ModelMessage)
      continue
    }
    if (role === "tool") {
      const toolCallId = typeof message["tool_call_id"] === "string" ? message["tool_call_id"] : ""
      const output = typeof message["content"] === "string" ? message["content"] : ""
      conversation.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: toolNames.get(toolCallId) ?? toolCallId,
            output: { type: "text", value: output },
          },
        ],
      } as unknown as ModelMessage)
    }
  }
  return { system: system.join("\n"), conversation }
}

const toTools = async (tools: readonly ChatTool[] | undefined) => {
  if (!tools || tools.length === 0) return undefined
  const { tool, jsonSchema } = await import("ai")
  return Object.fromEntries(
    tools
      .filter((entry) => entry.type === "function" && entry.function)
      .map((entry) => [
        entry.function.name,
        tool({
          description: entry.function.description,
          inputSchema: jsonSchema((entry.function.parameters ?? {}) as never),
        }),
      ]),
  )
}

export const usageOf = (raw: unknown) => {
  const record = (raw ?? {}) as Record<string, unknown>
  const total = (value: unknown): number | undefined => {
    if (typeof value === "number") return value
    if (value && typeof value === "object" && typeof (value as Record<string, unknown>).total === "number") {
      return (value as Record<string, unknown>).total as number
    }
    return undefined
  }
  const input = total(record.inputTokens) ?? total(record.promptTokens) ?? total(record.prompt_tokens)
  const output = total(record.outputTokens) ?? total(record.completionTokens) ?? total(record.completion_tokens)
  const cached = total(
    (record.inputTokens as Record<string, unknown> | undefined)?.cacheRead ??
      (record.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens,
  )
  const reasoning = total(
    (record.outputTokens as Record<string, unknown> | undefined)?.reasoning ??
      (record.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens,
  )
  const prompt_tokens = input ?? 0
  const completion_tokens = output ?? 0
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
    ...(reasoning === undefined ? {} : { completion_tokens_details: { reasoning_tokens: reasoning } }),
  }
}
