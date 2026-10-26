export * as Tool from "./tool"

import { ToolDefinition, ToolFailure, ToolOutput, type ToolCall } from "@miao/llm"
import { Effect, JsonSchema, Schema } from "effect"
import type { AgentV2 } from "../agent"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"

export interface Context {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  /**
   * Optional bounded running-tool checkpoint. The registry forwards this to the
   * Session as a `session.next.tool.progress` event. Tools should checkpoint
   * semantic transitions, not every output chunk.
   */
  readonly progress?: (update: Progress) => Effect.Effect<void>
}

export type Progress = {
  readonly structured?: Record<string, unknown>
  readonly content?: ReadonlyArray<Content>
}

export type SchemaType<A> = Schema.Codec<A, any, never, never>

declare const TypeId: unique symbol

export interface Definition<Input extends SchemaType<any>, Output extends SchemaType<any>> {
  readonly [TypeId]: {
    readonly _Input: Input
    readonly _Output: Output
  }
}

export type AnyTool = Definition<any, any>
export const Failure = ToolFailure
export type Failure = ToolFailure

export class RegistrationError extends Schema.TaggedErrorClass<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }

type Config<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
  Structured extends SchemaType<any> = Output,
> = {
  readonly description: string
  readonly input: Input
  readonly output: Output
  readonly structured?: Structured
  readonly toStructuredOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => Schema.Schema.Type<Structured>
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    context: Context,
  ) => Effect.Effect<Schema.Schema.Type<Output>, ToolFailure>
  readonly toModelOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => ReadonlyArray<Content>
  /**
   * Alternative spellings for one input field, keyed by the canonical name.
   * A call that names the same value differently is moved onto the canonical
   * field before decoding instead of being rejected for its field name.
   */
  readonly aliases?: Readonly<Record<string, ReadonlyArray<string>>>
}

/**
 * How a tool's calls in one provider turn relate to each other.
 *
 * `exclusive` calls are serialized against every other exclusive call in the
 * same turn. `concurrent` calls never acquire the permit and never block, so a
 * concurrent tool can overlap an exclusive one — including observing a file
 * while an `edit` is halfway through writing it. Declaring a tool concurrent
 * asserts that overlapping it with anything else is safe; it is not a promise
 * that the tool only reads.
 */
export type Concurrency = "exclusive" | "concurrent"

type Runtime = {
  readonly permission?: string
  readonly permissionAliases?: ReadonlyArray<string>
  /**
   * Marks the tool's permission action as explicit: a bare `*` action rule can
   * neither grant nor hide it. Its whole-tool visibility and execution are
   * decided only by rules that name the action. Used for control actions such
   * as the plan-mode switches, which a catch-all `allow` must not re-enable.
   */
  readonly permissionExplicit?: boolean
  /**
   * Absent means `exclusive`. Undeclared tools — including plugin and MCP
   * tools, whose internals Core cannot inspect — therefore fail closed.
   */
  readonly concurrency?: Concurrency
  readonly definition: (name: string) => ToolDefinition
  readonly settle: (call: ToolCall, context: Context) => Effect.Effect<ToolOutput, ToolFailure>
}

const runtimes = new WeakMap<AnyTool, Runtime>()

export function make<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
  Structured extends SchemaType<any> = Output,
>(config: Config<Input, Output, Structured>): Definition<Input, Structured> {
  const tool = Object.freeze({}) as Definition<Input, Structured>
  const definitions = new Map<string, ToolDefinition>()
  let inputSchema: JsonSchema.JsonSchema | undefined
  runtimes.set(tool, {
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: parametersSchema(toJsonSchema(config.input)),
        outputSchema: toJsonSchema(config.structured ?? config.output),
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) =>
      Schema.decodeUnknownEffect(config.input)(
        repairInput(call.input, config.aliases, (inputSchema ??= toJsonSchema(config.input))),
      ).pipe(
        Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
        Effect.flatMap((input) =>
          config.execute(input, context).pipe(
            Effect.flatMap((output) =>
              Schema.encodeEffect(config.output)(output).pipe(
                Effect.flatMap((output) => {
                  if (!config.structured || !config.toStructuredOutput)
                    return Effect.succeed({ output, structured: output })
                  return Schema.encodeEffect(config.structured)(config.toStructuredOutput({ input, output })).pipe(
                    Effect.map((structured) => ({ output, structured })),
                  )
                }),
                Effect.mapError(
                  (error) =>
                    new ToolFailure({
                      message: `Tool returned an invalid value for its output schema: ${error.message}`,
                    }),
                ),
              ),
            ),
            Effect.map(({ output, structured }) => ({
              structured,
              content:
                config.toModelOutput?.({ input, output }).map((part) =>
                  part.type === "text"
                    ? { type: "text" as const, text: part.text }
                    : {
                        type: "file" as const,
                        uri: `data:${part.mime};base64,${part.data}`,
                        mime: part.mime,
                        name: part.name,
                      },
                ) ?? (typeof output === "string" ? [{ type: "text" as const, text: output }] : []),
            })),
          ),
        ),
      ),
  })
  return tool
}

