export * as RuntimeControlMethods from "./control-methods"

import { createHash } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { Database } from "@miao/core/database/database"
import { RemoteOperations } from "@miao/core/runtime/operations"
import { SessionInput } from "@miao/core/session/input"
import { SessionMessage } from "@miao/core/session/message"
import { OpenCode } from "@miao/client"
import { ControlAgent } from "@miao/remote-control/agent"

const Prompt = Schema.Struct({
  text: Schema.String.check(Schema.isLengthBetween(1, 65536)),
  delivery: Schema.optional(Schema.Literals(["steer", "queue"])),
})

export function make(options: {
  client: ReturnType<typeof OpenCode.make>
  run: <A, E>(effect: Effect.Effect<A, E, Database.Service>) => Promise<A>
}) {
  const tails = new Map<string, Promise<unknown>>()
  const query = <A, E>(use: (db: Database.Interface["db"]) => Effect.Effect<A, E>) =>
    options.run(Database.Service.use((service) => use(service.db)))
  const methods: Partial<Record<ControlAgent.Method, ControlAgent.Handler>> = {
    capabilities: async () => ({
      protocol: 1,
      operationReceipts: true,
      history: "paged",
      methods: Object.keys(methods),
      promptDelivery: ["steer", "queue"],
    }),
    "session.get": (request, context) =>
      options.client.sessions.get({ sessionID: request.sessionID! }, { signal: context.signal }),
    "session.history": async (request, context) => {
      const page = Schema.decodeUnknownOption(
        Schema.Struct({
          after: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
          limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
        }),
        { onExcessProperty: "error" },
      )(request.payload)
      if (Option.isNone(page)) throw new ControlAgent.RequestError("invalid_request")
      return options.client.sessions.history(
        { sessionID: request.sessionID!, after: page.value.after, limit: page.value.limit ?? 100 },
        { signal: context.signal },
      )
    },
    "session.pending": async (request, context) => {
      const input = { sessionID: request.sessionID! }
      const results = await Promise.all([
        options.client.sessions.inputs(input, { signal: context.signal }),
        options.client.permissions.list(input, { signal: context.signal }),
        options.client.questions.list(input, { signal: context.signal }),
        options.client.sessions.execution(input, { signal: context.signal }),
      ])
      context.authorize()
      return { inputs: results[0], permissions: results[1], questions: results[2], execution: results[3] }
    },
    "session.diff": (request, context) =>
      options.client.sessions.diff({ sessionID: request.sessionID! }, { signal: context.signal }),
    "session.prompt": async (request, context) => {
      const decoded = Schema.decodeUnknownOption(Prompt, { onExcessProperty: "error" })(request.payload)
      if (Option.isNone(decoded) || !request.operationID) throw new ControlAgent.RequestError("invalid_request")
      // Normalize before hashing: omission and explicit default mean the same input.
      const payload = { text: decoded.value.text, delivery: decoded.value.delivery ?? "steer" }
      const subject = createHash("sha256").update(`${context.grant.id}:${context.grant.publicKey}`).digest("hex")
      const id = request.operationID
      const key = `${subject}:${id}`
      const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex")
      const messageID = Schema.decodeUnknownSync(SessionMessage.ID)(
        `msg_remote_${createHash("sha256").update(key).digest("hex")}`,
      )
      const previous = tails.get(key) ?? Promise.resolve()
      const pending = previous
        .catch(() => undefined)
        .then(async () => {
          context.authorize()
          const prepared = await query((db) =>
            RemoteOperations.prepare(db, {
              subject,
              id,
              method: request.method,
              session_id: request.sessionID!,
              project_id: request.projectID ?? null,
              digest,
            }),
          )
          if (prepared.type === "conflict") throw new ControlAgent.RequestError("conflict")
          if (prepared.type === "existing" && prepared.record.status !== "prepared") return prepared.record.result
          // A prior admission survives runner crashes. Never wake the runner just
          // because a phone retries an input whose acknowledgement was lost.
          const admitted = await query((db) => SessionInput.find(db, messageID))
          context.authorize()
          const receipt = admitted
            ? {
                id: admitted.id,
                sessionID: admitted.sessionID,
                admittedSeq: admitted.admittedSeq,
              }
            : await options.client.sessions.prompt({
                sessionID: request.sessionID!,
                id: messageID,
                prompt: { text: payload.text },
                delivery: payload.delivery,
              })
          if (receipt.sessionID !== request.sessionID) throw new ControlAgent.RequestError("conflict")
          const result = {
            status: "accepted",
            messageID: receipt.id,
            sessionID: receipt.sessionID,
            admittedSeq: receipt.admittedSeq,
          }
          await query((db) => RemoteOperations.settle(db, subject, id, "accepted", result))
          context.authorize()
          return result
        })
      tails.set(key, pending)
      void pending
        .finally(() => {
          if (tails.get(key) === pending) tails.delete(key)
        })
        .catch(() => undefined)
      return pending
    },
    "operation.get": async (request, context) => {
      const payload = Schema.decodeUnknownOption(Schema.Struct({ operationID: Schema.String }))(request.payload)
      if (Option.isNone(payload)) throw new ControlAgent.RequestError("invalid_request")
      const subject = createHash("sha256").update(`${context.grant.id}:${context.grant.publicKey}`).digest("hex")
      const receipt = await query((db) => RemoteOperations.get(db, subject, payload.value.operationID))
      context.authorize()
      if (!receipt) return { status: "not_admitted" }
      // Receipt disclosure is subject scoped; the grant also has to retain access
      // to its target after an administrator narrows authorization.
      if (receipt.session_id && !context.grant.sessionIDs.includes(receipt.session_id)) {
        const session = await options.client.sessions.get({ sessionID: receipt.session_id }, { signal: context.signal })
        context.authorize()
        if (!context.grant.projectIDs.includes(session.projectID)) throw new ControlAgent.RequestError("forbidden")
      }
      return { status: receipt.status, result: receipt.result, sessionID: receipt.session_id, operationID: receipt.id }
    },
  }
  return methods
}
