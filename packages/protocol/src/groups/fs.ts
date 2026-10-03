import { FileSystem } from "@miao/schema/filesystem"
import { Location } from "@miao/schema/location"
import { PositiveInt, RelativePath } from "@miao/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

const ListQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: RelativePath.pipe(Schema.optional),
})

const FindQuery = Schema.Struct({
  ...LocationQuery.fields,
  query: FileSystem.FindInput.fields.query,
  type: FileSystem.FindInput.fields.type,
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
})

export const FileSystemGroup = HttpApiGroup.make("server.fs")
  .add(
    HttpApiEndpoint.get("fs.content", "/api/fs/content", {
      query: Schema.Struct({ ...LocationQuery.fields, path: RelativePath }),
      success: Location.response(FileSystem.Content),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.content",
          summary: "Read file content",
          description: "Read a location-relative file as UTF-8 text or base64 binary content.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.read", "/api/fs/read/*", {
      query: LocationQuery,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.read",
          summary: "Read file",
          description: "Serve one file relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.list", "/api/fs/list", {
      query: ListQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.list",
          summary: "List directory",
          description: "List direct children of one directory relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.find", "/api/fs/find", {
      query: FindQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.find",
          summary: "Find files",
          description: "Find recursively ranked filesystem entries relative to the requested location.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "filesystem",
      description: "Experimental location-scoped filesystem routes.",
    }),
  )
