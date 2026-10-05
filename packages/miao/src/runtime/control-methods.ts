export * as RuntimeControlMethods from "./control-methods"

import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { Database } from "@miao/core/database/database"
import { RemoteOperations } from "@miao/core/runtime/operations"
import { SessionInput } from "@miao/core/session/input"
import { SessionMessage } from "@miao/core/session/message"
import { Agent } from "@miao/schema/agent"
import { Model } from "@miao/schema/model"
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
  const mutation =
    <A>(
      schema: Schema.Decoder<A, never>,
      apply: (payload: A, request: ControlAgent.Request, context: ControlAgent.Context) => Promise<void>,
    ): ControlAgent.Handler =>
    async (request, context) => {
      const decoded = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(request.payload)
      if (Option.isNone(decoded) || !request.operationID) throw new ControlAgent.RequestError("invalid_request")
      const subject = createHash("sha256").update(`${context.grant.id}:${context.grant.publicKey}`).digest("hex")
      const id = request.operationID
      const key = `${subject}:${id}`
      const digest = createHash("sha256").update(JSON.stringify(decoded.value)).digest("hex")
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
          if (prepared.type === "existing") {
            if (prepared.record.status !== "prepared") return prepared.record.result
            // A crash can occur between the authoritative mutation and its receipt.
            // Never automatically replay an approval or interrupt into a new run.
            const unknown = { status: "outcome_unknown" }
            await query((db) => RemoteOperations.settle(db, subject, id, "outcome_unknown", unknown))
            return unknown
          }
          try {
            context.authorize()
            await apply(decoded.value, request, context)
          } catch (error) {
            const status = error instanceof ControlAgent.RequestError ? "rejected" : "outcome_unknown"
            const result = { status, ...(error instanceof ControlAgent.RequestError ? { code: error.code } : {}) }
            await query((db) => RemoteOperations.settle(db, subject, id, status, result))
            return result
          }
          const result = { status: "completed" }
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
    }
  const methods: Partial<Record<ControlAgent.Method, ControlAgent.Handler>> = {
    "selection.list": async (request, context) => {
      const decoded = Schema.decodeUnknownOption(Schema.Struct({ directoryID: Schema.optional(Schema.String) }), {
        onExcessProperty: "error",
      })(request.payload)
      if (Option.isNone(decoded)) throw new ControlAgent.RequestError("invalid_request")
      const location = await (async () => {
        if (request.sessionID) {
          const session = await options.client.sessions.get(
            { sessionID: request.sessionID },
            { signal: context.signal },
          )
          context.authorize()
          if (!context.grant.sessionIDs.includes(session.id) && !context.grant.projectIDs.includes(session.projectID))
            throw new ControlAgent.RequestError("forbidden")
          if (request.projectID && request.projectID !== session.projectID)
            throw new ControlAgent.RequestError("forbidden")
          return session.location
        }
        if (!request.projectID || !context.grant.projectIDs.includes(request.projectID))
          throw new ControlAgent.RequestError("forbidden")
        const registered = await options.client.projects.directories(
          { projectID: request.projectID },
          { signal: context.signal },
        )
        context.authorize()
        const directory = registered.data.find(
          (entry) => directoryID(request.projectID!, entry.directory) === decoded.value.directoryID,
        )?.directory
        if (!directory) throw new ControlAgent.RequestError("forbidden")
        return { directory }
      })()
      const results = await Promise.all([
        options.client.agents.list({ location }, { signal: context.signal }),
        options.client.models.list({ location }, { signal: context.signal }),
      ])
      context.authorize()
      // Provider settings, request headers and agent system prompts stay local.
      return {
        agents: results[0].data
          .filter((agent) => !agent.hidden && agent.mode !== "subagent")
          .map((agent) => ({ id: agent.id, description: agent.description, color: agent.color, model: agent.model })),
        models: results[1].data.map((model) => ({
          id: model.id,
          providerID: model.providerID,
          name: model.name,
          capabilities: model.capabilities,
          variants: model.variants.map((variant) => ({ id: variant.id })),
        })),
      }
    },
    "session.rename": mutation(
      Schema.Struct({ title: Schema.String.check(Schema.isLengthBetween(1, 256)) }),
      async (payload, request, context) => {
        context.authorize()
        await options.client.sessions.rename({ sessionID: request.sessionID!, title: payload.title })
      },
    ),
    "session.switchAgent": mutation(Schema.Struct({ agent: Agent.ID }), async (payload, request, context) => {
      context.authorize()
      await options.client.sessions.switchAgent({ sessionID: request.sessionID!, agent: payload.agent })
    }),
    "session.switchModel": mutation(Schema.Struct({ model: Model.Ref }), async (payload, request, context) => {
      context.authorize()
      await options.client.sessions.switchModel({ sessionID: request.sessionID!, model: payload.model })
    }),
    "session.interrupt": mutation(
      Schema.Struct({ executionID: Schema.String.check(Schema.isLengthBetween(1, 128)) }),
      async (payload, request, context) => {
        const execution = await options.client.sessions.execution(
          { sessionID: request.sessionID! },
          { signal: context.signal },
        )
        context.authorize()
        if (execution.type !== "running" || execution.executionID !== payload.executionID)
          throw new ControlAgent.RequestError("conflict")
        await options.client.sessions.interruptIf({ sessionID: request.sessionID!, executionID: payload.executionID })
      },
    ),
    "permission.reply": mutation(
      Schema.Struct({ requestID: Schema.String, reply: Schema.Literals(["once", "reject"]) }),
      async (payload, request, context) => {
        const pending = await options.client.permissions.list(
          { sessionID: request.sessionID! },
          { signal: context.signal },
        )
        context.authorize()
        if (!pending.some((entry) => entry.id === payload.requestID)) throw new ControlAgent.RequestError("not_found")
        await options.client.permissions.reply({
          sessionID: request.sessionID!,
          requestID: payload.requestID,
          reply: payload.reply,
        })
      },
    ),
    "question.reply": mutation(
      Schema.Struct({
        requestID: Schema.String,
        answers: Schema.optional(
          Schema.Array(
            Schema.Array(Schema.String.check(Schema.isMaxLength(16384))).check(Schema.isMaxLength(32)),
          ).check(Schema.isMaxLength(32)),
        ),
        reject: Schema.optional(Schema.Boolean),
      }),
      async (payload, request, context) => {
        if ((payload.reject === true) === (payload.answers !== undefined))
          throw new ControlAgent.RequestError("invalid_request")
        const pending = await options.client.questions.list(
          { sessionID: request.sessionID! },
          { signal: context.signal },
        )
        context.authorize()
        if (!pending.some((entry) => entry.id === payload.requestID)) throw new ControlAgent.RequestError("not_found")
        if (payload.reject)
          return options.client.questions.reject({ sessionID: request.sessionID!, requestID: payload.requestID })
        await options.client.questions.reply({
          sessionID: request.sessionID!,
          requestID: payload.requestID,
          answers: payload.answers!,
        })
      },
    ),
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
      events: "long-poll",
      methods: Object.keys(methods),
      promptDelivery: ["steer", "queue"],
    }),
    "session.get": (request, context) =>
      options.client.sessions.get({ sessionID: request.sessionID! }, { signal: context.signal }),
    "session.events": async (request, context) => {
      const decoded = Schema.decodeUnknownOption(
        Schema.Struct({
          after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
          waitMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
        }),
        { onExcessProperty: "error" },
      )(request.payload)
      if (Option.isNone(decoded)) throw new ControlAgent.RequestError("invalid_request")
      const input = { sessionID: request.sessionID!, after: decoded.value.after, limit: decoded.value.limit ?? 100 }
      const initial = await options.client.sessions.history(input, { signal: context.signal })
      context.authorize()
      const waitMs = decoded.value.waitMs ?? 1000
      if (!initial.data.length && waitMs > 0) {
        const stop = new AbortController()
        const timer = setTimeout(() => stop.abort(), waitMs)
        const iterator = options.client.sessions
          .events(
            { sessionID: input.sessionID, after: input.after },
            { signal: AbortSignal.any([context.signal, stop.signal]) },
          )
          [Symbol.asyncIterator]()
        try {
          // Local SSE replays from the same cursor before listening for live
          // events, closing the gap between this history read and subscription.
          await iterator.next()
        } catch (error) {
          if (!stop.signal.aborted || context.signal.aborted) throw error
        } finally {
          clearTimeout(timer)
          stop.abort()
          await iterator.return?.()
        }
      }
      context.authorize()
      const page = initial.data.length
        ? initial
        : await options.client.sessions.history(input, { signal: context.signal })
      context.authorize()
      const cursor = page.data.reduce((cursor, event) => {
        if (!event.durable || event.durable.seq <= cursor) throw new ControlAgent.RequestError("conflict")
        return event.durable.seq
      }, input.after)
      return { ...page, cursor }
    },
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
