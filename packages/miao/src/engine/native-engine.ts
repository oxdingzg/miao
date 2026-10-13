import { makeGlobalNode } from "@miao/core/effect/app-node"
import { ClientEvents } from "@miao/server/client-events"
import { NativeEngine } from "@miao/server/native-engine"
import { ConflictError } from "@miao/protocol/errors"
import { Location } from "@miao/schema/location"
import { Effect, Layer, Schema } from "effect"
import { EngineError, type EngineOptions } from "./client"
import { makeEngineOwners } from "./owners"
import { Permission } from "@miao/schema/permission"
import { Question } from "@miao/schema/question"
import { translateApproval, translateQuestion } from "./bridge"

const ApprovalBindings = Schema.Struct({
  approvals: Schema.Array(
    Schema.Struct({
      request_id: Schema.String,
      session_id: Schema.String,
      input_hash: Schema.String,
      policy_revision: Schema.String,
      tool: Schema.String,
      resource: Schema.String,
    }),
  ),
})
const QuestionBindings = Schema.Array(
  Schema.Struct({
    question_id: Schema.String,
    input_hash: Schema.String,
    input: Schema.Unknown,
  }),
)

import { replayJournal } from "./journal"

/**
 * Production native transport, opt-in through the engine binary environment:
 * without `MIAO_ENGINE_BIN` the layer is never built and native-owned Sessions
 * keep the explicit refusal. The model identity is required from the operator
 * because the engine cannot invent provider credentials or catalog facts.
 */
export const nativeEngineOptions = (
  environment: Record<string, string | undefined> = process.env,
): Omit<EngineOptions, "db" | "workspace"> | undefined => {
  const binary = environment.MIAO_ENGINE_BIN
  if (!binary) return undefined
  const limits = environment.MIAO_CONTEXT_LIMITS
  return {
    binary,
    model: environment.MIAO_ENGINE_MODEL ?? "",
    provider: environment.MIAO_ENGINE_PROVIDER,
    endpoint: environment.MIAO_ENGINE_ENDPOINT,
    // A writable workspace is an explicit operator policy, never a blanket
    // change to the engine's read-only default or permission decisions.
    policyFile: environment.MIAO_ENGINE_POLICY,

    contextLimits: limits ? JSON.parse(limits) : undefined,
    // ADR-09: the product's credential database is the explicit channel; the
    // engine only reads it. Named provider keys are the single-key fallback.
    credentialDatabase: environment.MIAO_ENGINE_CREDENTIAL_DB,
    credentialID: environment.MIAO_ENGINE_CREDENTIAL_ID,
    credentialIntegration: environment.MIAO_ENGINE_CREDENTIAL_INTEGRATION,
  }
}

/** Whether the composition root should build the native transport at all. */
export const configured = (): boolean => nativeEngineOptions() !== undefined

const refusal = (sessionID: string, error: unknown) =>
  new ConflictError({
    message:
      error instanceof EngineError
        ? `Native engine rejected admission for ${sessionID}: ${error.message}`
        : `Native engine admission for ${sessionID} failed unexpectedly.`,
    resource: sessionID,
  })

type Owners = Effect.Success<ReturnType<typeof makeEngineOwners>>

/**
 * The transport implementation over a server-scoped owner registry. Kept apart
 * from the layer so tests exercise the exact code the server runs.
 */
