import { GoogleAccount } from "../google-account"
import { Schema } from "effect"

const RemoteModels = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      displayName: Schema.optional(Schema.String),
      maxTokens: Schema.optional(Schema.Number),
      maxOutputTokens: Schema.optional(Schema.Number),
      supportsImages: Schema.optional(Schema.Boolean),
      supportsThinking: Schema.optional(Schema.Boolean),
      disabled: Schema.optional(Schema.Boolean),
      selectable: Schema.optional(Schema.Boolean),
    }),
  ),
})

export async function models(
  access: string,
  projectID: string,
  options: GoogleAccount.Options = GoogleAccount.defaults,
  signal?: AbortSignal,
) {
  const result = Schema.decodeUnknownSync(RemoteModels)(
    await GoogleAccount.request(access, "fetchAvailableModels", { project: projectID }, options, signal),
  )
  return Object.entries(result.models)
    .filter(([id, model]) => id.startsWith("gemini-") && !model.disabled && model.selectable !== false)
    .map(([id, model]) => ({ id, ...model }))
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Cloud Code uses a protobuf Schema, not the public API's JSON-schema field. */
export function toolSchema(value: unknown, root: unknown = value, refs: readonly string[] = []): unknown {
  if (!isRecord(value)) return value
  if (typeof value.$ref === "string") {
    const ref = value.$ref
    if (!ref.startsWith("#/") || refs.includes(ref) || refs.length >= 20)
      throw new Error("Google account tools require a finite local JSON schema")
    const found = ref
      .slice(2)
      .split("/")
      .reduce<unknown>(
        (item, key) => (isRecord(item) ? item[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined),
        root,
      )
    if (!found) throw new Error("Unresolved Google account tool schema reference")
    return toolSchema(found, root, [...refs, ref])
  }
  const removed = new Set([
    "$schema",
    "$id",
    "$defs",
    "definitions",
    "additionalProperties",
    "$comment",
    "examples",
    "default",
  ])
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (removed.has(key)) continue
    if (key === "type" && typeof item === "string") {
      result.type = item.toUpperCase()
      continue
    }
    if (key === "type" && Array.isArray(item)) {
      const types = item.filter((part): part is string => typeof part === "string" && part !== "null")
      if (item.includes("null")) result.nullable = true
      if (types.length === 1) result.type = types[0].toUpperCase()
      else result.anyOf = types.map((type) => ({ type: type.toUpperCase() }))
      continue
    }
    if (key === "properties" && isRecord(item)) {
      result.properties = Object.fromEntries(
        Object.entries(item).map(([name, schema]) => [name, toolSchema(schema, root, refs)]),
      )
      continue
    }
    if (key === "items") {
      result.items = toolSchema(item, root, refs)
      continue
    }
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(item)) {
      result[key] = item.map((schema) => toolSchema(schema, root, refs))
      continue
    }
    if (key === "const") {
      result.enum = [item]
      continue
    }
    result[key] = item
  }
  if (result.type === "ARRAY" && !result.items) result.items = { type: "STRING" }
  return result
}

