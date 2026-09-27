export * as Credential from "./credential"

import { asc, eq } from "drizzle-orm"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { Credential } from "@miao/schema/credential"
import { Integration } from "@miao/schema/integration"
import { Database } from "./database/database"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { makeGlobalNode } from "./effect/app-node"
import { CredentialTable } from "./credential/sql"

export const ID = Credential.ID
export type ID = Credential.ID

export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

export const Key = Credential.Key
export type Key = Credential.Key

export const Value = Credential.Value
export type Value = Credential.Value

export class Info extends Schema.Class<Info>("Credential.Info")({
  id: ID,
  integrationID: Integration.ID,
  label: Schema.String,
  value: Value,
}) {}

export interface Interface {
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Info[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: Integration.ID) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Replaces any credential for an integration and returns the new record. */
  readonly create: (input: {
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
  }) => Effect.Effect<Info>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>
  /** Removes a stored credential. */
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/Credential") {}

// A legacy `auth.json` API entry, mapped to the current key credential shape.
const legacyKey = (value: unknown): Value | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const entry = value as Record<string, unknown>
  if (entry.type !== "api" || typeof entry.key !== "string") return undefined
  const metadata = entry.metadata
  return {
    type: "key",
    key: entry.key,
    ...(typeof metadata === "object" && metadata !== null ? { metadata: metadata as Record<string, unknown> } : {}),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownSync(Value)
    const stored = (row: typeof CredentialTable.$inferSelect) => {
      if (!row.integration_id) return
      return new Info({
        id: row.id,
        integrationID: row.integration_id,
        label: row.label,
        value: decode(row.value),
      })
    }

    const all = Effect.fn("Credential.all")(function* () {
      return (yield* db
        .select()
        .from(CredentialTable)
        .orderBy(asc(CredentialTable.time_created))
        .all()
        .pipe(Effect.orDie)).flatMap((row) => {
        const credential = stored(row)
        return credential ? [credential] : []
      })
    })
    const list = Effect.fn("Credential.list")(function* (integrationID: Integration.ID) {
      return (yield* db
        .select()
        .from(CredentialTable)
        .where(eq(CredentialTable.integration_id, integrationID))
        .orderBy(asc(CredentialTable.time_created))
        .all()
        .pipe(Effect.orDie)).flatMap((row) => {
        const credential = stored(row)
        return credential ? [credential] : []
      })
    })
    const get = Effect.fn("Credential.get")(function* (id: ID) {
      const row = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
      return row ? stored(row) : undefined
    })
    const create = Effect.fn("Credential.create")(function* (input: {
      readonly integrationID: Integration.ID
      readonly value: Value
      readonly label?: string
    }) {
      const credential = new Info({
        id: ID.create(),
        integrationID: input.integrationID,
        label: input.label ?? "default",
        value: input.value,
      })
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .delete(CredentialTable)
              .where(eq(CredentialTable.integration_id, credential.integrationID))
              .run()
            yield* tx
              .insert(CredentialTable)
              .values({
                id: credential.id,
                integration_id: credential.integrationID,
                label: credential.label,
                value: credential.value,
              })
              .run()
          }),
        )
        .pipe(Effect.orDie)
      return credential
    })
    const update = Effect.fn("Credential.update")(function* (id: ID, updates: Partial<Pick<Info, "label" | "value">>) {
      if (!updates.label && !updates.value) return
      yield* db
        .update(CredentialTable)
        .set({ label: updates.label, value: updates.value })
        .where(eq(CredentialTable.id, id))
        .run()
        .pipe(Effect.orDie)
    })
    const remove = Effect.fn("Credential.remove")(function* (id: ID) {
      yield* db.delete(CredentialTable).where(eq(CredentialTable.id, id)).run().pipe(Effect.orDie)
    })

    const service = Service.of({ all, list, get, create, update, remove })

    // Bridge credentials connected before the V2 store existed: seed any
    // `auth.json` API key that this integration does not already have.
    yield* Effect.gen(function* () {
      const raw = yield* fsys
        .readJson(path.join(Global.Path.data, "auth.json"))
        .pipe(Effect.orElseSucceed(() => ({})))
      if (typeof raw !== "object" || raw === null) return
      for (const [providerID, value] of Object.entries(raw as Record<string, unknown>)) {
        const key = legacyKey(value)
        if (!key) continue
        const integrationID = Integration.ID.make(providerID)
        if ((yield* list(integrationID)).length > 0) continue
        yield* create({ integrationID, value: key, label: "legacy" })
      }
    }).pipe(Effect.ignore)

    return service
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, FSUtil.node] })
