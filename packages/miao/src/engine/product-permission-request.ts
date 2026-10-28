import { Option, Schema } from "effect"
import { Permission } from "@miao/schema/permission"
import type { EngineEvent } from "./client"
import { adoptSession, messageID } from "./identity"

export class Source extends Schema.Class<Source>("Engine.ProductPermissionSource")({
  session_id: Schema.String,
  bridge_id: Schema.Number,
  call_id: Schema.String,
  message_seq: Schema.Number,
}) {}

class Facts extends Schema.Class<Facts>("Engine.ProductPermissionFacts")({
  actions: Schema.Array(Schema.String),
  resources: Schema.Array(Schema.String),
}) {}

class Input extends Schema.Class<Input>("Engine.ProductPermissionInput")({
  request_id: Schema.String,
  facts: Facts,
  save: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  metadata: Schema.optional(Schema.Unknown),
}) {}

export class Info extends Schema.Class<Info>("Engine.ProductPermissionRequest")({
  id: Schema.String,
  source: Source,
  workspace: Schema.String,
  request: Input,
  input_hash: Schema.String,
  authority_revision: Schema.String,
  state: Schema.Literals(["pending", "allowed", "denied", "cancelled", "expired"]),
  reply: Schema.optional(Schema.NullOr(Permission.Reply)),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  feedback: Schema.optional(Schema.NullOr(Schema.String)),
  denial: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        effect: Schema.Literal("deny"),
        rules: Permission.Ruleset,
        authority_revision: Schema.String,
      }),
    ),
  ),
}) {}

export function parse(value: unknown, sessionID: string) {
  const info = Option.getOrUndefined(Schema.decodeUnknownOption(Info)(value))
  if (
    !info ||
    info.source.session_id !== sessionID ||
    info.id !== info.request.request_id ||
    !info.id ||
    !info.source.call_id ||
    !info.workspace ||
    !Number.isSafeInteger(info.source.bridge_id) ||
    info.source.bridge_id <= 0 ||
    !Number.isSafeInteger(info.source.message_seq) ||
    info.source.message_seq <= 0 ||
    !/^[a-f0-9]{64}$/.test(info.input_hash) ||
    !/^[a-f0-9]{64}$/.test(info.authority_revision) ||
    (info.denial != null && !/^[a-f0-9]{64}$/.test(info.denial.authority_revision)) ||
    info.request.facts.actions.length === 0 ||
    info.request.facts.resources.length === 0
  )
    return undefined
  return info
}

/** Input hashes include the runtime owner, source and logical request id. */
export function id(info: Info) {
  return Permission.ID.make(`per_host_${info.input_hash}`)
}

export function request(info: Info): Permission.Request {
  const metadata = info.request.metadata
  return {
    id: id(info),
    sessionID: adoptSession(info.source.session_id),
    action: info.request.facts.actions[0],
    resources: [...info.request.facts.resources],
    ...(info.request.save ? { save: [...info.request.save] } : {}),
    metadata: {
      ...(typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) ? metadata : {}),
      nativeHostPermission: { requestID: info.id },
    },
    source: {
      type: "tool",
      messageID: messageID(info.source.session_id, info.source.message_seq),
      callID: info.source.call_id,
    },
  }
}

export function asked(event: EngineEvent) {
  if (event.kind !== "product.permission.requested") return undefined
  const info = parse(event.data, event.session_id)
  if (!info || info.state !== "pending") return undefined
  return request(info)
}

export function replied(event: EngineEvent) {
  if (event.kind !== "product.permission.resolved") return undefined
  const info = parse(event.data, event.session_id)
  if (!info || info.state === "pending") return undefined
  if (info.state === "allowed" && info.reply !== "once" && info.reply !== "always") return undefined
  return {
    sessionID: adoptSession(info.source.session_id),
    requestID: id(info),
    reply: info.state === "allowed" ? info.reply! : ("reject" as const),
  }
}

export * as ProductPermissionRequest from "./product-permission-request"
