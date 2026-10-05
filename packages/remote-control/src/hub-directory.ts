export * as HubDirectory from "./hub-directory"

import { Database } from "bun:sqlite"
import { createHash, timingSafeEqual } from "node:crypto"
import { Schema } from "effect"

const Registration = Schema.Struct({
  hostID: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,128}$/)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  publicKey: Schema.String.check(Schema.isMinLength(87), Schema.isMaxLength(87)),
})
export type Registration = typeof Registration.Type
export type Host = Registration & { createdAt: number; revokedAt: number | null }
type Row = { host_id: string; name: string; public_key: string; created_at: number; revoked_at: number | null }

/** Explicit migration: callers back up the private metadata database before upgrades. */
export function migrate(database: Database) {
  database.transaction(() => {
    database.exec(
      "CREATE TABLE IF NOT EXISTS hub_metadata_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
    )
    const version = database
      .query<{ version: number }, []>("SELECT version FROM hub_metadata_schema WHERE id = 1")
      .get()
    if (version && version.version !== 1) throw new Error("Unsupported Hub metadata schema")
    database.exec(`CREATE TABLE IF NOT EXISTS hub_host (
      host_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES "user" (id),
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      token_hash BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    )`)
    database.exec("CREATE INDEX IF NOT EXISTS hub_host_account ON hub_host (account_id)")
    database.query("INSERT OR IGNORE INTO hub_metadata_schema (id, version) VALUES (1, 1)").run()
  })()
}

/** Stores routing metadata only; it never issues or restores Agent device grants. */
export function open(database: Database) {
  if (
    database.query<{ version: number }, []>("SELECT version FROM hub_metadata_schema WHERE id = 1").get()?.version !== 1
  )
    throw new Error("Hub metadata requires migration")
  const select = database.query<Row, [string]>(
    "SELECT host_id, name, public_key, created_at, revoked_at FROM hub_host WHERE account_id = ? ORDER BY created_at, host_id LIMIT 64",
  )
  function requireAccount(accountID: string) {
    if (!database.query('SELECT id FROM "user" WHERE id = ?').get(accountID)) throw new Error("Hub account unavailable")
  }
  return {
    list: (accountID: string) => select.all(accountID).map(project),
    register: async (accountID: string, input: Registration, authorized: () => boolean = () => true) => {
      const registration = Schema.decodeUnknownSync(Registration)(input)
      const publicKey = Buffer.from(registration.publicKey, "base64url")
      if (publicKey.length !== 65 || publicKey[0] !== 4 || publicKey.toString("base64url") !== registration.publicKey)
        throw new Error("Invalid Hub host public key")
      await crypto.subtle.importKey("raw", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
      const createdAt = Date.now()
      database.transaction(() => {
        if (!authorized()) throw new Error("Hub login revoked or expired")
        requireAccount(accountID)
        if (
          database
            .query<{ count: number }, [string]>("SELECT count(*) AS count FROM hub_host WHERE account_id = ?")
            .get(accountID)!.count >= 64
        )
          throw new Error("Hub account host limit")
        if (database.query("SELECT host_id FROM hub_host WHERE host_id = ?").get(registration.hostID))
          throw new Error("Hub host identity already registered")
        database
          .query(
            "INSERT INTO hub_host (host_id, account_id, name, public_key, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(registration.hostID, accountID, registration.name, registration.publicKey, hash(token), createdAt)
      })()
      return { host: { ...registration, createdAt, revokedAt: null }, token }
    },
    authenticate: (hostID: string, token: string) => {
      if (token.length > 256) return undefined
      const record = database
        .query<
          { account_id: string; token_hash: Uint8Array; revoked_at: number | null },
          [string]
        >('SELECT h.account_id, h.token_hash, h.revoked_at FROM hub_host h JOIN "user" u ON u.id = h.account_id WHERE h.host_id = ?')
        .get(hostID)
      if (!record || record.revoked_at !== null || !timingSafeEqual(record.token_hash, hash(token))) return undefined
      return record.account_id
    },
    belongs: (accountID: string, hostID: string) =>
      database
        .query("SELECT host_id FROM hub_host WHERE account_id = ? AND host_id = ? AND revoked_at IS NULL")
        .get(accountID, hostID) !== null,
    revoke: (accountID: string, hostID: string) =>
      database
        .query("UPDATE hub_host SET revoked_at = ? WHERE account_id = ? AND host_id = ? AND revoked_at IS NULL")
        .run(Date.now(), accountID, hostID).changes === 1,
    rotate: (accountID: string, hostID: string) => {
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
      if (
        database
          .query("UPDATE hub_host SET token_hash = ? WHERE account_id = ? AND host_id = ? AND revoked_at IS NULL")
          .run(hash(token), accountID, hostID).changes !== 1
      )
        throw new Error("Hub host unavailable")
      return token
    },
  }
}

function hash(token: string) {
  return createHash("sha256").update(token).digest()
}
function project(row: Row): Host {
  return {
    hostID: row.host_id,
    name: row.name,
    publicKey: row.public_key,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }
}
