export * as FileSystemV1 from "./filesystem"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

// The V1 file-tree node shape the app renders; the app maps /api/fs/list onto it.
export const FileNode = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  absolute: Schema.String,
  type: Schema.Literals(["file", "directory"]),
  ignored: Schema.Boolean,
}).annotate({ identifier: "FileNode" })
export type FileNode = Schema.Schema.Type<typeof FileNode>

// The V1 file-content shape the app and session UI render; the app maps /api/fs/content onto it.
export const FileContent = Schema.Struct({
  type: Schema.Literals(["text", "binary"]),
  content: Schema.String,
  diff: Schema.optional(Schema.String),
  patch: Schema.optional(
    Schema.Struct({
      oldFileName: Schema.String,
      newFileName: Schema.String,
      oldHeader: Schema.optional(Schema.String),
      newHeader: Schema.optional(Schema.String),
      hunks: Schema.Array(
        Schema.Struct({
          oldStart: NonNegativeInt,
          oldLines: NonNegativeInt,
          newStart: NonNegativeInt,
          newLines: NonNegativeInt,
          lines: Schema.Array(Schema.String),
        }),
      ),
      index: Schema.optional(Schema.String),
    }),
  ),
  encoding: Schema.optional(Schema.Literal("base64")),
  mimeType: Schema.optional(Schema.String),
}).annotate({ identifier: "FileContent" })
export type FileContent = Schema.Schema.Type<typeof FileContent>
