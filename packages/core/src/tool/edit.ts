/**
 * Model-facing V2 exact-edit leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as EditTool from "./edit"

import { ToolFailure } from "@miao/llm"
import { FileDiff } from "@miao/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Lint } from "../lint"
import { Format } from "../format"
import { FileMutation } from "../file-mutation"
import { EditMatch } from "./edit-match"
import { LSP } from "../lsp"
import { LSPClient } from "../lsp/client"
import { Diagnostic } from "../lsp/diagnostic"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "edit"

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to edit. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
  }),
  oldString: Schema.String.annotate({ description: "Exact text to replace" }),
  newString: Schema.String.annotate({ description: "Replacement text, which must differ from oldString" }),
  replaceAll: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Replace all exact occurrences of oldString (default false)",
  }),
})

export const Output = Schema.Struct({
  files: Schema.Array(FileDiff.Info),
  replacements: Schema.Number,
  diagnostics: Schema.String.pipe(Schema.optional),
  lint: Schema.String.pipe(Schema.optional),
})
export type Output = typeof Output.Type

const normalizeLineEndings = (text: string) => text.replaceAll("\r\n", "\n")
const detectLineEnding = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n")
const convertToLineEnding = (text: string, ending: "\n" | "\r\n") =>
  ending === "\n" ? normalizeLineEndings(text) : normalizeLineEndings(text).replaceAll("\n", "\r\n")

const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const joinBom = (text: string, bom: boolean) => (bom ? `\uFEFF${text}` : text)
const decodeUtf8 = (content: Uint8Array) => {
  const bom = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
  return { bom, content, text: new TextDecoder().decode(bom ? content.slice(3) : content) }
}

const previewPatch = (patch: string | undefined) => {
  const lines = normalizeLineEndings(patch ?? "")
    .split("\n")
    .filter(
      (line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")),
    )
  const shown = lines.slice(0, 12).map((line) => (line.length > 240 ? `${line.slice(0, 240)}...` : line))
  return lines.length > shown.length ? [...shown, "..."] : shown
}

export const toModelOutput = (output: Output) =>
  [
    `Edited file successfully: ${output.files[0]?.file}`,
    `Replacements: ${output.replacements}`,
    "```diff",
    ...previewPatch(output.files[0]?.patch),
    "```",
  ]
    .concat(output.diagnostics ? ["", "LSP errors detected in this file, please fix:", output.diagnostics] : [])
    .concat(output.lint ? ["", "Lint errors detected in this file, please fix:", output.lint] : [])
    .join("\n")

/** Deferred V2 edit behavior and UX integrations remain visible at the model-facing seam. */
// TODO: Review block-anchor similarity thresholds as more real edits are observed.
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
              "Replace exact text in one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) => {
              const unableToEdit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.mapError((error) =>
                    error instanceof FileMutation.StaleContentError
                      ? new ToolFailure({
                          message: "File changed after permission approval. Read it again before editing.",
                        })
                      : new ToolFailure({ message: `Unable to edit ${input.path}` }),
                  ),
                )

              return Effect.gen(function* () {
                const permissionSource = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (input.oldString === input.newString) {
                  return yield* new ToolFailure({
                    message: "No changes to apply: oldString and newString are identical.",
                  })
                }
                if (input.oldString === "") {
                  return yield* new ToolFailure({
                    message: "oldString must not be empty. Use write to create or overwrite a file.",
                  })
                }

                const target = yield* unableToEdit(mutation.resolve({ path: input.path, kind: "file" }))
                const external = target.externalDirectory
                if (external) {
                  yield* unableToEdit(
                    permission.assert({
                      ...LocationMutation.externalDirectoryPermission(external),
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: permissionSource,
                    }),
                  )
                }

                const approve = (diff?: string) =>
                  unableToEdit(
                    permission.assert({
                      action: "edit",
                      resources: [target.resource],
                      save: ["*"],
                      metadata: { filepath: target.canonical, ...(diff === undefined ? {} : { diff }) },
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: permissionSource,
                    }),
                  )
                // The diff is computed before asking so the prompt can show it. A
                // read or match failure is still reported only after approval, so
                // a caller without edit permission cannot probe file contents.
                const read = yield* fs.readFile(target.canonical).pipe(Effect.option)
                if (Option.isNone(read)) {
                  yield* approve()
                  return yield* new ToolFailure({ message: `Unable to edit ${input.path}` })
                }
                const source = decodeUtf8(read.value)
                const planned = plan(source.text, input)
                if (planned instanceof ToolFailure) {
                  yield* approve()
                  return yield* planned
                }
                const replaced = planned.replaced
                const replacements = planned.replacements
                yield* approve(trimDiff(createTwoFilesPatch(target.canonical, target.canonical, source.text, replaced)))
                const next = splitBom(replaced)
                const result = yield* unableToEdit(
                  files.writeIfUnchanged({
                    target,
                    expected: source.content,
                    content: joinBom(next.text, source.bom || next.bom),
                  }),
                )
                yield* format.file(target.canonical).pipe(Effect.ignore)
                const final = decodeUtf8(yield* unableToEdit(fs.readFile(target.canonical))).text
                const counts = diffLines(source.text, final).reduce(
                  (result, item) => ({
                    additions: result.additions + (item.added ? (item.count ?? 0) : 0),
                    deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
                  }),
                  { additions: 0, deletions: 0 },
                )
                yield* lsp.touchFile(target.canonical, "document").pipe(Effect.ignore)
                const diagnostics = yield* lsp.diagnostics()
                const report = Diagnostic.report(
                  target.resource,
                  diagnostics[LSPClient.fileURI(target.canonical)] ?? [],
                )
                const lintReport = (yield* lint.file(target.canonical))
                  .map((failure) => `<linter ${failure.name}>\n${failure.message}`)
                  .join("\n\n")
                return {
                  ...(report ? { diagnostics: report } : {}),
                  ...(lintReport.length > 0 ? { lint: lintReport } : {}),
                  files: [
                    {
                      file: result.resource,
                      patch: createTwoFilesPatch(result.resource, result.resource, source.text, final),
                      status: "modified" as const,
                      ...counts,
                    },
                  ],
                  replacements,
                } satisfies Output
              })
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/edit",
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