export const fromOwners = (owners: Owners): NativeEngine.Interface => {
  const connect = (input: { storage: string; location: Location.Ref }) =>
    owners.get({
      storage: input.storage,
      engineID: input.storage,
      location: input.location,
    })
  const read = <T>(
    input: { storage: string; location: Location.Ref },
    request: (connection: Effect.Success<ReturnType<Owners["get"]>>) => Promise<unknown>,
  ) =>
    connect(input).pipe(
      Effect.flatMap((connection) =>
        Effect.tryPromise({
          try: () => request(connection) as Promise<T>,
          catch: (error) => refusal(input.storage, error),
        }),
      ),
      Effect.mapError((error) => refusal(input.storage, error)),
    )
  return {
    initialize: (input) =>
      read(input, (connection) =>
        connection.client.request("initialize", { session_id: input.sessionID, title: input.title }),
      ).pipe(Effect.asVoid),
    admit: (input) =>
      connect(input).pipe(
        Effect.flatMap((connection) =>
          Effect.tryPromise({
            try: () =>
              connection.session.promptProduct({
                sessionID: input.sessionID,
                prompt: { text: input.prompt.text },
                id: input.id,
                delivery: input.delivery,
                resume: input.resume,
              }),
            catch: (error) => refusal(input.sessionID, error),
          }),
        ),
        Effect.mapError((error) => refusal(input.sessionID, error)),
      ),
    snapshot: (input) =>
      read<Readonly<Record<string, unknown>>>(input, (connection) =>
        connection.client.request("snapshot", { session_id: input.sessionID }),
      ).pipe(Effect.map((value) => (typeof value === "object" && value !== null ? value : {}))),
    interrupt: (input) =>
      read(input, (connection) => connection.client.request("cancel", { session_id: input.sessionID })).pipe(
        Effect.asVoid,
      ),
    rename: (input) =>
      read(input, async (connection) => {
        // Rust's rename can initialize a Session; the product command operates
        // only on an existing owner, so missing identity must fail first.
        await connection.client.request("snapshot", { session_id: input.sessionID })
        return connection.client.request("rename", { session_id: input.sessionID, title: input.title })
      }).pipe(Effect.asVoid),
    permissions: (input) =>
      read<readonly Permission.Request[]>(input, async (connection) => {
        const snapshot = await connection.client.request("snapshot", { session_id: input.sessionID })
        return Schema.decodeUnknownSync(ApprovalBindings)(snapshot).approvals.map((binding) => {
          if (binding.session_id !== input.sessionID)
            throw new EngineError("approval_owner_mismatch", "Approval belongs to another Session")
          return Schema.decodeUnknownSync(Permission.Request)(
            translateApproval({
              session_id: input.sessionID,
              seq: 0,
              kind: "approval.requested",
              data: binding,
            }),
          )
        })
      }),
    replyPermission: (input) =>
      read(input, async (connection) => {
        // An engine allow is once-only. Never silently turn a persistent grant
        // into a one-off approval (or create a TS rule the engine cannot read).
        if (input.reply === "always")
          throw new EngineError(
            "persistent_approval_unavailable",
            "Native approvals are once-only; configure a native policy rule for persistent grants",
          )
        const snapshot = await connection.client.request("snapshot", { session_id: input.sessionID })
        const binding = Schema.decodeUnknownSync(ApprovalBindings)(snapshot).approvals.find(
          (binding) => binding.session_id === input.sessionID && `per_${binding.request_id}` === input.requestID,
        )
        if (!binding) throw new EngineError("approval_not_found", "No pending approval in this Session")
        return connection.client.approve(input.sessionID, {
          request_id: binding.request_id,
          input_hash: binding.input_hash,
          policy_revision: binding.policy_revision,
          decision: input.reply === "once" ? "allow" : "deny",
        })
      }).pipe(Effect.asVoid),
    questions: (input) =>
      read<readonly Question.Request[]>(input, async (connection) => {
        const pending = await connection.client.request("questions", { session_id: input.sessionID })
        return Schema.decodeUnknownSync(QuestionBindings)(pending).map((binding) =>
          Schema.decodeUnknownSync(Question.Request)(
            translateQuestion({
              session_id: input.sessionID,
              seq: 0,
              kind: "question.requested",
              data: binding,
            }),
          ),
        )
      }),
    replyQuestion: (input) =>
      read(input, async (connection) => {
        const pending = await connection.client.request("questions", { session_id: input.sessionID })
        const binding = Schema.decodeUnknownSync(QuestionBindings)(pending).find(
          (binding) => `que_${binding.question_id}` === input.requestID,
        )
        if (!binding) throw new EngineError("question_not_found", "No pending question in this Session")
        return connection.client.answerQuestion(input.sessionID, {
          question_id: binding.question_id,
          input_hash: binding.input_hash,
          answers: input.answers,
        })
      }).pipe(Effect.asVoid),
    sessions: (input) =>
      // `sessions` is a unit command: it takes no params.
      read<readonly unknown[]>(input, (connection) => connection.client.request("sessions")).pipe(
        Effect.map((value) => (Array.isArray(value) ? value : [])),
      ),
    history: (input) =>
      read<NativeEngine.NativeJournalPage & { readonly hasMore: boolean }>(input, (connection) =>
        replayJournal({
          ...input,
          engineID: input.storage,
          request: (method, params) => connection.client.request(method, params),
        }),
      ),
    events: (input) =>
      connect(input).pipe(
        Effect.flatMap((connection) =>
          Effect.tryPromise({
            try: () =>
              replayJournal({
                ...input,
                engineID: input.storage,
                request: (method, params) => connection.client.request(method, params),
              }),
            catch: (error) => refusal(input.sessionID, error),
          }),
        ),
        Effect.mapError((error) => refusal(input.sessionID, error)),
      ),
  }
}
const layer = Layer.effect(
  NativeEngine.Service,
  Effect.gen(function* () {
    const configuration = nativeEngineOptions()
    if (!configuration) return yield* Effect.die("NativeEngine layer built without MIAO_ENGINE_BIN")
    const owners = yield* makeEngineOwners(configuration)
    return fromOwners(owners)
  }),
)

export const node = makeGlobalNode({ service: NativeEngine.Service, layer, deps: [ClientEvents.node] })

export * as NativeEngineNode from "./native-engine"
