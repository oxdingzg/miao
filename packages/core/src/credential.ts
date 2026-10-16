export * as Credential from "./credential"

import { and, asc, eq, ne } from "drizzle-orm"
import path from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Credential } from "@miao/schema/credential"
import { Integration } from "@miao/schema/integration"
import { Database } from "./database/database"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { makeGlobalNode } from "./effect/app-node"
import { CredentialTable } from "./credential/sql"
import { CredentialDaemon } from "./credential/daemon"
import { DatabaseFile } from "./database/file"
import { Flag } from "./flag/flag"

export const ID = Credential.ID
export type ID = Credential.ID

export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

export const Key = Credential.Key
export type Key = Credential.Key

export const Value = Credential.Value
export type Value = Credential.Value

export const Info = Credential.Info
export type Info = Credential.Info

/** Preview sessions stay isolated, while inherited credentials stay with their
 * existing broker. Explicit DB overrides do not silently read another store. */
export const SharedDatabasePath = Context.Reference<string | undefined>("@miao/CredentialSharedDatabase", {
  defaultValue: (): string | undefined => {
    const stable = path.join(Global.Path.data, "miao.db")
    return typeof Bun !== "undefined" && !Flag.MIAO_DB && DatabaseFile.path() !== stable ? stable : undefined
  },
})

export class SharedReadError extends Schema.TaggedErrorClass<SharedReadError>()("Credential.SharedRead", {
  path: Schema.String,
}) {
  override get message() {
    return "Could not read the stable credential store; refusing to fall back to stale legacy tokens"
  }
}

export class SharedExpiredError extends Schema.TaggedErrorClass<SharedExpiredError>()("Credential.SharedExpired", {
  integrationID: Integration.ID,
}) {
  override get message() {
    return `Shared OAuth credential for ${this.integrationID} has expired. Refresh it in the stable miao runtime; the preview does not own refresh.`
  }
}

export class SharedReadOnlyError extends Schema.TaggedErrorClass<SharedReadOnlyError>()("Credential.SharedReadOnly", {
  id: ID,
}) {
  override get message() {
    return "Inherited credentials are read-only in this channel; manage them in the stable miao runtime or create a separate connection."
  }
}

export class DaemonOwnedError extends Schema.TaggedErrorClass<DaemonOwnedError>()("Credential.DaemonOwned", {
  id: ID,
}) {
  override get message() {
    return "Credential is owned by the daemon; the TS broker cannot mutate it"
  }
}

export interface Interface {
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Info[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: Integration.ID) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Adds a credential as the integration's active one; the same method and
   * label replaces its existing row instead of stacking a duplicate. */
  readonly create: (input: {
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
  }) => Effect.Effect<Info>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>
  /** Makes one stored credential the active connection for its integration. */
  readonly activate: (id: ID) => Effect.Effect<void>
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
    const sharedPath = yield* SharedDatabasePath
    const readShared = Effect.fn("Credential.readShared")(function* () {
      if (!sharedPath || !(yield* fsys.exists(sharedPath).pipe(Effect.orDie))) return []
      return yield* Effect.tryPromise({
        try: async () => {
          const { Database } = await import("bun:sqlite")
          const shared = new Database(sharedPath, { readonly: true, strict: true })
          try {
            if (!shared.query("SELECT name FROM sqlite_master WHERE type='table' AND name='credential'").get())
              return []
            const rows = shared
              .query<
                { id: string; integration_id: string; label: string; value: string },
                []
              >("SELECT id,integration_id,label,value FROM credential WHERE integration_id IS NOT NULL ORDER BY time_created,id")
              .all()
            return rows.map((row) => {
              const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(row.value)
              const value = Option.flatMap(json, Schema.decodeUnknownOption(Value))
              if (Option.isNone(value)) throw new SharedReadError({ path: sharedPath })
              return new Info({
                id: ID.make(row.id),
                integrationID: Integration.ID.make(row.integration_id),
                label: row.label,
                value: value.value,
                source: "shared",
                active: false,
              })
            })
          } finally {
            shared.close()
          }
        },
        catch: () => new SharedReadError({ path: sharedPath }),
      }).pipe(Effect.orDie)
    })
    const mergeShared = (local: Info[], shared: Info[]) => {
      const owned = new Set(
        local.filter((credential) => credential.label !== "legacy").map((credential) => credential.integrationID),
      )
      const inherited = shared.filter((credential) => !owned.has(credential.integrationID))
      const inheritedIDs = new Set(inherited.map((credential) => credential.integrationID))
      return [...local.filter((credential) => !inheritedIDs.has(credential.integrationID)), ...inherited]
    }
    const stored = (row: typeof CredentialTable.$inferSelect) => {
      if (!row.integration_id) return
      return new Info({
        id: row.id,
        integrationID: row.integration_id,
        label: row.label,
        value: decode(row.value),
        active: row.active ?? false,
      })
    }

