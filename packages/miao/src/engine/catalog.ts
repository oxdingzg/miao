import { NativeEngine } from "@miao/server/native-engine"
import { ConflictError } from "@miao/protocol/errors"
import { SessionID } from "@miao/schema/session-id"
import { Effect, Schema } from "effect"

const Reply = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      session_id: SessionID,
      snapshot: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      usage: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
      error: Schema.optionalKey(Schema.String),
      usage_error: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
)

/** Short-lived readers never connect to, start, or register execution owners. */
export const readCatalog = Effect.fn("NativeCatalog.read")(function* (
  binary: string,
  input: Parameters<NonNullable<NativeEngine.Interface["catalog"]>>[0],
) {
  const pages = Array.from({ length: Math.ceil(input.sessions.length / 200) }, (_, index) =>
    input.sessions.slice(index * 200, (index + 1) * 200),
  )
  const results = yield* Effect.forEach(pages, (sessions) =>
    Effect.gen(function* () {
      const entries = yield* Effect.tryPromise({
        try: async (signal) => {
          const child = Bun.spawn(
            [
              binary,
              "catalog",
              "--db",
              input.storage,
              "--sessions",
              JSON.stringify(sessions),
              "--usage",
              String(input.usage),
            ],
            {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              timeout: 15_000,
              signal,
            },
          )
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ])
          if (code !== 0) throw new Error(`Catalog reader exited ${code}: ${stderr.slice(0, 1024)}`)
          const entries = Schema.decodeUnknownSync(Reply)(stdout)
          if (
            entries.length !== sessions.length ||
            entries.some((entry, index) => entry.session_id !== sessions[index])
          )
            throw new Error("Catalog reader returned mismatched Session identities")
          return entries
        },
        catch: (error) =>
          new ConflictError({
            resource: input.storage,
            message: error instanceof Error ? error.message : "Native catalog read failed",
          }),
      })
      yield* Effect.forEach(
        entries.filter((entry) => entry.error !== undefined || entry.usage_error),
        (entry) =>
          Effect.logWarning("native catalog facts unavailable", {
            sessionID: entry.session_id,
            error: entry.error ?? entry.usage_error,
          }),
      )
      return entries.flatMap((entry) =>
        entry.snapshot
          ? [
              {
                sessionID: entry.session_id,
                snapshot: entry.snapshot,
                ...(entry.usage ? { usage: entry.usage } : {}),
              },
            ]
          : [],
      )
    }),
  )
  return results.flat()
})
