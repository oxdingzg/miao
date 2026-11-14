export * as PushRegistry from "./push-registry"

import { Database } from "bun:sqlite"
import { HubAuth } from "./hub-auth"

export type Registration = { deviceID: string; token: string; environment: "sandbox" | "production" }
export type Target = Registration & {
  accountID: string
  sessionID: string
  registeredAt: number
  registrationID: string
}

/** Private routing metadata; neither account login nor a push token grants Runtime access. */
export function migrate(database: Database) {
  database.transaction(() => {
    database.exec(`CREATE TABLE IF NOT EXISTS hub_push_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL
    )`)
    const version = database.query<{ version: number }, []>("SELECT version FROM hub_push_schema WHERE id = 1").get()
    if (version && version.version !== 1) throw new Error("Unsupported Hub push schema")
    database.exec(`CREATE TABLE IF NOT EXISTS hub_push_device (
      account_id TEXT NOT NULL REFERENCES "user" (id),
      device_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      token TEXT NOT NULL,
      environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
      registered_at INTEGER NOT NULL,
      registration_id TEXT NOT NULL,
      PRIMARY KEY (account_id, device_id),
      UNIQUE (environment, token)
    )`)
    database.query("INSERT OR IGNORE INTO hub_push_schema (id, version) VALUES (1, 1)").run()
  })()
}

export function open(database: Database) {
  if (database.query<{ version: number }, []>("SELECT version FROM hub_push_schema WHERE id = 1").get()?.version !== 1)
    throw new Error("Hub push metadata requires migration")
  function active(principal: HubAuth.Principal) {
    return (
      principal.expiresAt > Date.now() &&
      database
        .query<
          { expiresAt: string | number },
          [string, string]
        >('SELECT s."expiresAt" FROM "session" s JOIN "user" u ON u.id = s."userId" WHERE s.id = ? AND s."userId" = ?')
        .get(principal.sessionID, principal.accountID)
    )
  }
  return {
    async register(principal: HubAuth.Principal, input: Registration, authorized: () => boolean) {
      if (!/^[A-Za-z0-9_-]{87}$/.test(input.deviceID)) throw new Error("Invalid push device identity")
      const publicKey = Buffer.from(input.deviceID, "base64url")
      if (publicKey.length !== 65 || publicKey[0] !== 4 || publicKey.toString("base64url") !== input.deviceID)
        throw new Error("Invalid push device identity")
      await crypto.subtle.importKey("raw", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
      if (!/^(?:[a-fA-F0-9]{2}){16,256}$/.test(input.token)) throw new Error("Invalid push device token")
      if (input.environment !== "sandbox" && input.environment !== "production")
        throw new Error("Invalid push environment")
      return database.transaction(() => {
        const session = active(principal)
        if (!session || new Date(session.expiresAt).getTime() <= Date.now() || !authorized())
          throw new Error("Hub login revoked or expired")
        const existing = database
          .query<
            { registered_at: number },
            [string, string]
          >("SELECT registered_at FROM hub_push_device WHERE account_id = ? AND device_id = ?")
          .get(principal.accountID, input.deviceID)
        const count = database
          .query<{ count: number }, [string]>("SELECT count(*) AS count FROM hub_push_device WHERE account_id = ?")
          .get(principal.accountID)!.count
        if (!existing && count >= 32) throw new Error("Hub push device limit")
        // Strictly advance even for replacements within one clock tick. Late invalidations cannot erase a fresh registration.
        const registeredAt = Math.max(Date.now(), (existing?.registered_at ?? 0) + 1)
        const registrationID = crypto.randomUUID()
        database
          .query(
            `INSERT INTO hub_push_device (account_id, device_id, session_id, token, environment, registered_at, registration_id)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, device_id) DO UPDATE SET
          session_id = excluded.session_id, token = excluded.token, environment = excluded.environment,
          registered_at = excluded.registered_at, registration_id = excluded.registration_id`,
          )
          .run(
            principal.accountID,
            input.deviceID,
            principal.sessionID,
            input.token.toLowerCase(),
            input.environment,
            registeredAt,
            registrationID,
          )
        return { registeredAt, registrationID }
      })()
    },
    targets(accountID: string): Target[] {
      return database
        .query<
          {
            account_id: string
            device_id: string
            session_id: string
            token: string
            environment: "sandbox" | "production"
            registered_at: number
            registration_id: string
            expiresAt: string | number
          },
          [string]
        >(
          `SELECT p.*, s."expiresAt" FROM hub_push_device p JOIN "session" s
        ON s.id = p.session_id AND s."userId" = p.account_id JOIN "user" u ON u.id = p.account_id
        WHERE p.account_id = ? ORDER BY p.device_id LIMIT 32`,
        )
        .all(accountID)
        .filter((row) => new Date(row.expiresAt).getTime() > Date.now())
        .map((row) => ({
          accountID: row.account_id,
          deviceID: row.device_id,
          sessionID: row.session_id,
          token: row.token,
          environment: row.environment,
          registeredAt: row.registered_at,
          registrationID: row.registration_id,
        }))
    },
    revoke(principal: HubAuth.Principal, deviceID: string) {
      const session = active(principal)
      if (!session || new Date(session.expiresAt).getTime() <= Date.now())
        throw new Error("Hub login revoked or expired")
      return (
        database
          .query("DELETE FROM hub_push_device WHERE account_id = ? AND device_id = ?")
          .run(principal.accountID, deviceID).changes === 1
      )
    },
    invalidate(target: Target, timestamp?: number) {
      if (timestamp !== undefined && (!Number.isSafeInteger(timestamp) || timestamp < target.registeredAt)) return false
      return (
        database
          .query(
            `DELETE FROM hub_push_device WHERE account_id = ? AND device_id = ?
        AND session_id = ? AND token = ? AND environment = ? AND registered_at = ? AND registration_id = ?`,
          )
          .run(
            target.accountID,
            target.deviceID,
            target.sessionID,
            target.token,
            target.environment,
            target.registeredAt,
            target.registrationID,
          ).changes === 1
      )
    },
    prune() {
      return database
        .query(
          `DELETE FROM hub_push_device WHERE NOT EXISTS (
        SELECT 1 FROM "session" s JOIN "user" u ON u.id = s."userId"
        WHERE s.id = hub_push_device.session_id AND s."userId" = hub_push_device.account_id
        AND julianday(s."expiresAt") > julianday('now'))`,
        )
        .run().changes
    },
  }
}
