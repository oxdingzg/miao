import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Credential } from "@miao/core/credential"
import { Integration } from "@miao/core/integration"
import { GoogleAccount } from "@miao/core/google-account"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const fixture = Effect.fn("GoogleAccount.fixture")(function* () {
  const state = { grants: [] as URLSearchParams[], reject: false, eligible: true, hasModels: true, duringRefresh: async () => {} }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await request.text())
        state.grants.push(form)
        if (state.reject)
          return Response.json(
            { error: "invalid_grant", error_description: "fixture-private-refresh-must-not-leak" },
            { status: 400 },
          )
        if (form.get("grant_type") === "refresh_token") await state.duringRefresh()
        return Response.json({
          access_token: form.get("grant_type") === "refresh_token" ? "fixture-refreshed-access" : "fixture-access",
          expires_in: 3600,
          ...(form.get("grant_type") === "authorization_code" ? { refresh_token: "fixture-refresh" } : {}),
        })
      }
      if (request.headers.get("authorization") !== "Bearer fixture-access") return new Response(null, { status: 401 })
      if (url.pathname === "/v1internal:loadCodeAssist")
        return Response.json(state.eligible ? { cloudaicompanionProject: "fixture-project" } : { allowedTiers: [] })
      if (url.pathname === "/v1internal:fetchAvailableModels")
        return Response.json({ models: state.hasModels ? { "gemini-fixture": { displayName: "Fixture Gemini" } } : {} })
      if (url.pathname === "/userinfo") return Response.json({ email: "person@example.test" })
      return new Response(null, { status: 404 })
    },
  })
  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
  const base = server.url.toString().replace(/\/$/, "")
  const options = {
    ...GoogleAccount.defaults,
    authorizeURL: `${base}/authorize`,
    tokenURL: `${base}/token`,
    userInfoURL: `${base}/userinfo`,
    baseURL: base,
    clientID: "fixture-public-client",
    clientSecret: "fixture-installed-client",
    userAgent: "miao-fixture",
  }
  return { state, options }
})

function callback(url: string, redirect: string, code = "fixture-code") {
  const output = new URL(redirect)
  output.searchParams.set("code", code)
  output.searchParams.set("state", new URL(url).searchParams.get("state") ?? "")
  return output
}

it.live("Google account manual OAuth validates state and exchanges PKCE without exposing the verifier", () =>
  Effect.gen(function* () {
    const { state, options } = yield* fixture()
    const method = GoogleAccount.oauth(options, true)
    const auth = yield* method.authorize({})
    if (auth.mode !== "code") throw new Error("expected manual callback")
    const url = new URL(auth.url)
    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.has("code_verifier")).toBe(false)
    const wrong = callback(auth.url, options.redirectURI)
    wrong.searchParams.set("state", "attacker-state")
    const refused = yield* Effect.exit(auth.callback(wrong.href))
    expect(refused._tag).toBe("Failure")
    expect(state.grants).toHaveLength(0)
    const value = yield* auth.callback(callback(auth.url, options.redirectURI).href)
    expect(value.methodID).toBe(GoogleAccount.manualMethodID)
    expect(value.access).toBe("fixture-access")
    expect(value.refresh).toBe("fixture-refresh")
    expect(value.metadata).toMatchObject({ projectID: "fixture-project", email: "person@example.test", oauthOwner: "miao/google-account", integrationID: GoogleAccount.providerID })
    expect(value.expires).toBeGreaterThan(Date.now())
    const grant = state.grants[0]
    expect(grant.get("redirect_uri")).toBe(options.redirectURI)
    expect(grant.get("grant_type")).toBe("authorization_code")
    const verifier = grant.get("code_verifier")
    if (!verifier) throw new Error("missing verifier")
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge") ?? "")
    expect(url.searchParams.get("state")).not.toContain(verifier)
  }),
)

it.live("Google account refresh retains an unrotated refresh token and account metadata", () =>
  Effect.gen(function* () {
    const { state, options } = yield* fixture()
    const method = GoogleAccount.oauth(options, true)
    const auth = yield* method.authorize({})
    if (auth.mode !== "code") throw new Error("expected manual callback")
    const original = yield* auth.callback(callback(auth.url, options.redirectURI).href)
    const next = yield* Effect.promise(() =>
      GoogleAccount.refresh({ ...original, access: "expired", expires: 1 }, options),
    )
    expect(next.access).toBe("fixture-refreshed-access")
    expect(next.refresh).toBe(original.refresh)
    expect(next.metadata).toEqual(original.metadata)
    expect(next.methodID).toBe(original.methodID)
    expect(state.grants.at(-1)?.get("grant_type")).toBe("refresh_token")
    expect(state.grants.at(-1)?.get("refresh_token")).toBe("fixture-refresh")
  }),
)

it.live("Google website login is not accepted without a project entitlement and callable model", () =>
  Effect.gen(function* () {
    const { state, options } = yield* fixture()
    const method = GoogleAccount.oauth(options, true)
    const auth = yield* method.authorize({})
    if (auth.mode !== "code") throw new Error("expected manual callback")
    state.eligible = false
    expect((yield* Effect.exit(auth.callback(callback(auth.url, options.redirectURI).href)))._tag).toBe("Failure")
    state.eligible = true
    state.hasModels = false
    expect((yield* Effect.exit(auth.callback(callback(auth.url, options.redirectURI).href)))._tag).toBe("Failure")
  }),
)

