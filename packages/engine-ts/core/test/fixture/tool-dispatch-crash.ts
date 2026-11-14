import { openSync, writeSync, fsyncSync } from "node:fs"
import { Effect, Schema } from "effect"
import { Database } from "@miao/core/database/database"
import { SessionToolDispatch } from "@miao/core/session/tool-dispatch"

const filename = process.argv[2]
const sideEffect = process.argv[3]
const encoded = process.argv[4]
if (!filename || !sideEffect || !encoded) throw new Error("Expected database, side-effect path and dispatch token")
const token = Schema.decodeUnknownSync(SessionToolDispatch.Token)(
  Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(encoded),
)

await Effect.runPromise(
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* SessionToolDispatch.plan(database.db, token, { tool: "write", input: { text: "once" } })
    yield* SessionToolDispatch.consume(database.db, token)
    const descriptor = openSync(sideEffect, "a")
    writeSync(descriptor, "once\n")
    fsyncSync(descriptor)
    // Die after the externally visible effect, without publishing a settlement or closing storage.
    process.exit(71)
  }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
)
