/**
 * Model-facing V2 file-write leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as WriteTool from "./write"

import { ToolFailure } from "@miao/llm"
import { FileDiff } from "@miao/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import { FSUtil } from "../fs-util"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Format } from "../format"
import { Lint } from "../lint"
import { FileMutation } from "../file-mutation"
import { LSP } from "../lsp"
import { LSPClient } from "../lsp/client"
import { Diagnostic } from "../lsp/diagnostic"
import { trimDiff } from "./edit"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "write"

// TODO: Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.
export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to write. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
  }),
  content: Schema.String.annotate({ description: "Content to write to the file" }),
})

export const Output = Schema.Struct({
  operation: Schema.Literal("write"),
  target: Schema.String,
  resource: Schema.String,
  existed: Schema.Boolean,
  files: Schema.Array(FileDiff.Info),
  diagnostics: Schema.String.pipe(Schema.optional),
  lint: Schema.String.pipe(Schema.optional),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  `${output.existed ? "Wrote" : "Created"} file successfully: ${output.resource}` +
  (output.diagnostics ? `\n\nLSP errors detected in this file, please fix:\n${output.diagnostics}` : "") +
  (output.lint ? `\n\nLint errors detected in this file, please fix:\n${output.lint}` : "")

/** Deferred V2 write UX integrations remain visible at the model-facing seam. */
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after design exists.

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const lint = yield* Lint.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Write content to one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const target = yield* mutation.resolve({ path: input.path, kind: "file" })
                const external = target.externalDirectory
                if (external)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                // Read the current content only to show the change in the prompt;
                // a missing or unreadable file previews as a new one.
                const previous = yield* fs.readFileString(target.canonical).pipe(
                  Effect.map((text) => text.replace(/^﻿/, "")),
                  Effect.orElseSucceed(() => ""),
                )
                yield* permission.assert({
                  action: "edit",
                  resources: [target.resource],
                  save: ["*"],
                  metadata: {
                    filepath: target.canonical,
                    diff: trimDiff(createTwoFilesPatch(target.canonical, target.canonical, previous, input.content)),
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                const result = yield* files.writeTextPreservingBom({ target, content: input.content })
                yield* format.file(target.canonical).pipe(Effect.ignore)
                yield* lsp.touchFile(target.canonical, "document").pipe(Effect.ignore)
                const diagnostics = yield* lsp.diagnostics()
                const report = Diagnostic.report(
                  target.resource,
                  diagnostics[LSPClient.fileURI(target.canonical)] ?? [],
                )
                const lintReport = (yield* lint.file(target.canonical))
                  .map((failure) => `<linter ${failure.name}>\n${failure.message}`)
                  .join("\n\n")
                const content = (yield* fs.readFileString(target.canonical)).replace(/^\uFEFF/, "")
                const counts = diffLines(result.previous, content).reduce(
                  (counts, line) => ({
                    additions: counts.additions + (line.added ? (line.count ?? 0) : 0),
                    deletions: counts.deletions + (line.removed ? (line.count ?? 0) : 0),
                  }),
                  { additions: 0, deletions: 0 },
                )
                return {
                  operation: result.operation,
                  target: result.target,
                  resource: result.resource,
                  existed: result.existed,
                  files: [{
                    file: result.resource,
                    patch: createTwoFilesPatch(result.resource, result.resource, result.previous, content),
                    status: result.existed ? "modified" as const : "added" as const,
                    ...counts,
                  }],
                  ...(report ? { diagnostics: report } : {}),
                  ...(lintReport.length > 0 ? { lint: lintReport } : {}),
                }
              }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to write ${input.path}` }))),
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/write",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FileMutation.node,
    FSUtil.node,
    PermissionV2.node,
    Format.node,
    LSP.node,
    Lint.node,
  ],
})
