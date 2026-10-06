export * as ToolRegistry from "./registry"

import { ToolDefinition, ToolOutput, type ToolCall, type ToolResultValue } from "@miao/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { ToolCodeMode } from "./code-mode"
import { ToolSearch } from "./tool-search"
import {
  concurrency,
  definition,
  permissions,
  permissionExplicit,
  settle,
  validateName,
  type AnyTool,
  type Concurrency,
  type Progress,
  type RegistrationError,
} from "./tool"
import { ToolPlugins } from "./plugins"
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
  /** Defer external tool schemas above a budget behind a stable `tool_search` tool. */
  readonly disclosure?: boolean
  /** Tool names disclosure must keep advertised. */
  readonly alwaysLoad?: ReadonlyArray<string>
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
  /**
   * The effective concurrency class of the tool call `name` would settle, after
   * the same scope precedence `settle` applies. Unknown names are exclusive.
   */
  readonly concurrency: (name: string) => Concurrency
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
    const plugins = yield* ToolPlugins.Service
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
      const prepared = yield* runBefore(input)
      if ("result" in prepared) return prepared
      const call = prepared.call
      const pending = yield* settle(registration.tool, call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        ...(onProgress === undefined ? {} : { progress: (update) => onProgress(input, update) }),
      }).pipe(
        Effect.flatMap((output) => runAfter(input, call, output)),
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

    // V2 `tool.execute.before`: hooks may replace the raw input or reject the call.
    const runBefore = (input: ExecuteInput) => {
      if (!plugins.has("before")) return Effect.succeed({ call: input.call })
      return plugins
        .runBefore({
          tool: input.call.name,
          sessionID: input.sessionID,
          callID: input.call.id,
          agent: input.agent,
          args: input.call.input,
        })
        .pipe(
          Effect.map((event) => ({
            call: event.args === input.call.input ? input.call : { ...input.call, input: event.args },
          })),
          Effect.catchTag("LLM.ToolFailure", (failure) =>
            Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
          ),
        )
    }

    // V2 `tool.execute.after`: hooks see the model-facing text and the structured
    // output, and may replace either before the output is bounded and persisted.
    const runAfter = (input: ExecuteInput, call: ToolCall, output: ToolOutput) => {
      if (!plugins.has("after")) return Effect.succeed(output)
      const text =
        output.content.length === 0
          ? (JSON.stringify(output.structured) ?? "")
          : output.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      return plugins
        .runAfter({
          tool: call.name,
          sessionID: input.sessionID,
          callID: call.id,
          agent: input.agent,
          args: call.input,
          title: "",
          output: text,
          metadata: output.structured,
        })
        .pipe(
          Effect.map((event) =>
            event.output === text && event.metadata === output.structured
              ? output
              : ToolOutput.make(
                  event.metadata,
                  event.output === text
                    ? output.content
                    : [
                        { type: "text" as const, text: event.output },
                        ...output.content.filter((part) => part.type !== "text"),
                      ],
                ),
          ),
        )
    }

    // V2 `tool.definition`: hooks may rewrite the description and input schema
    // the model sees. Without hooks the cached definition is reused unchanged.
    const hookDefinition = (definition: ToolDefinition) => {
      if (!plugins.has("definition")) return Effect.succeed(definition)
      return plugins
        .runDefinition({
          tool: definition.name,
          description: definition.description,
          parameters: definition.inputSchema,
        })
        .pipe(
          Effect.map((event) =>
            event.description === definition.description && event.parameters === definition.inputSchema
              ? definition
              : new ToolDefinition({
                  ...definition,
                  description: event.description,
                  inputSchema: event.parameters as ToolDefinition["inputSchema"],
                }),
          ),
        )
    }

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
        // Custom tools load on first demand rather than during Location boot.
        yield* plugins.ready
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
          if (whollyDisabled(permissions(registration.tool, name), rules, permissionExplicit(registration.tool)))
            registrations.delete(name)
        for (const name of options?.disabledTools ?? []) registrations.delete(name)
        const orderKey = options?.sessionID ?? "@location"
        const ordered = stableToolOrder(advertisedOrder.get(orderKey) ?? [], Array.from(registrations.keys()))
        advertisedOrder.set(orderKey, ordered)
        const definitions = yield* Effect.forEach(
          ordered.flatMap((name) => {
            const registration = registrations.get(name)
            return registration ? [definition(name, registration.tool)] : []
          }),
          hookDefinition,
        )
        const inner: Materialization = {
          definitions,
          // Reads the same map `settle` resolves against, so a session-scoped
          // registration's class wins over the location one for free.
          concurrency: (name) => {
            const registration = registrations.get(name)
            return registration ? concurrency(registration.tool) : "exclusive"
          },
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
        // Disclosure defers large remote catalogs behind one stable search tool
        // instead of advertising every schema. Deferred tools stay registered,
        // so a call by name settles exactly like an advertised one. It and
        // Code Mode are alternative strategies; Code Mode wins when both on.
        if (!options?.codeMode && options?.disclosure === true && definitions.length > 0) {
          // Remote definitions above this advertised budget (roughly 10k
          // tokens) defer behind `tool_search`. Once the budget is exhausted
          // every later external tool defers too, keeping the cut stable for
          // a given registration set.
          const disclosureBudget = 40_000
          let externalBytes = 0
          const resident: ToolDefinition[] = []
          const deferred: ToolDefinition[] = []
          for (const item of definitions) {
            if (item.metadata?.external !== true || options?.alwaysLoad?.includes(item.name) === true) {
              resident.push(item)
              continue
            }
            const size = JSON.stringify(item).length
            if (externalBytes + size > disclosureBudget) {
              deferred.push(item)
              continue
            }
            externalBytes += size
            resident.push(item)
          }
          if (deferred.length > 0) {
            const search = ToolSearch.make({ deferred })
            if (!whollyDisabled(permissions(search, ToolSearch.TOOL_SEARCH_TOOL), rules)) {
              const searchRegistration: Registration = { identity: {}, tool: search }
              return {
                definitions: [...resident, definition(ToolSearch.TOOL_SEARCH_TOOL, search)],
                concurrency: (name) => (name === ToolSearch.TOOL_SEARCH_TOOL ? "exclusive" : inner.concurrency(name)),
                settle: (input) =>
                  input.call.name === ToolSearch.TOOL_SEARCH_TOOL
                    ? settleRegistration(input, searchRegistration, searchRegistration.identity, options?.onProgress)
                    : inner.settle(input),
              }
            }
          }
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
          // A code-mode script runs its inner tools inline on the outer fiber, so
          // the inner classes never fork and cannot be honored individually. The
          // script serializes as one unit under the `execute` tool's own class.
          concurrency: (name) =>
            name === ToolCodeMode.CODE_MODE_TOOL ? concurrency(execute) : inner.concurrency(name),
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

function whollyDisabled(actions: ReadonlyArray<string>, rules: PermissionV2.Ruleset, explicit = false) {
  // An explicit action is decided only by rules that name it: a bare `*` rule
  // must not hide it here any more than it may grant it at execution time.
  const considered = explicit ? rules.filter((rule) => rule.action !== "*") : rules
  const rule = considered.findLast((rule) => actions.some((action) => Wildcard.match(action, rule.action)))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node, ToolPlugins.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node, ToolPlugins.node],
})
