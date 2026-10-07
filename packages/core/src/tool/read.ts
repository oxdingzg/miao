export * as ReadTool from "./read"

import { ToolFailure } from "@miao/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { Image } from "../image"
import { InstructionContext } from "../instruction-context"
import { LSP } from "../lsp"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { AbsolutePath } from "../schema"
import { EditSnapshots } from "./edit-snapshot"
import { ReadToolFileSystem } from "./read-filesystem"
import { ReadToolPdf } from "./read-pdf"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "read"
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const PAGES_PDF_ONLY = "pages only applies to PDF files; use offset and limit for text files and directories."
const LocationInput = Schema.Struct({
  path: Schema.String,
  offset: ReadToolFileSystem.PageInput.fields.offset.annotate({
    description: "The 1-based directory entry or text line offset to start reading from",
  }),
  limit: ReadToolFileSystem.PageInput.fields.limit.annotate({
    description: "The maximum number of directory entries or text lines to read",
  }),
  pages: Schema.String.pipe(Schema.optional).annotate({
    description: `PDF only: 1-based pages to read, such as "3", "1-5", or "1,3,7-9" (at most ${ReadToolPdf.MAX_PAGES}; default: the first ${ReadToolPdf.DEFAULT_PAGES})`,
  }),
})
export const Input = LocationInput
// A whole-file text read may carry nested instruction files, like a text page.
const FileContent = Schema.Struct({ ...FileSystem.Content.fields, instructions: ReadToolFileSystem.Instructions })
const Output = Schema.Union([FileContent, ReadToolFileSystem.TextPage, ReadToolFileSystem.ListPage, ReadToolPdf.Pages])

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const reader = yield* ReadToolFileSystem.Service
    const mutation = yield* LocationMutation.Service
    const image = yield* Image.Service
    const pdf = yield* ReadToolPdf.Service
    const permission = yield* PermissionV2.Service
    const instructions = yield* InstructionContext.Service
    const lsp = yield* LSP.Service
    const snapshots = yield* EditSnapshots.Service

    yield* tools
      .register({
        [name]: Tool.withConcurrency(
          Tool.make({
            description:
              "Read a text file, supported image, or PDF, page through a large UTF-8 text file by line offset, or list a directory page. PDFs return each page's text; pages without a text layer (scans) are returned as page images. Select PDF pages with `pages` (requires poppler). Relative paths resolve from the current location; absolute paths inside it are accepted, while external absolute paths require external_directory approval.",
            input: Input,
            output: Output,
            toModelOutput: ({ input, output }) => {
              if ("type" in output && output.type === "pdf-pages")
                return [
                  { type: "text", text: output.content },
                  ...output.images.flatMap((page) => [
                    { type: "text" as const, text: `\n\n[Page ${page.page} image]` },
                    {
                      type: "file" as const,
                      data: page.content,
                      mime: page.mime,
                      name: `${input.path}#page=${page.page}`,
                    },
                  ]),
                ]
              if (!("encoding" in output) || output.encoding !== "base64" || !SUPPORTED_IMAGE_MIMES.has(output.mime))
                return []
              return [
                { type: "text", text: "Image read successfully" },
                { type: "file", data: output.content, mime: output.mime, name: input.path },
              ]
            },
            execute: (input, context) => {
              return Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const target = yield* mutation.resolve({ path: input.path, kind: "directory" })
                const external = target.externalDirectory
                if (external)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                const resource = target.resource
                const absolute = AbsolutePath.make(target.canonical)
                const type = yield* reader.inspect(absolute)
                yield* permission.assert({
                  action: name,
                  resources: [resource],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                if (type === "directory" && input.pages !== undefined)
                  return yield* new ReadToolPdf.PagesError({ reason: PAGES_PDF_ONLY })
                if (type === "directory")
                  return yield* reader.list(absolute, { offset: input.offset, limit: input.limit })
                const read = yield* reader.read(absolute, resource, { offset: input.offset, limit: input.limit }).pipe(
                  Effect.map((content) => ({ content })),
                  Effect.catchTag("ReadTool.PdfFileError", () => Effect.succeed({ pdf: true as const })),
                )
                if ("pdf" in read) {
                  if (input.offset !== undefined || input.limit !== undefined)
                    return yield* new ReadToolPdf.PagesError({
                      reason: "offset and limit do not apply to PDF files; select PDF pages with pages instead.",
                    })
                  const pages = yield* pdf.read(absolute, resource, { pages: input.pages })
                  const images = yield* Effect.forEach(pages.images, (page) =>
                    image
                      .normalize(`${resource}#page=${page.page}`, {
                        uri: `${resource}#page=${page.page}`,
                        name: `${resource}#page=${page.page}`,
                        content: page.content,
                        encoding: "base64",
                        mime: page.mime,
                      })
                      .pipe(
                        Effect.map((normalized) => ({
                          page: page.page,
                          mime: normalized.mime,
                          content: normalized.content,
                        })),
                        Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(page)),
                      ),
                  )
                  return new ReadToolPdf.Pages({ ...pages, images })
                }
                if (input.pages !== undefined) return yield* new ReadToolPdf.PagesError({ reason: PAGES_PDF_ONLY })
                const output = yield* Effect.gen(function* () {
                  const content = read.content
                  if (
                    "encoding" in content &&
                    content.encoding === "base64" &&
                    SUPPORTED_IMAGE_MIMES.has(content.mime)
                  ) {
                    return yield* image
                      .normalize(resource, { ...content, encoding: "base64" })
                      .pipe(Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)))
                  }
                  if ("encoding" in content && content.encoding === "base64")
                    return yield* Effect.fail(new ReadToolFileSystem.BinaryFileError({ resource }))
                  const nearby = (yield* instructions.nearby({ sessionID: context.sessionID, path: absolute })).map(
                    (file) => ({ path: file.path, content: file.content }),
                  )
                  if (nearby.length === 0) return content
                  if (content instanceof ReadToolFileSystem.TextPage)
                    return new ReadToolFileSystem.TextPage({ ...content, instructions: nearby })
                  return { ...content, instructions: nearby }
                })
                // The model edits what it just saw, so keep it as the rebase
                // snapshot for a follow-up edit whose oldString no longer
                // matches the drifted file.
                if (
                  "content" in output &&
                  typeof output.content === "string" &&
                  !("encoding" in output && output.encoding === "base64")
                )
                  yield* snapshots.register(target.canonical, output.content)
                // The read succeeded, so prime the language server in the
                // background: a follow-up edit of this file then skips the
                // synchronous open-and-diagnostics wait at edit time.
                yield* lsp.warm(target.canonical, "document")
                return output
              }).pipe(
                Effect.mapError((error) => {
                  const message =
                    error instanceof ReadToolFileSystem.BinaryFileError ||
                    error instanceof ReadToolPdf.DependencyError ||
                    error instanceof ReadToolPdf.CommandError ||
                    error instanceof ReadToolPdf.PagesError ||
                    error instanceof ReadToolPdf.UnreadableError ||
                    error instanceof ReadToolFileSystem.MediaIngestLimitError ||
                    error instanceof Image.DecodeError ||
                    error instanceof Image.SizeError
                      ? error.message
                      : `Unable to read ${input.path}`
                  return new ToolFailure({ message })
                }),
              )
            },
          }),
          "concurrent",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/read",
  layer,
  deps: [
    ToolRegistry.node,
    ReadToolFileSystem.node,
    ReadToolPdf.node,
    LocationMutation.node,
    Image.node,
    PermissionV2.node,
    InstructionContext.node,
    LSP.node,
    EditSnapshots.node,
  ],
})
