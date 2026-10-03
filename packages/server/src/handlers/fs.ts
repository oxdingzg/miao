import { FileSystem } from "@miao/core/filesystem"
import { RelativePath } from "@miao/core/schema"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { isUtf8 } from "node:buffer"

export const FileSystemHandler = HttpApiBuilder.group(Api, "server.fs", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle("fs.content", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            const file = yield* fs.read({ path: ctx.query.path })
            const binary = file.content.includes(0) || !isUtf8(file.content)
            return {
              type: binary ? ("binary" as const) : ("text" as const),
              content: binary ? Buffer.from(file.content).toString("base64") : new TextDecoder().decode(file.content),
              encoding: binary ? ("base64" as const) : ("utf8" as const),
              mime: file.mime,
            }
          }),
        ),
      )
      .handleRaw("fs.read", (ctx) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const file = yield* fs.read({
            path: RelativePath.make(
              decodeURIComponent(new URL(ctx.request.url, "http://localhost").pathname.slice(13)),
            ),
          })
          return HttpServerResponse.uint8Array(file.content, { contentType: file.mime })
        }),
      )
      .handle("fs.list", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.list(ctx.query)
          }),
        ),
      )
      .handle("fs.find", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.find(ctx.query)
          }),
        ),
      )
  }),
)
