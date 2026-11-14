export * as HubRoster from "./hub-roster"

import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { DeviceRoster } from "./device-roster"
import { SecureChannel } from "./secure-channel"

export const Update = Schema.Struct({
  sequence: DeviceRoster.Roster.fields.sequence,
  payload: DeviceRoster.Roster,
  signature: DeviceRoster.Signed.fields.signature,
  digest: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
})
export type Update = typeof Update.Type
export type Record = Update & { accountID: string; updatedAt: number }

/** Explicit additive migration, independent of routing metadata schema versions. */
export function migrate(database: Database) {
  database.transaction(() => {
    database.exec(
      "CREATE TABLE IF NOT EXISTS hub_roster_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)",
    )
    const version = database.query<{ version: number }, []>("SELECT version FROM hub_roster_schema WHERE id=1").get()
    if (version && version.version !== 1) throw new Error("Unsupported Hub roster schema")
    database.exec(`CREATE TABLE IF NOT EXISTS hub_account_roster (
      account_id TEXT PRIMARY KEY REFERENCES "user"(id), sequence INTEGER NOT NULL,
      payload TEXT NOT NULL, signature TEXT NOT NULL, digest TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`)
    database.exec(`CREATE TABLE IF NOT EXISTS hub_roster_history (
      account_id TEXT NOT NULL REFERENCES "user"(id), sequence INTEGER NOT NULL,
      payload TEXT NOT NULL, signature TEXT NOT NULL, digest TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(account_id,sequence)
    )`)
    database.query("INSERT OR IGNORE INTO hub_roster_schema(id,version) VALUES(1,1)").run()
  })()
}

/** Stores authenticated-account routing metadata, never decides device grant authority. */
export function open(database: Database) {
  if (database.query<{ version: number }, []>("SELECT version FROM hub_roster_schema WHERE id=1").get()?.version !== 1)
    throw new Error("Hub roster storage requires migration")
  const get = (accountID: string): Record | null => {
    const row = database
      .query<
        {
          account_id: string
          sequence: number
          payload: string
          signature: string
          digest: string
          updated_at: number
        },
        [string]
      >("SELECT * FROM hub_account_roster WHERE account_id=?")
      .get(accountID)
    return row
      ? {
          accountID: row.account_id,
          sequence: row.sequence,
          payload: JSON.parse(row.payload),
          signature: row.signature,
          digest: row.digest,
          updatedAt: row.updated_at,
        }
      : null
  }
  return {
    get,
    put: async (accountID: string, input: unknown, authorized: () => boolean = () => true) => {
      const update = structuredClone(Schema.decodeUnknownSync(Update, { onExcessProperty: "error" })(input))
      if (update.payload.accountID !== accountID || update.sequence !== update.payload.sequence)
        throw new Error("Roster account/sequence mismatch")
      const payload = SecureChannel.canonicalJSON(update.payload)
      if (Buffer.byteLength(payload) > 65536) throw new Error("Roster exceeds size limit")
      const signature = Buffer.from(update.signature, "base64url")
      if (signature.length !== 64 || signature.toString("base64url") !== update.signature)
        throw new Error("Invalid roster signature encoding")
      // Shape, curve points and canonical digest are checked; only local Agents verify signer authority.
      if ((await DeviceRoster.fingerprint(update.payload)) !== update.digest) throw new Error("Roster digest mismatch")
      const updatedAt = Date.now()
      database.transaction(() => {
        if (!authorized()) throw new Error("Hub login revoked or expired")
        if (!database.query('SELECT id FROM "user" WHERE id=?').get(accountID))
          throw new Error("Hub account unavailable")
        const current = get(accountID)
        if (current && current.sequence >= update.sequence) throw new Error("Roster sequence conflict")
        database
          .query(
            `INSERT INTO hub_account_roster(account_id,sequence,payload,signature,digest,updated_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(account_id) DO UPDATE SET sequence=excluded.sequence,payload=excluded.payload,signature=excluded.signature,digest=excluded.digest,updated_at=excluded.updated_at`,
          )
          .run(accountID, update.sequence, payload, update.signature, update.digest, updatedAt)
        database
          .query("INSERT INTO hub_roster_history VALUES(?,?,?,?,?,?)")
          .run(accountID, update.sequence, payload, update.signature, update.digest, updatedAt)
        database
          .query(
            "DELETE FROM hub_roster_history WHERE account_id=? AND sequence NOT IN (SELECT sequence FROM hub_roster_history WHERE account_id=? ORDER BY sequence DESC LIMIT 16)",
          )
          .run(accountID, accountID)
      })()
      return get(accountID)!
    },
    history: (accountID: string) =>
      database
        .query<{ sequence: number; digest: string; updated_at: number }, [string]>(
          "SELECT sequence,digest,updated_at FROM hub_roster_history WHERE account_id=? ORDER BY sequence DESC LIMIT 16",
        )
        .all(accountID)
        .map((row) => ({ sequence: row.sequence, digest: row.digest, updatedAt: row.updated_at })),
  }
}