/**
 * Builds a canonical tool from a raw JSON Schema input instead of an Effect
 * Schema. Used for tools whose schema comes from an external system (MCP).
 */
export function makeExternal(config: {
  readonly description: string
  readonly inputSchema: JsonSchema.JsonSchema
  readonly outputSchema?: JsonSchema.JsonSchema
  /** Further action names whose whole-tool deny rules also hide this tool. */
  readonly permissionAliases?: ReadonlyArray<string>
  readonly execute: (
    input: Record<string, unknown>,
    context: Context,
  ) => Effect.Effect<ReadonlyArray<Content>, ToolFailure>
}): AnyTool {
  const tool = Object.freeze({}) as Definition<any, any>
  const definitions = new Map<string, ToolDefinition>()
  runtimes.set(tool, {
    permissionAliases: config.permissionAliases,
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: config.inputSchema,
        outputSchema: config.outputSchema,
        // Never serialized to a provider; lets materialization tell remote
        // catalogs (MCP, plugins) from resident local tools.
        metadata: { external: true },
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) => {
      const input = typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {}
      return config.execute(input, context).pipe(
        Effect.map((parts) => ({
          structured: {},
          content: parts.map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: part.text }
              : {
                  type: "file" as const,
                  uri: `data:${part.mime};base64,${part.data}`,
                  mime: part.mime,
                  name: part.name,
                },
          ),
        })),
      )
    },
  })
  return tool
}

/**
 * Repair the one class of malformed call that is unambiguous: a model writing
 * a number or boolean as a string (`"timeout": "300000"`) or naming a field a
 * second way. The tool's own JSON schema still decides everything else, so an
 * input the schema already accepts is passed through untouched, and a string
 * the schema itself allows there is never rewritten.
 */
function repairInput(
  input: unknown,
  aliases: Readonly<Record<string, ReadonlyArray<string>>> | undefined,
  schema: JsonSchema.JsonSchema,
): unknown {
  return repair(applyAliases(input, aliases), schema, definitionsOf(schema))
}

function applyAliases(
  input: unknown,
  aliases: Readonly<Record<string, ReadonlyArray<string>>> | undefined,
): unknown {
  if (!aliases || !isRecord(input)) return input
  const next = { ...input }
  let changed = false
  for (const [canonical, spellings] of Object.entries(aliases)) {
    if (canonical in next) continue
    const spelling = spellings.find((alias) => alias in next)
    if (spelling === undefined) continue
    next[canonical] = next[spelling]
    delete next[spelling]
    changed = true
  }
  return changed ? next : input
}

type Definitions = Readonly<Record<string, JsonSchema.JsonSchema>>

const definitionsOf = (schema: JsonSchema.JsonSchema): Definitions => {
  const defs = schema.$defs
  return isRecord(defs) ? (defs as Definitions) : {}
}

function repair(value: unknown, schema: JsonSchema.JsonSchema, defs: Definitions): unknown {
  if (!isRecord(schema)) return value
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.startsWith("#/$defs/") ? schema.$ref.slice("#/$defs/".length) : undefined
    const target = name === undefined ? undefined : defs[name]
    return target === undefined ? value : repair(value, target, defs)
  }
  const branches = [
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
  ].filter(isRecord)
  if (branches.length > 0) return repairBranch(value, branches, defs)
  if (isRecord(value) && isRecord(schema.properties)) return repairProperties(value, schema.properties, defs)
  const items = schema.items
  if (Array.isArray(value) && isRecord(items)) return value.map((item) => repair(item, items, defs))
  return coerce(value, schema)
}

function repairBranch(value: unknown, branches: ReadonlyArray<JsonSchema.JsonSchema>, defs: Definitions): unknown {
  // A branch that admits the value as written needs no repair; when the value
  // is composite, repair its nested positions against that same branch.
  const matching = branches.filter((branch) => admits(value, branch, defs))
  if (matching.length > 0) return isRecord(value) || Array.isArray(value) ? repair(value, matching[0], defs) : value
  return branches.map((branch) => repair(value, branch, defs)).find((repaired) => repaired !== value) ?? value
}

