import { makeGlobalNode } from "../effect/app-node"
import path from "path"
import { serviceUse } from "../effect/service-use"
import { Global } from "../global"
import { Effect, Layer, Context, Option, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { EffectFlock } from "../util/effect-flock"

export const Tokens = Schema.Struct({
  accessToken: Schema.mutableKey(Schema.String),
  refreshToken: Schema.mutableKey(Schema.optional(Schema.String)),
  expiresAt: Schema.mutableKey(Schema.optional(Schema.Number)),
  scope: Schema.mutableKey(Schema.optional(Schema.String)),
})
export type Tokens = Schema.Schema.Type<typeof Tokens>

export const ClientInfo = Schema.Struct({
  clientId: Schema.mutableKey(Schema.String),
  clientSecret: Schema.mutableKey(Schema.optional(Schema.String)),
  clientIdIssuedAt: Schema.mutableKey(Schema.optional(Schema.Number)),
  clientSecretExpiresAt: Schema.mutableKey(Schema.optional(Schema.Number)),
})
export type ClientInfo = Schema.Schema.Type<typeof ClientInfo>

export const Entry = Schema.Struct({
  tokens: Schema.mutableKey(Schema.optional(Tokens)),
  clientInfo: Schema.mutableKey(Schema.optional(ClientInfo)),
  codeVerifier: Schema.mutableKey(Schema.optional(Schema.String)),
  oauthState: Schema.mutableKey(Schema.optional(Schema.String)),
  serverUrl: Schema.mutableKey(Schema.optional(Schema.String)),
  /** The authorization server these tokens came from. Entries sharing an
   * issuer share one grant: adoption, rotation fan-out and the refresh lock
   * are all keyed by it. Legacy entries without it keep working untouched. */
  issuer: Schema.optional(Schema.String),
})
export type Entry = Schema.Schema.Type<typeof Entry>

const decodeAuthData = Schema.decodeUnknownOption(Schema.Record(Schema.String, Entry))
type AuthData = Record<string, Entry>

const filepath = path.join(Global.Path.data, "mcp-auth.json")
const lockKey = `mcp-auth:${filepath}`

export interface Interface {
  readonly updateTokensIfCurrent: (
    mcpName: string,
    serverUrl: string,
    expected: Entry,
    tokens: Tokens,
  ) => Effect.Effect<boolean>

  readonly withRefreshLock: <A, E, R>(
    mcpName: string,
    serverUrl: string,
    body: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | EffectFlock.LockError, R>

  readonly all: () => Effect.Effect<Record<string, Entry>>
  readonly get: (mcpName: string) => Effect.Effect<Entry | undefined>
  readonly getForUrl: (mcpName: string, serverUrl: string) => Effect.Effect<Entry | undefined>
  readonly set: (mcpName: string, entry: Entry, serverUrl?: string) => Effect.Effect<void>
  readonly remove: (mcpName: string) => Effect.Effect<void>
  readonly updateTokens: (mcpName: string, tokens: Tokens, serverUrl?: string) => Effect.Effect<void>
  readonly updateClientInfo: (mcpName: string, clientInfo: ClientInfo, serverUrl?: string) => Effect.Effect<void>
  readonly updateCodeVerifier: (mcpName: string, codeVerifier: string) => Effect.Effect<void>
  readonly clearCodeVerifier: (mcpName: string) => Effect.Effect<void>
  readonly updateOAuthState: (mcpName: string, oauthState: string) => Effect.Effect<void>
  readonly getOAuthState: (mcpName: string) => Effect.Effect<string | undefined>
  readonly clearOAuthState: (mcpName: string) => Effect.Effect<void>
  readonly findByIssuer: (issuer: string) => Effect.Effect<Record<string, Entry>>
  readonly adopt: (
    mcpName: string,
    serverUrl: string,
    donor: { readonly name: string; readonly entry: Entry },
  ) => Effect.Effect<boolean>
  readonly updateTokensForIssuer: (
    issuer: string,
    except: string | undefined,
    tokens: Tokens,
  ) => Effect.Effect<void>
  readonly freshFromIssuer: (issuer: string, except: string | undefined) => Effect.Effect<Tokens | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@miao/McpAuth") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service

    const read = Effect.fn("McpAuth.read")(function* () {
      return yield* fs.readJson(filepath).pipe(
        Effect.map((data): AuthData => Option.getOrElse(decodeAuthData(data), () => ({}) as AuthData) as AuthData),
        Effect.catch(() => Effect.succeed({} as AuthData)),
      )
    })

    const all = Effect.fn("McpAuth.all")(function* () {
      return yield* read().pipe(flock.withLock(lockKey), Effect.orDie)
    })

    const mutate = Effect.fn("McpAuth.mutate")(function* (update: (data: AuthData) => AuthData | undefined) {
      yield* Effect.gen(function* () {
        const next = update(yield* read())
        if (!next) return
        yield* fs.writeJson(filepath, next, 0o600).pipe(Effect.orDie)
      }).pipe(flock.withLock(lockKey), Effect.orDie)
    })

    const get = Effect.fn("McpAuth.get")(function* (mcpName: string) {
      const data = yield* all()
      return data[mcpName]
    })

    const getForUrl = Effect.fn("McpAuth.getForUrl")(function* (mcpName: string, serverUrl: string) {
      const entry = yield* get(mcpName)
      if (!entry) return undefined
      if (!entry.serverUrl) return undefined
      if (entry.serverUrl !== serverUrl) return undefined
      return entry
    })

    const findByIssuer = Effect.fn("McpAuth.findByIssuer")(function* (issuer: string) {
      const data = yield* all()
      const found: Record<string, Entry> = {}
      for (const [mcpName, entry] of Object.entries(data)) {
        if (entry.issuer === issuer && entry.tokens) found[mcpName] = entry
      }
      return found
    })

    const adopt = Effect.fn("McpAuth.adopt")(function* (
      mcpName: string,
      serverUrl: string,
      donor: { readonly name: string; readonly entry: Entry },
    ) {
      if (!donor.entry.tokens) return false
      const expected = JSON.stringify(donor.entry.tokens)
      let adopted = false
      yield* mutate((data) => {
        // Re-check under the write lock: the donor may have rotated or been
        // removed while this effect waited.
        const source = data[donor.name]
        if (source?.tokens === undefined || JSON.stringify(source.tokens) !== expected) return undefined
        const current = data[mcpName]
        const next: Entry = { ...(current ?? {}), issuer: source.issuer, tokens: source.tokens }
        if (source.clientInfo && !current?.clientInfo) next.clientInfo = source.clientInfo
        if (serverUrl) next.serverUrl = serverUrl
        adopted = true
        return { ...data, [mcpName]: next }
      })
      return adopted
    })

    const updateTokensForIssuer = Effect.fn("McpAuth.updateTokensForIssuer")(function* (
      issuer: string,
      except: string | undefined,
      tokens: Tokens,
    ) {
      yield* mutate((data) => {
        let changed = false
        const next: AuthData = {}
        for (const [mcpName, entry] of Object.entries(data)) {
          if (mcpName === except || entry.issuer !== issuer || !entry.tokens) {
            next[mcpName] = entry
            continue
          }
          changed = true
          next[mcpName] = {
            ...entry,
            tokens: {
              ...tokens,
              // Refresh responses may omit an unchanged refresh token.
              refreshToken: tokens.refreshToken ?? entry.tokens.refreshToken,
            },
          }
        }
        return changed ? next : undefined
      })
    })

    const freshFromIssuer = Effect.fn("McpAuth.freshFromIssuer")(function* (
      issuer: string,
      except: string | undefined,
    ) {
      const data = yield* all()
      const now = Date.now() / 1000
      let freshest: Tokens | undefined
      for (const [mcpName, entry] of Object.entries(data)) {
        if (mcpName === except || entry.issuer !== issuer || !entry.tokens) continue
        if (entry.tokens.expiresAt !== undefined && entry.tokens.expiresAt <= now + 30) continue
        if (freshest === undefined || (entry.tokens.expiresAt ?? Infinity) > (freshest.expiresAt ?? Infinity))
          freshest = entry.tokens
      }
      return freshest
    })

    const set = Effect.fn("McpAuth.set")(function* (mcpName: string, entry: Entry, serverUrl?: string) {
      yield* mutate((data) => ({
        ...data,
        [mcpName]: serverUrl ? { ...entry, serverUrl } : entry,
      }))
    })

    const remove = Effect.fn("McpAuth.remove")(function* (mcpName: string) {
      yield* mutate((data) => {
        const next = { ...data }
        delete next[mcpName]
        return next
      })
    })

    const updateField = <K extends keyof Entry>(field: K, spanName: string) =>
      Effect.fn(`McpAuth.${spanName}`)(function* (mcpName: string, value: NonNullable<Entry[K]>, serverUrl?: string) {
        yield* mutate((data) => {
          const current = data[mcpName]
          const entry: Entry = serverUrl && current?.serverUrl !== serverUrl ? {} : (current ?? {})
          entry[field] = value
          if (serverUrl) entry.serverUrl = serverUrl
          return { ...data, [mcpName]: entry }
        })
      })

    const clearField = (field: keyof Entry, spanName: string) =>
      Effect.fn(`McpAuth.${spanName}`)(function* (mcpName: string) {
        yield* mutate((data) => {
          const entry = data[mcpName]
          if (!entry) return undefined
          delete entry[field]
          return { ...data, [mcpName]: entry }
        })
      })

    const updateTokens = Effect.fn("McpAuth.updateTokens")(function* (
      mcpName: string,
      tokens: Tokens,
      serverUrl?: string,
    ) {
      yield* mutate((data) => {
        const current = data[mcpName]
        const entry: Entry = serverUrl && current?.serverUrl !== serverUrl ? {} : (current ?? {})
        return {
          ...data,
          [mcpName]: {
            ...entry,
            ...(serverUrl ? { serverUrl } : {}),
            tokens: {
              ...tokens,
              // OAuth refresh responses may omit an unchanged refresh token.
              // Re-read and preserve it under the same file lock as the write.
              refreshToken: tokens.refreshToken ?? entry.tokens?.refreshToken,
            },
          },
        }
      })
    })
    const updateClientInfo = updateField("clientInfo", "updateClientInfo")
    const updateCodeVerifier = updateField("codeVerifier", "updateCodeVerifier")
    const updateOAuthState = updateField("oauthState", "updateOAuthState")
    const clearCodeVerifier = clearField("codeVerifier", "clearCodeVerifier")
    const clearOAuthState = clearField("oauthState", "clearOAuthState")

    const getOAuthState = Effect.fn("McpAuth.getOAuthState")(function* (mcpName: string) {
      const entry = yield* get(mcpName)
      return entry?.oauthState
    })

    return Service.of({
      updateTokensIfCurrent: (mcpName, serverUrl, expected, tokens) =>
        Effect.gen(function* () {
          const data = yield* read()
          const entry = data[mcpName]
          if (entry?.serverUrl !== serverUrl || !entry.tokens || JSON.stringify(entry) !== JSON.stringify(expected))
            return false
          yield* fs
            .writeJson(
              filepath,
              {
                ...data,
                [mcpName]: {
                  ...entry,
                  tokens: { ...tokens, refreshToken: tokens.refreshToken ?? entry.tokens.refreshToken },
                },
              },
              0o600,
            )
            .pipe(Effect.orDie)
          return true
        }).pipe(flock.withLock(lockKey), Effect.orDie),
      withRefreshLock: (mcpName, serverUrl, body) =>
        Effect.gen(function* () {
          // Entries sharing an issuer share one grant, so their refreshes
          // must serialize against each other, not just against themselves.
          const entry = yield* get(mcpName)
          const scope = entry?.issuer ?? JSON.stringify([mcpName, serverUrl])
          return yield* body.pipe(flock.withLock(`mcp-oauth-refresh:${filepath}:${scope}`))
        }),
      all,
      get,
      getForUrl,
      adopt,
      findByIssuer,
      updateTokensForIssuer,
      freshFromIssuer,
      set,
      remove,
      updateTokens,
      updateClientInfo,
      updateCodeVerifier,
      clearCodeVerifier,
      updateOAuthState,
      getOAuthState,
      clearOAuthState,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [FSUtil.node, EffectFlock.node] })

export * as McpAuth from "./auth"
