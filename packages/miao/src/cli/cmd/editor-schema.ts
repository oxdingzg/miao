import { Schema, SchemaGetter } from "effect"
const JsonRpcMessageSchema = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  ),
})

const PositionSchema = Schema.Struct({
  line: Schema.Number,
  character: Schema.Number,
})

const EditorSelectionRangeSchema = Schema.Struct({
  text: Schema.String,
  selection: Schema.Struct({
    start: PositionSchema,
    end: PositionSchema,
  }),
})

const EditorSelectionRangesSchema = Schema.Struct({
  filePath: Schema.String,
  source: Schema.optional(Schema.Literals(["websocket", "zed"])),
  ranges: Schema.mutable(Schema.Array(EditorSelectionRangeSchema).check(Schema.isMinLength(1))),
})

const EditorSelectionSchema = Schema.Union([
  EditorSelectionRangesSchema,
  Schema.Struct({
    text: Schema.String,
    filePath: Schema.String,
    source: Schema.optional(Schema.Literals(["websocket", "zed"])),
    selection: Schema.Struct({
      start: PositionSchema,
      end: PositionSchema,
    }),
  }),
]).pipe(
  Schema.decodeTo(EditorSelectionRangesSchema, {
    decode: SchemaGetter.transform((value) =>
      "ranges" in value
        ? value
        : {
            filePath: value.filePath,
            source: value.source,
            ranges: [
              {
                text: value.text,
                selection: value.selection,
              },
            ],
          },
    ),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)

const EditorMentionSchema = Schema.Struct({
  filePath: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
})

const EditorServerInfoSchema = Schema.Struct({
  protocolVersion: Schema.optional(Schema.String),
  serverInfo: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
    }),
  ),
})

const decodeJsonRpcMessage = Schema.decodeUnknownOption(JsonRpcMessageSchema)
const decodeEditorSelection = Schema.decodeUnknownOption(EditorSelectionSchema)
const decodeEditorMention = Schema.decodeUnknownOption(EditorMentionSchema)
const decodeEditorServerInfo = Schema.decodeUnknownOption(EditorServerInfoSchema)

type JsonRpcMessage = Schema.Schema.Type<typeof JsonRpcMessageSchema>
export type EditorSelection = Schema.Schema.Type<typeof EditorSelectionSchema>
export type EditorMention = Schema.Schema.Type<typeof EditorMentionSchema>
export type EditorLabelState = "pending" | "sent" | "none"