/** The replaced text and match count, or the failure the model should see. */
function plan(text: string, input: typeof Input.Type) {
  const ending = detectLineEnding(text)
  const newString = convertToLineEnding(input.newString, ending)
  const oldString = convertToLineEnding(input.oldString, ending)
  const replaceAll = input.replaceAll === true
  const matched = EditMatch.match(text, oldString, replaceAll)
  if (matched._tag === "none")
    return new ToolFailure({
      message: "Could not find oldString in the file. It must match exactly, including whitespace and indentation.",
    })
  if (matched._tag === "ambiguous")
    return new ToolFailure({
      message:
        "Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true.",
    })
  if (matched._tag === "disproportionate")
    return new ToolFailure({
      message:
        "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.",
    })
  return {
    replaced: replaceAll ? text.replaceAll(matched.find, newString) : text.replace(matched.find, newString),
    replacements: matched.count,
  }
}

/**
 * Removes the indentation every changed or context line shares, so a deeply
 * nested edit reads well in a permission prompt. Matches the V1 prompt diff.
 */
export function trimDiff(diff: string) {
  const lines = diff.split("\n")
  const body = (line: string) =>
    (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
    !line.startsWith("---") &&
    !line.startsWith("+++")
  const indents = lines
    .filter(body)
    .map((line) => line.slice(1))
    .filter((content) => content.trim().length > 0)
    .map((content) => content.match(/^\s*/)![0].length)
  const min = Math.min(...indents)
  if (indents.length === 0 || min === 0) return diff
  return lines.map((line) => (body(line) ? line[0] + line.slice(1 + min) : line)).join("\n")
}
