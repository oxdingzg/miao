export * as HubAuth from "./hub-auth"

import { betterAuth } from "better-auth"
import { bearer, jwt } from "better-auth/plugins"
import { getMigrations } from "better-auth/db/migration"
import { createLocalJWKSet, jwtVerify } from "jose"
import { Database } from "bun:sqlite"
import { Schema } from "effect"

export type Options = {
  database: Database
  baseURL: string
  secret: string
  allowLoopbackHTTP?: boolean
}
export type Bootstrap = { email: string; password: string; name: string }
export type Principal = { accountID: string; sessionID: string; expiresAt: number }
const Claims = Schema.Struct({
  sub: Schema.String,
  sid: Schema.String,
  kind: Schema.Literal("hub-access"),
  exp: Schema.Number,
})

/** Account authentication grants directory access only. Agent-issued Grants remain the operation authority. */
export async function create(options: Options) {
  const url = new URL(options.baseURL)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    (url.protocol !== "https:" &&
      !(
        options.allowLoopbackHTTP &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("Hub authentication requires a root HTTPS URL")
  if (options.secret.length < 32) throw new Error("Hub authentication secret is too short")
  const baseURL = url.origin
  const factory = (disableSignUp: boolean, validateSchema = true) =>
    betterAuth({
      database: options.database,
      advanced: { database: { validateSchema } },
      baseURL,
      secret: options.secret,
      trustedOrigins: [baseURL],
      emailAndPassword: { enabled: true, disableSignUp, autoSignIn: false, minPasswordLength: 12 },
      session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60, cookieCache: { enabled: false } },
      rateLimit: { enabled: true, window: 60, max: 30 },
      plugins: [
        bearer({ requireSignature: true }),
        jwt({
          jwks: { keyPairConfig: { alg: "ES256" }, rotationInterval: 30 * 24 * 60 * 60, gracePeriod: 60 * 60 },
          jwt: {
            issuer: baseURL,
            audience: baseURL,
            expirationTime: "15m",
            definePayload: ({ user, session }) => ({ sub: user.id, sid: session.id, kind: "hub-access" }),
          },
        }),
      ],
    })
  // Migration discovery runs before creating the schema-validated serving instance.
  const initializer = factory(true, false)
  const migration = await getMigrations(initializer.options)
  await migration.runMigrations()
  await initializer.$context
  const auth = factory(true)
  const context = await auth.$context
  await context.explicitSchemaCheck?.()
  options.database.exec(
    "CREATE TABLE IF NOT EXISTS hub_bootstrap (id INTEGER PRIMARY KEY CHECK (id = 1), reservation TEXT NOT NULL)",
  )
  return {
    auth,
    /** Invoke only before exposing a listener, with a private one-time administrator configuration. */
    bootstrap: async (input: Bootstrap) => {
      const reservation = crypto.randomUUID()
      options.database.transaction(() => {
        if (options.database.query<{ count: number }, []>('SELECT count(*) AS count FROM "user"').get()!.count !== 0)
          throw new Error("Hub accounts already initialized")
        if (
          options.database.query("INSERT OR IGNORE INTO hub_bootstrap (id, reservation) VALUES (1, ?)").run(reservation)
            .changes !== 1
        )
          throw new Error("Hub administrator bootstrap already reserved")
      })()
      try {
        const bootstrap = factory(false)
        const result = await bootstrap.api.signUpEmail({ body: input })
        // Signup does not create a persistent login session; initialization is not a daily credential.
        return result.user.id
      } finally {
        options.database.query("DELETE FROM hub_bootstrap WHERE id = 1 AND reservation = ?").run(reservation)
      }
    },
    verify: async (token: string): Promise<Principal> => {
      if (token.length > 8192) throw new Error("Invalid Hub access token")
      const keys = await auth.api.getJwks()
      const verified = await jwtVerify(token, createLocalJWKSet(keys), {
        issuer: baseURL,
        audience: baseURL,
        algorithms: ["ES256"],
      })
      const claims = Schema.decodeUnknownSync(Claims)(verified.payload)
      const principal = { accountID: claims.sub, sessionID: claims.sid, expiresAt: claims.exp * 1000 }
      if (!active(options.database, principal)) throw new Error("Hub login revoked or expired")
      return principal
    },
    active: (principal: Principal) => active(options.database, principal),
  }
}

function active(database: Database, principal: Principal) {
  if (principal.expiresAt <= Date.now()) return false
  const session = database
    .query<
      { expiresAt: string | number },
      [string, string]
    >('SELECT s."expiresAt" FROM "session" s JOIN "user" u ON u.id = s."userId" WHERE s.id = ? AND s."userId" = ?')
    .get(principal.sessionID, principal.accountID)
  return session !== null && new Date(session.expiresAt).getTime() > Date.now()
}