    const all = Effect.fn("Credential.all")(function* () {
      const local = (yield* db
        .select()
        .from(CredentialTable)
        .orderBy(asc(CredentialTable.active), asc(CredentialTable.time_created), asc(CredentialTable.id))
        .all()
        .pipe(Effect.orDie)).flatMap((row) => {
        const credential = stored(row)
        return credential ? [credential] : []
      })
      return mergeShared(local, yield* readShared())
    })
    const list = Effect.fn("Credential.list")(function* (integrationID: Integration.ID) {
      const local = (yield* db
        .select()
        .from(CredentialTable)
        .where(eq(CredentialTable.integration_id, integrationID))
        .orderBy(asc(CredentialTable.active), asc(CredentialTable.time_created), asc(CredentialTable.id))
        .all()
        .pipe(Effect.orDie)).flatMap((row) => {
        const credential = stored(row)
        return credential ? [credential] : []
      })
      return mergeShared(
        local,
        (yield* readShared()).filter((credential) => credential.integrationID === integrationID),
      )
    })
    const get = Effect.fn("Credential.get")(function* (id: ID) {
      const row = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
      const local = row ? stored(row) : undefined
      if (local && local.label !== "legacy") return local
      const shared = yield* readShared()
      return local
        ? (shared.find((credential) => credential.integrationID === local.integrationID) ?? local)
        : shared.find((credential) => credential.id === id)
    })
    const create = Effect.fn("Credential.create")(function* (input: {
      readonly integrationID: Integration.ID
      readonly value: Value
      readonly label?: string
    }) {
      const label = input.label ?? "default"
      const methodID = input.value.type === "oauth" ? input.value.methodID : undefined
      const id = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const existing = yield* tx
              .select()
              .from(CredentialTable)
              .where(eq(CredentialTable.integration_id, input.integrationID))
              .all()
            const owned = existing.find((row) => CredentialDaemon.socket(decode(row.value)))
            if (owned) yield* Effect.die(new DaemonOwnedError({ id: owned.id }))
            const twin = existing.find((row) => row.label === label && (row.method_id ?? undefined) === methodID)
            const id = twin?.id ?? ID.create()
            if (twin) {
              yield* tx
                .update(CredentialTable)
                .set({ value: input.value, method_id: methodID, active: true })
                .where(eq(CredentialTable.id, twin.id))
                .run()
            } else {
              yield* tx
                .insert(CredentialTable)
                .values({
                  id,
                  integration_id: input.integrationID,
                  label,
                  value: input.value,
                  method_id: methodID,
                  active: true,
                })
                .run()
            }
            yield* tx
              .update(CredentialTable)
              .set({ active: false })
              .where(and(eq(CredentialTable.integration_id, input.integrationID), ne(CredentialTable.id, id)))
              .run()
            return id
          }),
        )
        .pipe(Effect.orDie)
      return new Info({ id, integrationID: input.integrationID, label, value: input.value, active: true })
    })
    const update = Effect.fn("Credential.update")(function* (id: ID, updates: Partial<Pick<Info, "label" | "value">>) {
      if (!updates.label && !updates.value) return
      const current = yield* get(id)
      if (current && CredentialDaemon.socket(current.value)) yield* Effect.die(new DaemonOwnedError({ id }))
      if (current?.source === "shared") yield* Effect.die(new SharedReadOnlyError({ id }))
      yield* db
        .update(CredentialTable)
        .set({ label: updates.label, value: updates.value })
        .where(eq(CredentialTable.id, id))
        .run()
        .pipe(Effect.orDie)
    })
    const activate = Effect.fn("Credential.activate")(function* (id: ID) {
      const current = yield* get(id)
      if (current && CredentialDaemon.socket(current.value)) yield* Effect.die(new DaemonOwnedError({ id }))
      if (current?.source === "shared") yield* Effect.die(new SharedReadOnlyError({ id }))
      if (!current) return
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const rows = yield* tx
              .select()
              .from(CredentialTable)
              .where(eq(CredentialTable.integration_id, current.integrationID))
              .all()
            const target = rows.find((row) => row.id === id)
            if (!target) return
            if (CredentialDaemon.socket(decode(target.value))) yield* Effect.die(new DaemonOwnedError({ id }))
            for (const row of rows) {
              if (row.id === id || row.active === false || CredentialDaemon.socket(decode(row.value))) continue
              yield* tx.update(CredentialTable).set({ active: false }).where(eq(CredentialTable.id, row.id)).run()
            }
            yield* tx.update(CredentialTable).set({ active: true }).where(eq(CredentialTable.id, id)).run()
          }),
        )
        .pipe(Effect.orDie)
    })
    const remove = Effect.fn("Credential.remove")(function* (id: ID) {
      const current = yield* get(id)
      if (current && CredentialDaemon.socket(current.value)) yield* Effect.die(new DaemonOwnedError({ id }))
      if (current?.source === "shared") yield* Effect.die(new SharedReadOnlyError({ id }))
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get()
            yield* tx.delete(CredentialTable).where(eq(CredentialTable.id, id)).run()
            if (!row?.integration_id || !row.active) return
            const remaining = (yield* tx
              .select()
              .from(CredentialTable)
              .where(eq(CredentialTable.integration_id, row.integration_id))
              .all()).filter((item) => !CredentialDaemon.socket(decode(item.value)))
            const newest = remaining.sort(
              (a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            ).at(-1)
            if (newest)
              yield* tx.update(CredentialTable).set({ active: true }).where(eq(CredentialTable.id, newest.id)).run()
          }),
        )
        .pipe(Effect.orDie)
    })

    const service = Service.of({ all, list, get, create, update, activate, remove })

    // Bridge credentials connected before the V2 store existed: seed any
    // `auth.json` API key that this integration does not already have.
    yield* Effect.gen(function* () {
      const raw = yield* fsys.readJson(path.join(Global.Path.data, "auth.json")).pipe(Effect.orElseSucceed(() => ({})))
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
