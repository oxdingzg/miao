import { createHash } from "node:crypto"
import type { Schema } from "effect"
import { BlackboxTape } from "@miao/core/blackbox/tape"

export function captureWireProfile(input: {
  protocol: "openai-chat" | "openai-responses" | "anthropic" | "gemini"
  request: unknown
  agent: unknown
  permissions: unknown
  endpoint?: string
}) {
  const request = BlackboxTape.json(input.request)
  const agent = BlackboxTape.json(input.agent)
  const permissions = BlackboxTape.json(input.permissions)
  if (!BlackboxTape.isObject(request)) throw new Error("Missing actual provider request")
  if (!BlackboxTape.isObject(agent) || typeof agent.name !== "string" || !agent.name)
    throw new Error("Missing explicit agent descriptor")
  if (!BlackboxTape.isObject(permissions)) throw new Error("Missing effective permission descriptor")
  const endpointModel =
    input.protocol === "gemini" && input.endpoint
      ? /\/models\/([^/:]+):streamGenerateContent$/.exec(new URL(input.endpoint).pathname)?.[1]
      : undefined
  const model = input.protocol === "gemini" ? endpointModel : request.model
  if (typeof model !== "string" || !model) throw new Error("Missing on-wire model identity")
  const instructions = Object.fromEntries(
    Object.entries(request).filter(([key]) => ["system", "instructions", "systemInstruction"].includes(key)),
  )
  const messages = Array.isArray(request.messages)
    ? request.messages
    : Array.isArray(request.input)
      ? request.input
      : []
  const roles = messages.filter(
    (message) => BlackboxTape.isObject(message) && (message.role === "system" || message.role === "developer"),
  )
  const parameters = Object.fromEntries(
    Object.entries(request).filter(
      ([key]) =>
        !["model", "messages", "input", "contents", "system", "instructions", "systemInstruction", "tools"].includes(
          key,
        ),
    ),
  )
  return {
    model: input.protocol === "gemini" ? decodeURIComponent(model) : model,
    modelParametersHash: fingerprint({ protocol: input.protocol, parameters }),
    agentManifestHash: fingerprint({ agent, instructions, roles }),
    permissionHash: fingerprint(permissions),
    toolSurfaceHash: fingerprint({
      protocol: input.protocol,
      present: "tools" in request,
      tools: request.tools ?? null,
    }),
  }
}

/** Only object key order is canonicalized; array order and every value survive. */
function fingerprint(value: Schema.Json): string {
  return createHash("sha256").update(BlackboxTape.canonical(value)).digest("hex")
}

export * as EngineWireProfile from "./wire-profile"
