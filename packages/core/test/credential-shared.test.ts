import { expect } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Credential } from "@miao/core/credential"
import { Integration } from "@miao/core/integration"
import { LayerNode } from "@miao/core/effect/layer-node"
import { testEffect } from "./lib/effect"

const integrationID = Integration.ID.make("openai")
const methodID = Integration.MethodID.make("browser")
const oauth = (access: string, expires = Date.now() + 3_600_000) =>
  Credential.OAuth.make({ type: "oauth", methodID, access, refresh: "stable-owned-refresh", expires })

function save(file: string, value: Credential.Value | string) {
  const db = new Database(file)
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS credential(id TEXT PRIMARY KEY,integration_id TEXT,label TEXT,value TEXT,time_created INTEGER)",
    )
    db.query("INSERT OR REPLACE INTO credential VALUES(?,?,?,?,?)").run(
      "cred_shared",
      "openai",
      "legacy",
      typeof value === "string" ? value : JSON.stringify(value),
      1,
    )
  } finally {
    db.close()
  }
}

const source = Layer.effect(
  Credential.SharedDatabasePath,
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), "miao-credential-source-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    )
    const file = path.join(dir, "stable.db")
    yield* Effect.sync(() => save(file, oauth("fresh-access")))
    return file
  }),
)

const it = testEffect(
  LayerNode.compile(LayerNode.group([Integration.node, Credential.node])).pipe(Layer.provideMerge(source)),
)

it.live("uses the stable V2 credential instead of an expired channel-local legacy copy and rereads rotation", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const file = yield* Credential.SharedDatabasePath
    if (!file) throw new Error("missing fixture")
    const stale = yield* credentials.create({ integrationID, label: "legacy", value: oauth("stale-access", 1) })
    const selected = yield* credentials.list(integrationID)
    expect(selected).toHaveLength(1)
    expect(selected[0].source).toBe("shared")
    expect(selected[0].value).toEqual(
      oauth("fresh-access", selected[0].value.type === "oauth" ? selected[0].value.expires : 0),
    )
    expect((yield* credentials.get(stale.id))?.id).toBe(selected[0].id)
    yield* Effect.sync(() => save(file, oauth("rotated-access")))
    const next = yield* credentials.get(selected[0].id)
    expect(next?.value.type === "oauth" && next.value.access).toBe("rotated-access")
    expect((yield* credentials.all()).filter((item) => item.integrationID === integrationID)).toHaveLength(1)
  }),
)

it.live("preserves an explicitly configured channel-local connection", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const owned = yield* credentials.create({ integrationID, label: "Personal", value: oauth("separate-account") })
    expect(yield* credentials.list(integrationID)).toEqual([owned])
    expect(yield* credentials.get(owned.id)).toEqual(owned)
    yield* credentials.update(owned.id, { label: "Work" })
    expect((yield* credentials.get(owned.id))?.label).toBe("Work")
  }),
)

it.live("inherited credentials are read-only and no copies or mutations are made to the owner store", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const file = yield* Credential.SharedDatabasePath
    if (!file) throw new Error("missing fixture")
    const before = yield* Effect.promise(() => Bun.file(file).arrayBuffer())
    const inherited = (yield* credentials.list(integrationID))[0]
    expect(inherited.source).toBe("shared")
    const edit = yield* credentials.update(inherited.id, { value: oauth("must-not-write") }).pipe(Effect.exit)
    const remove = yield* credentials.remove(inherited.id).pipe(Effect.exit)
    expect(Exit.isFailure(edit)).toBe(true)
    expect(Exit.isFailure(remove)).toBe(true)
    const after = yield* Effect.promise(() => Bun.file(file).arrayBuffer())
    expect(new Uint8Array(after)).toEqual(new Uint8Array(before))
    expect((yield* credentials.get(inherited.id))?.value.type === "oauth").toBe(true)
  }),
)

it.live("does not refresh inherited OAuth tokens, even when they have expired", () =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service
    const file = yield* Credential.SharedDatabasePath
    if (!file) throw new Error("missing fixture")
    let refreshes = 0
    yield* integrations.transform((editor) =>
      editor.method.update({
        integrationID,
        method: { id: methodID, type: "oauth", label: "Browser" },
        authorize: () =>
          Effect.succeed({
            mode: "auto" as const,
            url: "https://example.com/authorize",
            instructions: "Sign in",
            callback: Effect.never,
          }),
        refresh: () =>
          Effect.sync(() => {
            refreshes++
            return oauth("must-not-refresh")
          }),
      }),
    )
    const inherited = (yield* credentials.list(integrationID))[0]
    const connection = { type: "credential" as const, id: inherited.id, label: inherited.label }
    expect((yield* integrations.connection.resolve(connection))?.type).toBe("oauth")
    yield* Effect.sync(() => save(file, oauth("expired-access", 1)))
    const failed = yield* integrations.connection.resolve(connection).pipe(Effect.flip)
    expect(failed).toBeInstanceOf(Integration.AuthorizationError)
    expect(failed.message).toContain("stable miao")
    expect(refreshes).toBe(0)
  }),
)

it.live("fails clearly rather than falling back to stale legacy data if the shared row is malformed", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const file = yield* Credential.SharedDatabasePath
    if (!file) throw new Error("missing fixture")
    const stale = yield* credentials.create({ integrationID, label: "legacy", value: oauth("stale-access", 1) })
    yield* Effect.sync(() => save(file, "not-json-secret-must-not-leak"))
    const failed = yield* credentials.get(stale.id).pipe(Effect.exit)
    expect(Exit.isFailure(failed)).toBe(true)
    if (Exit.isFailure(failed)) {
      const message = String(Cause.squash(failed.cause))
      expect(message).toContain("stable credential store")
      expect(message).not.toContain("not-json-secret-must-not-leak")
    }
  }),
)

it.live("authorization failures have a useful non-secret message instead of an empty Error.message", () =>
  Effect.sync(() => {
    const unauthorized = new Integration.AuthorizationError({ cause: new Error("Request failed: 401") })
    expect(unauthorized.message).toContain("HTTP 401")
    const empty = new Integration.AuthorizationError({ cause: new Error("") })
    expect(empty.message.length).toBeGreaterThan(0)
    const privateCause = new Integration.AuthorizationError({ cause: new Error("private-refresh-token") })
    expect(privateCause.message).not.toContain("private-refresh-token")
  }),
)