export function modelFetch(
  access: string,
  projectID: string,
  options: GoogleAccount.Options = GoogleAccount.defaults,
): typeof fetch {
  return Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
    const source = new URL(request.url)
    const match = /\/models\/([^/]+):(streamGenerateContent|generateContent)$/.exec(source.pathname)
    if (request.method !== "POST" || !match)
      throw new Error("Google account transport only accepts Gemini generation requests")
    const model = decodeURIComponent(match[1])
    if (!model.startsWith("gemini-")) throw new Error("The Google account provider exposes only Gemini models")
    const payload: unknown = await request.json()
    if (!isRecord(payload)) throw new Error("Invalid Gemini request body")
    // Request provider-authored summaries alongside tool calls; keep explicit settings.
    const generation = isRecord(payload.generationConfig) ? payload.generationConfig : {}
    const thinking = isRecord(generation.thinkingConfig) ? generation.thinkingConfig : {}
    payload.generationConfig = { ...generation, thinkingConfig: { includeThoughts: true, ...thinking } }
    if (isRecord(payload.systemInstruction)) payload.systemInstruction = { ...payload.systemInstruction, role: "user" }
    if (Array.isArray(payload.tools))
      payload.tools = payload.tools.map((tool: unknown) => {
        if (!isRecord(tool) || !Array.isArray(tool.functionDeclarations)) return tool
        return {
          ...tool,
          functionDeclarations: tool.functionDeclarations.map((declaration: unknown) => {
            if (!isRecord(declaration)) throw new Error("Invalid Google tool declaration")
            const schema = declaration.parametersJsonSchema ?? declaration.parameters
            return {
              name: declaration.name,
              ...(typeof declaration.description === "string" ? { description: declaration.description } : {}),
              ...(schema === undefined ? {} : { parameters: toolSchema(schema) }),
            }
          }),
        }
      })
    const streaming = match[2] === "streamGenerateContent"
    const response = await fetch(`${options.baseURL}/v1internal:${match[2]}${streaming ? "?alt=sse" : ""}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
        "User-Agent": options.userAgent,
      },
      body: JSON.stringify({
        project: projectID,
        model,
        request: payload,
        requestType: "agent",
        userAgent: "antigravity",
        requestId: `agent-${crypto.randomUUID()}`,
      }),
      signal: request.signal,
      redirect: "error",
    })
    if (!response.ok) throw await rejection(response, "model request")
    if (!streaming) {
      const data: unknown = await response.json()
      if (!isRecord(data) || !isRecord(data.response)) throw new Error("Google returned an invalid generation envelope")
      return Response.json(data.response)
    }
    if (!response.body) throw new Error("Google returned an empty generation stream")
    let pending = ""
    const line = (value: string) => {
      if (!value.startsWith("data:")) return value + "\n"
      const text = value.slice(5).trim()
      if (!text || text === "[DONE]") return value + "\n"
      const data: unknown = JSON.parse(text)
      if (!isRecord(data)) throw new Error("Google returned an invalid stream frame")
      return `data: ${JSON.stringify(isRecord(data.response) ? data.response : data)}\n`
    }
    const body = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new TransformStream<string, string>({
          transform(part, controller) {
            pending += part
            let end = pending.indexOf("\n")
            while (end >= 0) {
              controller.enqueue(line(pending.slice(0, end).replace(/\r$/, "")))
              pending = pending.slice(end + 1)
              end = pending.indexOf("\n")
            }
            if (pending.length > 4 * 1024 * 1024) throw new Error("Google stream frame exceeds the supported size")
          },
          flush(controller) {
            if (pending) controller.enqueue(line(pending))
          },
        }),
      )
      .pipeThrough(new TextEncoderStream())
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } })
  }, { preconnect: () => {} })
}

// Preserve machine-readable rejection evidence without exposing arbitrary
// provider text, which can contain credential or project details.
async function rejection(response: Response, operation: string) {
  const body: unknown = await response.json().catch(() => undefined)
  const details = isRecord(body) && isRecord(body.error) && Array.isArray(body.error.details) ? body.error.details : []
  const reason = details
    .flatMap((entry) => (isRecord(entry) && typeof entry.reason === "string" ? [entry.reason] : []))
    .find((value) =>
      [
        "RATE_LIMIT_EXCEEDED",
        "RATE_LIMITED",
        "QUOTA_EXHAUSTED",
        "QUOTA_EXCEEDED",
        "RESOURCE_EXHAUSTED",
        "MODEL_CAPACITY_EXHAUSTED",
        "CAPACITY_EXHAUSTED",
      ].includes(value),
    )
  const retry = response.headers.get("retry-after")
  const headerDelay =
    retry === null ? undefined : /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()
  const detailDelay = details.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.retryDelay !== "string") return []
    const match = /^(\d+(?:\.\d+)?)s$/.exec(entry.retryDelay)
    return match ? [Number(match[1]) * 1000] : []
  })[0]
  const delay = headerDelay ?? detailDelay
  return new GoogleAccount.RequestError(
    operation,
    response.status,
    reason,
    delay !== undefined && Number.isFinite(delay) && delay >= 0 && delay <= 86_400_000 ? delay : undefined,
  )
}
