export * as ApplyPatchTool from "./apply-patch"

import { ToolFailure } from "@miao/llm"
import { FileDiff } from "@miao/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import path from "path"
import { Effect, Layer, Option, Result, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Format } from "../format"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { LSP } from "../lsp"
import { LSPClient } from "../lsp/client"
import { Diagnostic } from "../lsp/diagnostic"
import { Patch } from "../patch"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { trimDiff } from "./edit"

export const name = "apply_patch"

export const Input = Schema.Struct({
  patchText: Schema.String.annotate({
    description: "The full patch text describing add, update, and delete operations",
  }),
})

export const Applied = Schema.Struct({
  type: Schema.Literals(["add", "update", "delete"]),
  resource: Schema.String,
  target: Schema.String,
})

export const Output = Schema.Struct({
  applied: Schema.Array(Applied),
  files: Schema.Array(FileDiff.Info),
  diagnostics: Schema.String.pipe(Schema.optional),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  [
    "Applied patch sequentially:",
    ...output.applied.map(
      (item) => `${item.type === "add" ? "A" : item.type === "delete" ? "D" : "M"} ${item.resource}`,
    ),
  ]
    .concat(output.diagnostics ? ["", "LSP errors detected in the patched files, please fix:", output.diagnostics] : [])
    .join("\n")

type Prepared =
  | (Extract<Patch.Hunk, { readonly type: "add" | "delete" }> & {
      readonly target: LocationMutation.Target
      readonly before: string
      readonly after: string
    })
  | (Extract<Patch.Hunk, { readonly type: "update" }> & {
      readonly target: LocationMutation.Target
      readonly destination?: LocationMutation.Target
      readonly source: Uint8Array
      readonly content: string | Uint8Array
      readonly binary?: boolean
      readonly before: string
      readonly after: string
    })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Apply one patch containing add, update, and delete file operations. All targets are resolved and external directories approved before target contents are read; the whole patch is then approved, with its diff, before any file changes. Operations apply sequentially; if a later operation fails, earlier operations remain applied and the failure reports them explicitly. File moves preserve the source on destination conflicts; moves and batches are not atomically rolled back.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) => {
              const applied: Array<typeof Applied.Type> = []
              const fail = (path: string) => {
                const prefix =
                  applied.length === 0
                    ? `Unable to apply patch at ${path}`
                    : `Patch partially applied before failing at ${path}. Applied: ${applied.map((item) => item.resource).join(", ")}`
                return new ToolFailure({ message: prefix })
              }
              return Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (!input.patchText.trim()) return yield* new ToolFailure({ message: "patchText is required" })
                const hunks = yield* Effect.try({
                  try: () => Patch.parse(input.patchText),
                  catch: (cause) => new ToolFailure({ message: `apply_patch verification failed: ${String(cause)}` }),
                })
                if (hunks.length === 0) return yield* new ToolFailure({ message: "patch rejected: empty patch" })
                const targets: Array<{
                  readonly hunk: Patch.Hunk
                  readonly target: LocationMutation.Target
                  readonly destination?: LocationMutation.Target
                }> = []
                for (const hunk of hunks)
                  targets.push({
                    hunk,
                    target: yield* mutation.resolve({ path: hunk.path, kind: "file" }),
                    ...(hunk.type === "update" && hunk.movePath !== undefined
                      ? { destination: yield* mutation.resolve({ path: hunk.movePath, kind: "file" }) }
                      : {}),
                  })
                const externalDirectories = new Map<string, LocationMutation.ExternalDirectoryAuthorization>()
                for (const item of targets) {
                  for (const target of [item.target, ...(item.destination ? [item.destination] : [])]) {
                    const external = target.externalDirectory
                    if (external) externalDirectories.set(external.resource, external)
                  }
                }
                for (const external of externalDirectories.values()) {
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                }
                // Contents are read after external_directory approval but before
                // edit approval, so the prompt can show the diff. A preparation
                // failure is reported only after edit approval, so a caller
                // without edit permission cannot probe file contents.
                const preparation = yield* Effect.forEach(targets, (item) =>
                  Effect.gen(function* () {
                    const hunk = item.hunk
                    const target = item.target
                    const same = item.destination?.canonical === target.canonical
                    if (
                      same &&
                      hunk.type === "update" &&
                      path.normalize(hunk.movePath ?? hunk.path) !== path.normalize(hunk.path)
                    )
                      return yield* new ToolFailure({
                        message:
                          "Move endpoints resolve to the same file through different spellings or aliases; no rename was applied.",
                      })
                    const destination = same ? undefined : item.destination
                    if (destination) {
                      const endpoints = new Set([target.canonical, destination.canonical])
                      if (
                        targets.some(
                          (other) =>
                            other !== item &&
                            (endpoints.has(other.target.canonical) ||
                              (other.destination && endpoints.has(other.destination.canonical))),
                        )
                      )
                        return yield* fail(hunk.path)
                      if (yield* fs.exists(destination.canonical))
                        return yield* new ToolFailure({
                          message: `Cannot move ${hunk.path}: destination already exists. Read both paths before changing the patch.`,
                        })
                    }
                    if (hunk.type === "add")
                      return {
                        ...hunk,
                        target,
                        before: "",
                        after:
                          hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n`,
                      } satisfies Prepared
                    if ((yield* fs.stat(target.canonical)).type !== "File") return yield* fail(hunk.path)
                    const source = yield* fs.readFile(target.canonical)
                    if (hunk.type === "delete") {
                      const before = new TextDecoder("utf-8").decode(source)
                      return { ...hunk, target, before, after: "" } satisfies Prepared
                    }
                    if (hunk.chunks.length === 0) {
                      const decoded = yield* Effect.try({
                        try: () => new TextDecoder("utf-8", { fatal: true }).decode(source),
                        catch: () => new Error("Invalid UTF-8"),
                      }).pipe(Effect.option)
                      const binary = source.includes(0) || Option.isNone(decoded)
                      const before = !binary && Option.isSome(decoded) ? decoded.value : ""
                      return {
                        ...hunk,
                        target,
                        destination,
                        source,
                        content: source,
                        binary,
                        before,
                        after: before,
                      } satisfies Prepared
                    }
                    const original = new TextDecoder("utf-8", { ignoreBOM: true }).decode(source)
                    const before = original.replace(/^\uFEFF/, "")
                    // derive throws when the context lines do not match; that must
                    // stay a failure so it is reported only after edit approval.
                    const update = yield* Effect.try({
                      try: () => Patch.derive(hunk.path, hunk.chunks, original),
                      catch: () => fail(hunk.path),
                    })
                    return {
                      ...hunk,
                      target,
                      destination,
                      source,
                      content: Patch.joinBom(update.content, update.bom),
                      before,
                      after: update.content,
                    } satisfies Prepared
                  }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : fail(item.hunk.path)))),
                ).pipe(Effect.result)
                const patchFiles = Result.isSuccess(preparation) ? preparation.success.flatMap(filesForChange) : []
                const resources = [
                  ...new Set(
                    targets.flatMap((item) => [
                      item.target.resource,
                      ...(item.destination ? [item.destination.resource] : []),
                    ]),
                  ),
                ]
                yield* permission.assert({
                  action: "edit",
                  resources,
                  save: ["*"],
                  metadata: {
                    filepath: resources.join(", "),
                    ...(Result.isSuccess(preparation)
                      ? {
                          diff: patchFiles.map((file) => trimDiff(file.patch ?? "")).join("\n"),
                          files: patchFiles,
                        }
                      : {}),
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                if (Result.isFailure(preparation)) return yield* preparation.failure
                const prepared: Prepared[] = preparation.success
                yield* Effect.forEach(
                  prepared,
                  (change) =>
                    Effect.gen(function* () {
                      if (change.type === "add") {
                        const result = yield* files.create({
                          target: change.target,
                          content:
                            change.contents.endsWith("\n") || change.contents === ""
                              ? change.contents
                              : `${change.contents}\n`,
                        })
                        applied.push({ type: change.type, resource: result.resource, target: result.target })
                        yield* format.file(change.target.canonical).pipe(Effect.ignore)
                        return
                      }
                      if (change.type === "delete") {
                        const result = yield* files.remove({ target: change.target })
                        applied.push({ type: change.type, resource: result.resource, target: result.target })
                        return
                      }
                      if (change.destination) {
                        const destination = change.destination
                        const result = yield* files
                          .move({
                            source: change.target,
                            target: destination,
                            expected: change.source,
                            content: change.content,
                          })
                          .pipe(
                            Effect.catchTag("FileMutation.PartialMoveError", () => {
                              applied.push({
                                type: "add",
                                resource: destination.resource,
                                target: destination.canonical,
                              })
                              return new ToolFailure({
                                message: `${fail(change.path).message}. Destination was created; inspect both endpoints before retrying.`,
                              })
                            }),
                          )
                        applied.push({ type: "add", resource: result.resource, target: result.target })
                        applied.push({
                          type: "delete",
                          resource: change.target.resource,
                          target: change.target.canonical,
                        })
                        if (change.chunks.length > 0) yield* format.file(result.target).pipe(Effect.ignore)
                        return
                      }
                      const result = yield* files.writeIfUnchanged({
                        target: change.target,
                        expected: change.source,
                        content: change.content,
                      })
                      applied.push({ type: change.type, resource: result.resource, target: result.target })
                      if (change.chunks.length > 0) yield* format.file(change.target.canonical).pipe(Effect.ignore)
                    }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : fail(change.path)))),
                  { discard: true },
                )
                // Like write and edit, report the errors language servers see in the
                // files the patch left behind.
                const changed = prepared
                  .filter((change) => change.type !== "delete")
                  .map((change) =>
                    change.type === "update" && change.destination ? { ...change, target: change.destination } : change,
                  )
                yield* Effect.forEach(
                  changed,
                  (change) => lsp.touchFile(change.target.canonical, "document").pipe(Effect.ignore),
                  { discard: true },
                )
                const diagnostics = changed.length === 0 ? {} : yield* lsp.diagnostics()
                const report = changed
                  .map((change) =>
                    Diagnostic.report(
                      change.target.resource,
                      diagnostics[LSPClient.fileURI(change.target.canonical)] ?? [],
                    ),
                  )
                  .filter((item) => item !== "")
                  .join("\n")
                return { applied, files: patchFiles, ...(report ? { diagnostics: report } : {}) }
              }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : fail("patch"))))
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/apply-patch",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FileMutation.node,
    FSUtil.node,
    PermissionV2.node,
    Format.node,
    LSP.node,
  ],
})

function patchFile(change: Pick<Prepared, "type" | "target" | "before" | "after">): typeof FileDiff.Info.Type {
  const counts = diffLines(change.before, change.after).reduce(
    (result, item) => ({
      additions: result.additions + (item.added ? (item.count ?? 0) : 0),
      deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
    }),
    { additions: 0, deletions: 0 },
  )
  return {
    file: change.target.resource,
    patch: createTwoFilesPatch(change.target.resource, change.target.resource, change.before, change.after),
    status: change.type === "add" ? "added" : change.type === "delete" ? "deleted" : "modified",
    ...counts,
  }
}

function filesForChange(change: Prepared): Array<typeof FileDiff.Info.Type> {
  if (change.type !== "update" || !change.destination) return [patchFile(change)]
  if (change.binary) {
    const patch = `Binary file moved: ${change.target.resource} -> ${change.destination.resource}`
    return [
      { file: change.target.resource, status: "deleted", additions: 0, deletions: 0, patch },
      { file: change.destination.resource, status: "added", additions: 0, deletions: 0, patch },
    ]
  }
  return [
    patchFile({ type: "delete", target: change.target, before: change.before, after: "" }),
    patchFile({ type: "add", target: change.destination, before: "", after: change.after }),
  ]
}