it.live("Google declined and malformed callbacks do not reach the token endpoint", () =>
  Effect.gen(function* () {
    const { state, options } = yield* fixture()
    const auth = yield* GoogleAccount.oauth(options, true).authorize({})
    if (auth.mode !== "code") throw new Error("expected manual callback")
    const denied = callback(auth.url, options.redirectURI)
    denied.searchParams.delete("code")
    denied.searchParams.set("error", "access_denied")
    denied.searchParams.set("error_description", "fixture-private-refresh-must-not-leak")
    for (const value of [
      denied.href,
      "bare-authorization-code",
      callback(auth.url, "http://other.example.test/oauth-callback").href,
    ]) {
      const error = yield* auth.callback(value).pipe(Effect.flip)
      expect(String(error)).not.toContain("fixture-private-refresh-must-not-leak")
    }
    expect(state.grants).toHaveLength(0)
  }),
)

it.live("loopback OAuth ignores a stray callback, then finishes the correct attempt", () =>
  Effect.gen(function* () {
    const { state, options } = yield* fixture()
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") })
    const redirectURI = `http://127.0.0.1:${reservation.port}/oauth-callback`
    yield* Effect.promise(() => reservation.stop(true))
    const value = yield* Effect.scoped(
      Effect.gen(function* () {
        const auth = yield* GoogleAccount.oauth({ ...options, redirectURI }).authorize({})
        if (auth.mode !== "auto") throw new Error("expected loopback callback")
        const stray = callback(auth.url, redirectURI)
        stray.searchParams.set("state", "other-attempt")
        const bad = yield* Effect.promise(() => fetch(stray))
        expect(bad.status).toBe(400)
        yield* Effect.promise(() => bad.text())
        expect(state.grants).toHaveLength(0)
        const correct = yield* Effect.promise(() => fetch(callback(auth.url, redirectURI)))
        expect(correct.status).toBe(200)
        expect(yield* Effect.promise(() => correct.text())).toContain("eligibility are still being verified")
        return yield* auth.callback
      }),
    )
    expect(value.methodID).toBe(GoogleAccount.browserMethodID)
    expect(state.grants).toHaveLength(1)
  }),
)

it.live("OAuth failures redact server descriptions instead of exposing tokens", () =>
  Effect.gen(function* () {
    const { state, options } = yield* fixture()
    state.reject = true
    const auth = yield* GoogleAccount.oauth(options, true).authorize({})
    if (auth.mode !== "code") throw new Error("expected manual callback")
    const error = yield* auth.callback(callback(auth.url, options.redirectURI).href).pipe(Effect.flip)
    expect(String(error)).toContain("HTTP 400")
    expect(String(error)).not.toContain("fixture-private-refresh-must-not-leak")
  }),
)

const broker = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node])))
broker.live("Google OAuth persists only verified grants and refreshes through the existing broker", () =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service
    const { state, options } = yield* fixture()
    const method = GoogleAccount.oauth(options, true)
    yield* integrations.transform((editor) => editor.method.update(method))
    const integrationID = Integration.ID.make(GoogleAccount.providerID)
    const attempt = yield* integrations.connection.oauth({
      integrationID,
      methodID: GoogleAccount.manualMethodID,
      inputs: {},
    })
    yield* integrations.attempt.complete({
      attemptID: attempt.attemptID,
      code: callback(attempt.url, options.redirectURI).href,
    })
    const saved = yield* credentials.list(integrationID)
    expect(saved).toHaveLength(1)
    const entry = saved[0]
    if (entry.value.type !== "oauth") throw new Error("expected OAuth credential")
    expect(entry.value.metadata?.projectID).toBe("fixture-project")
    yield* credentials.update(entry.id, { value: { ...entry.value, access: "expired-access", expires: 1 } })
    const active = yield* integrations.connection.active(integrationID)
    if (!active) throw new Error("missing active connection")
    const next = yield* integrations.connection.resolve(active)
    expect(next?.type === "oauth" ? next.access : undefined).toBe("fixture-refreshed-access")
    const persisted = yield* credentials.get(entry.id)
    expect(persisted?.value.type === "oauth" ? persisted.value.access : undefined).toBe("fixture-refreshed-access")
    expect(state.grants.at(-1)?.get("grant_type")).toBe("refresh_token")
  }),
)

it.live("missing OAuth application configuration fails before opening a browser callback", () =>
  Effect.gen(function* () {
    const { state, options } = yield* fixture()
    const error = yield* GoogleAccount.oauth({ ...options, clientID: "", clientSecret: "" })
      .authorize({})
      .pipe(Effect.flip)
    expect(String(error)).toContain("MIAO_GOOGLE_ACCOUNT_CLIENT_ID")
    expect(state.grants).toHaveLength(0)
  }),
)


broker.live("disconnect during a Google token exchange cannot resurrect the removed credential", () => Effect.gen(function* () {
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  const { state, options } = yield* fixture()
  yield* integrations.transform((editor) => editor.method.update(GoogleAccount.oauth(options, true)))
  const integrationID = Integration.ID.make(GoogleAccount.providerID)
  const entry = yield* credentials.create({integrationID,value:Credential.OAuth.make({type:"oauth",methodID:GoogleAccount.manualMethodID,access:"expired",refresh:"fixture-refresh",expires:1,metadata:{projectID:"fixture-project"}})})
  state.duringRefresh = () => Effect.runPromise(credentials.remove(entry.id))
  const result = yield* integrations.connection.resolve({type:"credential",id:entry.id,label:entry.label,active:true})
  expect(result).toBeUndefined()
  expect(yield* credentials.get(entry.id)).toBeUndefined()
}))