function repairProperties(
  value: Record<string, unknown>,
  properties: Record<string, unknown>,
  defs: Definitions,
): Record<string, unknown> {
  let changed = false
  const next = { ...value }
  for (const [key, field] of Object.entries(properties)) {
    if (!(key in value) || !isRecord(field)) continue
    const repaired = repair(value[key], field, defs)
    if (repaired === value[key]) continue
    next[key] = repaired
    changed = true
  }
  return changed ? next : value
}

/** Whether a schema node accepts the value exactly as written, type and enum. */
function admits(value: unknown, schema: JsonSchema.JsonSchema, defs: Definitions): boolean {
  if (!isRecord(schema)) return false
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.startsWith("#/$defs/") ? schema.$ref.slice("#/$defs/".length) : undefined
    const target = name === undefined ? undefined : defs[name]
    return target === undefined ? false : admits(value, target, defs)
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false
  if (schema.const !== undefined && schema.const !== value) return false
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : []
  if (types.length === 0) return true
  return types.some((type) => admitsType(value, type))
}

function admitsType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string"
    case "number":
    case "integer":
      return typeof value === "number"
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    case "array":
      return Array.isArray(value)
    case "object":
      return isRecord(value)
    default:
      return true
  }
}

function coerce(value: unknown, schema: JsonSchema.JsonSchema): unknown {
  if (typeof value !== "string") return value
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : []
  const text = value.trim()
  if (!types.includes("string") && types.some((type) => type === "number" || type === "integer")) {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return value
    const number = Number(text)
    return Number.isFinite(number) ? number : value
  }
  if (!types.includes("string") && types.includes("boolean")) {
    const lower = text.toLowerCase()
    if (lower === "true") return true
    if (lower === "false") return false
  }
  return value
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const validateName = (name: string) =>
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
    ? Effect.void
    : Effect.fail(new RegistrationError({ name, message: `Invalid tool name: ${name}` }))

export const withPermission = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  permission: string,
  options?: { readonly explicit?: boolean },
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), permission, permissionExplicit: options?.explicit })
  return decorated
}

/**
 * Declares how this tool's calls relate to other calls in the same provider
 * turn. Undeclared tools are exclusive; only declare `concurrent` when the tool
 * is safe to overlap with any other tool.
 */
export const withConcurrency = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  concurrency: Concurrency,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), concurrency })
  return decorated
}

export const permissions = (tool: AnyTool, name: string) => {
  const runtime = runtimeOf(tool)
  return [runtime.permission ?? name, ...(runtime.permissionAliases ?? [])]
}

export const permissionExplicit = (tool: AnyTool) => runtimeOf(tool).permissionExplicit === true
export const concurrency = (tool: AnyTool): Concurrency => runtimeOf(tool).concurrency ?? "exclusive"
export const definition = (name: string, tool: AnyTool) => runtimeOf(tool).definition(name)
export const settle = (tool: AnyTool, call: ToolCall, context: Context) => runtimeOf(tool).settle(call, context)

function runtimeOf(tool: AnyTool) {
  const runtime = runtimes.get(tool)
  if (!runtime) throw new TypeError("Invalid Core Tool value")
  return runtime
}

function toJsonSchema(schema: Schema.Top): JsonSchema.JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}

/** Effect lowers an empty `Schema.Struct({})` to `anyOf: [object, array]`, and
 * a no-field input is the common shape for zero-argument tools. OpenAI-compatible
 * function calling requires a tool's `parameters` to be a JSON Schema of
 * `type: "object"` at the top level and rejects the whole request when it is
 * not, so advertise the empty object schema instead of the union. */
function parametersSchema(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema
  const record = schema as Record<string, unknown>
  if (record.type !== undefined || !Array.isArray(record.anyOf)) return schema
  const branches = record.anyOf as ReadonlyArray<unknown>
  const objectOrArray =
    branches.length === 2 &&
    branches.every(
      (branch) =>
        typeof branch === "object" &&
        branch !== null &&
        ["object", "array"].includes((branch as { type?: unknown }).type as string),
    )
  if (!objectOrArray) return schema
  const rest = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "anyOf"))
  return { ...rest, type: "object", properties: (rest.properties as unknown) ?? {} }
}
