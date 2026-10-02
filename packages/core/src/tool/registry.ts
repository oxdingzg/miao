export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@miao/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { ToolCodeMode } from "./code-mode"
import {
  definition,
  permissions,
  settle,
  validateName,
  type AnyTool,
  type Progress,
  type RegistrationError,
} from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
}

export type MaterializeOptions = {
  /** Collapse the tool set behind one `execute` tool with a budgeted Code Mode catalog. */
  readonly codeMode?: boolean
  /** Overlay session-scoped registrations owned by this Session on top of location and application scopes. */
  readonly sessionID?: SessionSchema.ID
  /** Tool names hidden from the model. Filtering happens before ordering so the prefix stays stable. */
  readonly disabledTools?: ReadonlyArray<string>
  /** Receives bounded running-tool checkpoints a tool emits through its context. */
  readonly onProgress?: (input: ExecuteInput, update: Progress) => Effect.Effect<void>
}

export interface Interface {
  readonly materialize: (
    permissions?: PermissionV2.Ruleset,
    options?: MaterializeOptions,
  ) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
  /** Session-scoped registration owned by the runner; highest precedence while its Session drain is active. */
  readonly registerSession: (
    sessionID: SessionSchema.ID,
    tools: Readonly<Record<string, AnyTool>>,
  ) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/ToolRegistry") {}

/**
 * Keep the order in which tool names were first advertised so the serialized
 * tool prefix stays byte-stable across provider turns (research G2). Names that
 * were already seen keep their relative order; names that appear for the first
 * time append at the end. Removing a tool only drops it without reordering the
 * rest.
 */
export function stableToolOrder(previous: readonly string[], current: readonly string[]): string[] {
  const present = new Set(current)
  const ordered = previous.filter((name) => present.has(name))
  const known = new Set(ordered)
  for (const name of current) if (!known.has(name)) ordered.push(name)
  return ordered
}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()
    const sessionLocal = new Map<
      SessionSchema.ID,
      Map<string, Array<{ readonly token: object; readonly registration: Registration }>>
    >()
    // Per-scope memory of first-advertised tool names, so the definitions prefix
    // stays byte-stable across turns even as registrations come and go (G2).
    const advertisedOrder = new Map<string, string[]>()
    const openScope = (
      into: Map<string, Array<{ readonly token: object; readonly registration: Registration }>>,
      tools: Readonly<Record<string, AnyTool>>,
      onEmpty?: () => void,
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const token = {}
          for (const [name, tool] of Object.entries(tools))
            into.set(name, [...(into.get(name) ?? []), { token, registration: { identity: {}, tool } }])
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const name of Object.keys(tools)) {
                const registrations = into.get(name)?.filter((registration) => registration.token !== token) ?? []
                if (registrations.length > 0) into.set(name, registrations)
                else into.delete(name)
              }
              onEmpty?.()
            }),
          )
        }),
      )

    const settleRegistration = Effect.fn("ToolRegistry.settleRegistration")(function* (
      input: ExecuteInput,
      registration: Registration,
      advertised?: object,
      onProgress?: (input: ExecuteInput, update: Progress) => Effect.Effect<void>,
    ) {
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        ...(onProgress === undefined ? {} : { progress: (update) => onProgress(input, update) }),
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* openScope(local, tools)
      }),
      registerSession: Effect.fn("ToolRegistry.registerSession")(function* (sessionID, tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        const into = sessionLocal.get(sessionID) ?? new Map()
        sessionLocal.set(sessionID, into)
        yield* openScope(into, tools, () => {
          if (into.size === 0) {
            sessionLocal.delete(sessionID)
            advertisedOrder.delete(sessionID)
          }
        })
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (rules = [], options?: MaterializeOptions) {
        const registrations = new Map(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        const sessionRegistrations = options?.sessionID ? sessionLocal.get(options.sessionID) : undefined
        if (sessionRegistrations)
          for (const [name, entries] of sessionRegistrations) {
            const registration = entries.at(-1)?.registration
            if (registration) registrations.set(name, registration)
          }
        for (const [name, registration] of registrations)
          if (whollyDisabled(permissions(registration.tool, name), rules)) registrations.delete(name)
        for (const name of options?.disabledTools ?? []) registrations.delete(name)
        const orderKey = options?.sessionID ?? "@location"
        const ordered = stableToolOrder(advertisedOrder.get(orderKey) ?? [], Array.from(registrations.keys()))
        advertisedOrder.set(orderKey, ordered)
        const definitions = ordered.flatMap((name) => {
          const registration = registrations.get(name)
          return registration ? [definition(name, registration.tool)] : []
        })
        const inner: Materialization = {
          definitions,
          settle: (input) => {
            const captured = registrations.get(input.call.name)
            if (!captured)
              return Effect.succeed({ result: { type: "error" as const, value: `Unknown tool: ${input.call.name}` } })
            const now =
              sessionRegistrations?.get(input.call.name)?.at(-1)?.registration ??
              local.get(input.call.name)?.at(-1)?.registration ??
              applications.entries().get(input.call.name)
            if (now !== captured)
              return Effect.succeed({
                result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` },
              })
            return settleRegistration(input, captured, captured.identity, options?.onProgress)
          },
        }
        if (!options?.codeMode || definitions.length === 0) return inner
        const execute = ToolCodeMode.make({
          definitions,
          settle: (call, context) => inner.settle({ ...context, call }),
        })
        if (whollyDisabled(permissions(execute, ToolCodeMode.CODE_MODE_TOOL), rules)) return inner
        const executeRegistration: Registration = { identity: {}, tool: execute }
        return {
          definitions: [definition(ToolCodeMode.CODE_MODE_TOOL, execute)],
          settle: (input) =>
            input.call.name === ToolCodeMode.CODE_MODE_TOOL
              ? settleRegistration(input, executeRegistration, executeRegistration.identity, options?.onProgress)
              : inner.settle(input),
        }
      }),
    })
  }),
)

const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

function whollyDisabled(actions: ReadonlyArray<string>, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => actions.some((action) => Wildcard.match(action, rule.action)))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})
