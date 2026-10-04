export * as RuntimeControlMethods from "./control-methods"

import { createHash } from "node:crypto"
import path from "node:path"
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
    "project.list": async (_request, context) => {
      const projects = await options.client.projects.list(undefined, { signal: context.signal })
      context.authorize()
      return {
        data: await Promise.all(
          projects.data
            .filter((project) => context.grant.projectIDs.includes(project.id))
            .map(async (project) => {
              const registered = await options.client.projects.directories(
                { projectID: project.id },
                { signal: context.signal },
              )
              context.authorize()
              return {
                id: project.id,
                name: project.name,
                vcs: project.vcs,
                directories: registered.data.map((entry) => ({
                  id: directoryID(project.id, entry.directory),
                  name: path.basename(entry.directory),
                })),
              }
            }),
        ),
      }
    },
    "session.create": async (request, context) => {
      const decoded = Schema.decodeUnknownOption(
        Schema.Struct({ directoryID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)) }),
        { onExcessProperty: "error" },
      )(request.payload)
      if (Option.isNone(decoded) || !request.operationID || !request.projectID)
        throw new ControlAgent.RequestError("invalid_request")
      const projectID = request.projectID
      if (!context.grant.projectIDs.includes(projectID)) throw new ControlAgent.RequestError("forbidden")
      const registered = await options.client.projects.directories({ projectID }, { signal: context.signal })
      context.authorize()
      const directory = registered.data.find(
        (entry) => directoryID(projectID, entry.directory) === decoded.value.directoryID,
      )?.directory
      if (!directory) throw new ControlAgent.RequestError("forbidden")
      const actual = await options.client.projects.current({ location: { directory } }, { signal: context.signal })
      context.authorize()
      if (actual.data.id !== projectID) throw new ControlAgent.RequestError("conflict")
      const subject = createHash("sha256").update(`${context.grant.id}:${context.grant.publicKey}`).digest("hex")
      const id = request.operationID
      const key = `${subject}:${id}`
      const sessionID = `ses_remote_${createHash("sha256").update(key).digest("hex")}`
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
              session_id: sessionID,
              project_id: projectID,
              digest: decoded.value.directoryID,
            }),
          )
          if (prepared.type === "conflict") throw new ControlAgent.RequestError("conflict")
          if (prepared.type === "existing" && prepared.record.status !== "prepared") return prepared.record.result
          context.authorize()
          // Core adopts an existing ID; creation itself never starts provider work.
          const session = await options.client.sessions.create({ id: sessionID, location: { directory } })
          if (session.projectID !== projectID) throw new ControlAgent.RequestError("conflict")
          const result = { status: "completed", session }
          await query((db) => RemoteOperations.settle(db, subject, id, "completed", result))
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
    "session.list": async (request, context) => {
      const page = Schema.decodeUnknownOption(
        Schema.Struct({
          cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
          limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
        }),
        { onExcessProperty: "error" },
      )(request.payload)
      if (Option.isNone(page)) throw new ControlAgent.RequestError("invalid_request")
      if (request.projectID) {
        if (!context.grant.projectIDs.includes(request.projectID)) throw new ControlAgent.RequestError("forbidden")
        const sessions = await options.client.sessions.list(
          { project: request.projectID, limit: page.value.limit ?? 100, cursor: page.value.cursor },
          { signal: context.signal },
        )
        context.authorize()
        return { ...sessions, data: sessions.data.filter((session) => session.projectID === request.projectID) }
      }
      // Session-only grants must not enumerate sibling Sessions in their project.
      // Their cursor is an index into the stable, owner-approved ID list.
      const offset = page.value.cursor === undefined ? 0 : Number(page.value.cursor)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > context.grant.sessionIDs.length)
        throw new ControlAgent.RequestError("invalid_request")
      const ids = context.grant.sessionIDs.slice(offset, offset + (page.value.limit ?? 100))
      const sessions = await Promise.all(
        ids.map((sessionID) =>
          options.client.sessions.get({ sessionID }, { signal: context.signal }).catch((error: unknown) => {
            if (error && typeof error === "object" && "_tag" in error && error._tag === "SessionNotFoundError")
              return undefined
            throw error
          }),
        ),
      )
      context.authorize()
      return {
        data: sessions.filter((session) => session !== undefined),
        cursor: { next: offset + ids.length < context.grant.sessionIDs.length ? String(offset + ids.length) : null },
      }
    },
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

function directoryID(projectID: string, directory: string) {
  return createHash("sha256")
    .update(JSON.stringify([projectID, directory]))
    .digest("hex")
}
