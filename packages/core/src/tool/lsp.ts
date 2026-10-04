/**
 * Model-facing V2 LSP navigation leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths require external_directory approval before any file
 * content is read or any request reaches a language server.
 */
export * as LspTool from "./lsp"

import { ToolFailure } from "@miao/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { LSP } from "../lsp"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "lsp"

export const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

export const Input = Schema.Struct({
  operation: Schema.Literals(operations).annotate({ description: "The LSP operation to perform" }),
  filePath: Schema.String.annotate({
    description:
      "File path to operate on. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
  }),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The line number (1-based, as shown in editors)",
  }),
  character: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The character offset (1-based, as shown in editors)",
  }),
  query: Schema.String.pipe(Schema.optional).annotate({
    description: "Search query for workspaceSymbol. Empty string requests all symbols.",
  }),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  operation: Schema.String,
  filePath: Schema.String.pipe(Schema.optional),
  line: Schema.Number.pipe(Schema.optional),
  character: Schema.Number.pipe(Schema.optional),
  query: Schema.String.pipe(Schema.optional),
  result: Schema.Array(Schema.Unknown),
})
export type Output = typeof Output.Type

export const description = `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: List project-wide symbols matching a query string
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

All operations require:
- filePath: The file to operate on
- line: The line number (1-based, as shown in editors)
- character: The character offset (1-based, as shown in editors)

workspaceSymbol also accepts:
- query: A query string to filter symbols by. Empty string requests all symbols.

For workspaceSymbol, filePath is not sent in the LSP workspace/symbol request. It is used by miao to select and start the matching LSP server.

Note: LSP servers must be configured for the file type. If no server is available, an error will be returned.`

export const toModelOutput = (output: Output) =>
  output.result.length === 0 ? `No results found for ${output.operation}` : JSON.stringify(output.result, null, 2)

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const lsp = yield* LSP.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) => {
            const unable = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              effect.pipe(
                Effect.mapError(
                  () => new ToolFailure({ message: `Unable to perform ${input.operation} on ${input.filePath}` }),
                ),
              )
            const source = {
              type: "tool" as const,
              messageID: context.assistantMessageID,
              callID: context.toolCallID,
            }

            return Effect.gen(function* () {
              const target = yield* unable(mutation.resolve({ path: input.filePath, kind: "file" }))
              const external = target.externalDirectory
              if (external)
                yield* unable(
                  permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  }),
                )

              // The cursor is only meaningful for position operations; the V1
              // prompt omitted it from documentSymbol and workspaceSymbol.
              const cursor =
                input.operation === "documentSymbol" || input.operation === "workspaceSymbol"
                  ? {}
                  : { line: input.line, character: input.character }
              const promptPath = input.operation === "workspaceSymbol" ? {} : { filePath: target.canonical }
              yield* unable(
                permission.assert({
                  action: name,
                  resources: ["*"],
                  save: ["*"],
                  metadata: { operation: input.operation, ...promptPath, ...cursor },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                }),
              )

              // Existence and server probes happen only after approval so a
              // caller without permission cannot learn anything about the path.
              const exists = yield* fs.existsSafe(target.canonical)
              if (!exists) return yield* new ToolFailure({ message: `File not found: ${input.filePath}` })
              const available = yield* lsp.hasClients(target.canonical)
              if (!available) return yield* new ToolFailure({ message: "No LSP server available for this file type." })

              const position = { file: target.canonical, line: input.line - 1, character: input.character - 1 }
              const result = yield* ((): Effect.Effect<ReadonlyArray<unknown>, LSP.RequestUnavailableError> => {
                switch (input.operation) {
                  case "goToDefinition":
                    return lsp.definition(position)
                  case "findReferences":
                    return lsp.references(position)
                  case "hover":
                    return lsp.hover(position)
                  case "documentSymbol":
                    return lsp.documentSymbol(target.canonical)
                  case "workspaceSymbol":
                    return lsp.workspaceSymbol(target.canonical, input.query ?? "")
                  case "goToImplementation":
                    return lsp.implementation(position)
                  case "prepareCallHierarchy":
                    return lsp.prepareCallHierarchy(position)
                  case "incomingCalls":
                    return lsp.incomingCalls(position)
                  case "outgoingCalls":
                    return lsp.outgoingCalls(position)
                  default:
                    return Effect.die(new Error("Unsupported LSP operation"))
                }
              })().pipe(
                Effect.mapError(
                  (error) =>
                    new ToolFailure({
                      message: `No language server answered ${input.operation}${
                        error.servers.length > 0 ? ` (tried ${[...new Set(error.servers)].join(", ")})` : ""
                      }.`,
                    }),
                ),
              )

              return {
                operation: input.operation,
                ...promptPath,
                ...cursor,
                ...(input.operation === "workspaceSymbol" ? { query: input.query ?? "" } : {}),
                result,
              } satisfies Output
            })
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/lsp",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, LSP.node],
})
