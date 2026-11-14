import { Effect, Schema } from "effect"
import { Credential } from "../credential"
import { GoogleAccount } from "../google-account"

/** Only the built-in Google OAuth owner can rotate its inherited row. Account
 * management and every other inherited credential remain read-only. */
export const writeSharedCredential = Effect.fn("GoogleAccount.writeSharedCredential")(function* (
  expected: Credential.Info,
  value: Credential.Value,
) {
  const file = yield* Credential.SharedDatabasePath
  if (
    !file ||
    expected.source !== "shared" ||
    !GoogleAccount.owns(expected.integrationID, expected.value) ||
    !GoogleAccount.owns(expected.integrationID, value) ||
    value.expires <= Date.now()
  )
    return yield* Effect.fail(new Error("Google account refresh has no valid credential owner"))
  yield* Effect.tryPromise({
    try: async () => {
      const { Database } = await import("bun:sqlite")
      const db = new Database(file, { readwrite: true, strict: true })
      try {
        // Compare the exact old value so another window's rotation or account
        // edit cannot be overwritten after the network refresh completes.
        const row = db
          .query<{ value: string }, [string, string]>("SELECT value FROM credential WHERE id=? AND integration_id=?")
          .get(expected.id, expected.integrationID)
        if (
          !row ||
          !Schema.toEquivalence(Credential.Value)(
            Schema.decodeUnknownSync(Credential.Value)(
              Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(row.value),
            ),
            expected.value,
          )
        )
          throw new Error("Google account changed during refresh; retry with the current connection")
        const result = db
          .query("UPDATE credential SET value=? WHERE id=? AND integration_id=? AND value=?")
          .run(JSON.stringify(value), expected.id, expected.integrationID, row.value)
        if (result.changes !== 1)
          throw new Error("Google account changed during refresh; retry with the current connection")
      } finally {
        db.close()
      }
    },
    catch: () => new Error("Could not persist the refreshed Google account; retry with the current connection"),
  })
})
