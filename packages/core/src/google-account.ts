export * as GoogleAccount from "./google-account"

import { createServer } from "node:http"
import { createHash, randomBytes } from "node:crypto"
import { Deferred, Effect, Schema } from "effect"
import type { IntegrationOAuthMethodRegistration } from "@miao/plugin/v2/effect/integration"
import { Credential } from "./credential"
import { Integration } from "./integration"
import { OauthCallbackPage } from "./oauth/page"

// Personal-account backend protocol is documented by the MIT community
// reference pinned in google-account/NOTICE.md. OAuth application credentials
// are deployment configuration, never copied third-party secrets in the binary.
export const providerID = "google-account"
export const browserMethodID = Integration.MethodID.make("google-account-browser")
export const manualMethodID = Integration.MethodID.make("google-account-manual")
export const defaults = {
  clientID: process.env.MIAO_GOOGLE_ACCOUNT_CLIENT_ID ?? "",
  clientSecret: process.env.MIAO_GOOGLE_ACCOUNT_CLIENT_SECRET ?? "",
  authorizeURL: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenURL: "https://oauth2.googleapis.com/token",
  userInfoURL: "https://www.googleapis.com/oauth2/v2/userinfo",
  baseURL: "https://daily-cloudcode-pa.googleapis.com",
  redirectURI: "http://localhost:51121/oauth-callback",
  userAgent: "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
}

export type Options = typeof defaults

export class RequestError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super(
      `Google account ${operation} failed (HTTP ${status}). ${status === 401 ? "Reconnect the Google account." : status === 403 ? "The account may not be eligible for this model service." : status === 429 ? "The account quota is exhausted; retry after its reset." : "Retry the request or check the service status."}`,
    )
    this.name = "GoogleAccount.RequestError"
  }
}

const Tokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
})

export const oauth = (options: Options = defaults, manual = false, integrationID = Integration.ID.make(providerID)) =>
  ({
    integrationID,
    method: {
      id: manual ? manualMethodID : browserMethodID,
      type: "oauth",
      label: manual ? "Google account (paste browser callback URL)" : "Google account (browser, no API key)",
    },
    label: (value) => (typeof value.metadata?.email === "string" ? value.metadata.email : undefined),
    authorize: (_inputs: Integration.Inputs) =>
      Effect.gen(function* () {
        if (!options.clientID || !options.clientSecret)
          return yield* Effect.fail(
            new Error(
              "Google OAuth application is not configured. Set MIAO_GOOGLE_ACCOUNT_CLIENT_ID and MIAO_GOOGLE_ACCOUNT_CLIENT_SECRET in the host environment, then restart miao. These identify the OAuth application, not a Gemini API key.",
            ),
          )
        const verifier = randomBytes(32).toString("base64url")
        const state = randomBytes(32).toString("base64url")
        const redirect = new URL(options.redirectURI)
        const url = new URL(options.authorizeURL)
        url.search = new URLSearchParams({
          client_id: options.clientID,
          redirect_uri: options.redirectURI,
          response_type: "code",
          scope: options.scopes.join(" "),
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
          state,
          access_type: "offline",
          prompt: "consent",
        }).toString()
        const complete = (callback: URL) =>
          Effect.tryPromise({
            try: (signal) =>
              exchange(
                callbackCode(callback, redirect, state),
                verifier,
                manual ? manualMethodID : browserMethodID,
                integrationID,
                options,
                signal,
              ),
            catch: (cause) => cause,
          })
        if (manual)
          return {
            mode: "code" as const,
            url: url.href,
            instructions:
              "Sign in with your personal Google account. Paste the complete localhost callback URL from the browser address bar, including code and state; do not paste a password, cookie or API key.",
            callback: (value: string) =>
              Effect.gen(function* () {
                const callback = yield* Effect.try({
                  try: () => new URL(value.trim()),
                  catch: () => new Error("Paste the complete browser callback URL, not just the authorization code."),
                })
                return yield* complete(callback)
              }),
          }
        const code = yield* Deferred.make<URL>()
        const server = createServer((request, response) => {
          const callback = new URL(request.url ?? "/", redirect.origin)
          if (request.method !== "GET" || callback.pathname !== redirect.pathname) {
            response.writeHead(404).end("Not found")
            return
          }
          // A stray callback cannot settle/cancel another attempt, even if it
          // contains an OAuth error. Keep the PKCE verifier on this process only.
          if (callback.searchParams.get("state") !== state) {
            response
              .writeHead(400, { "Content-Type": "text/html", "Cache-Control": "no-store" })
              .end(OauthCallbackPage.error("Invalid OAuth state", { provider: "Google" }))
            return
          }
          if (!callback.searchParams.has("code") && !callback.searchParams.has("error")) {
            response.writeHead(400).end("Missing OAuth result")
            return
          }
          Effect.runFork(Deferred.succeed(code, callback))
          response
            .writeHead(callback.searchParams.has("error") ? 400 : 200, {
              "Content-Type": "text/html",
              "Cache-Control": "no-store",
            })
            .end(
              callback.searchParams.has("error")
                ? OauthCallbackPage.error("Google authorization was declined. Return to miao to retry.", {
                    provider: "Google",
                  })
                : "<!doctype html><html><head><meta charset=utf-8><title>Google authorization received</title></head><body><h1>Google authorization received</h1><p>Return to miao. Token exchange and model-service eligibility are still being verified there.</p></body></html>",
            )
        })
        yield* Effect.callback<void, Error>((resume) => {
          server.once("error", (error) => resume(Effect.fail(error)))
          server.listen(Number(redirect.port), redirect.hostname, () => resume(Effect.void))
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
        return {
          mode: "auto" as const,
          url: url.href,
          instructions:
            "Complete Google authorization in your browser. Model access is checked separately; a successful website login alone does not establish model-service eligibility.",
          callback: Deferred.await(code).pipe(Effect.flatMap(complete), Effect.timeout("5 minutes")),
        }
      }),
    refresh: (value) =>
      Effect.tryPromise({
        try: (signal) => refresh(Schema.decodeUnknownSync(Credential.OAuth)(value), options, signal),
        catch: (cause) => cause,
      }),
  }) satisfies IntegrationOAuthMethodRegistration

function callbackCode(callback: URL, redirect: URL, state: string) {
  if (
    callback.origin !== redirect.origin ||
    callback.pathname !== redirect.pathname ||
    callback.searchParams.get("state") !== state
  )
    throw new Error("Invalid Google OAuth callback or state")
  if (callback.searchParams.has("error"))
    throw new Error("Google authorization was declined or failed. Start a new login attempt.")
  const code = callback.searchParams.get("code")
  if (!code) throw new Error("Missing Google authorization code")
  return code
}

async function tokens(body: Record<string, string>, options: Options, signal?: AbortSignal) {
  if (!options.clientID || !options.clientSecret)
    throw new Error("Google OAuth application is not configured in this host environment")
  const response = await fetch(options.tokenURL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: options.clientID, client_secret: options.clientSecret }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    redirect: "error",
  })
  if (!response.ok) throw new RequestError("token exchange", response.status)
  const value = Schema.decodeUnknownSync(Tokens)(await response.json())
  if (!value.access_token || !Number.isFinite(value.expires_in) || value.expires_in <= 0)
    throw new Error("Google returned an invalid token lifetime or access token")
  return value
}

async function exchange(
  code: string,
  verifier: string,
  methodID: Integration.MethodID,
  integrationID: Integration.ID,
  options: Options,
  signal?: AbortSignal,
) {
  const issuedAt = Date.now()
  const value = await tokens(
    { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: options.redirectURI },
    options,
    signal,
  )
  if (!value.refresh_token)
    throw new Error("Google did not issue an offline refresh token. Reconnect and approve offline access.")
  const projectID = await project(value.access_token, options, signal)
  const available = Schema.decodeUnknownSync(
    Schema.Struct({
      models: Schema.Record(
        Schema.String,
        Schema.Struct({ disabled: Schema.optional(Schema.Boolean), selectable: Schema.optional(Schema.Boolean) }),
      ),
    }),
  )(await request(value.access_token, "fetchAvailableModels", { project: projectID }, options, signal))
  if (
    !Object.entries(available.models).some(
      ([id, model]) => id.startsWith("gemini-") && !model.disabled && model.selectable !== false,
    )
  )
    throw new Error("This Google account has no callable Gemini models on the personal model service.")
  const response = await fetch(options.userInfoURL, {
    headers: { Authorization: `Bearer ${value.access_token}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    redirect: "error",
  })
  const info = response.ok
    ? Schema.decodeUnknownSync(Schema.Struct({ email: Schema.optional(Schema.String) }))(await response.json())
    : undefined
  return Credential.OAuth.make({
    type: "oauth",
    methodID,
    access: value.access_token,
    refresh: value.refresh_token,
    expires: issuedAt + value.expires_in * 1000,
    metadata: { projectID, oauthOwner: "miao/google-account", integrationID, ...(info?.email ? { email: info.email } : {}) },
  })
}

export async function refresh(value: Credential.OAuth, options: Options = defaults, signal?: AbortSignal) {
  const issuedAt = Date.now()
  const next = await tokens({ grant_type: "refresh_token", refresh_token: value.refresh }, options, signal)
  return Credential.OAuth.make({
    ...value,
    access: next.access_token,
    refresh: next.refresh_token ?? value.refresh,
    expires: issuedAt + next.expires_in * 1000,
  })
}

export async function request(
  access: string,
  operation: string,
  body: unknown,
  options: Options = defaults,
  signal?: AbortSignal,
) {
  const response = await fetch(`${options.baseURL}/v1internal:${operation}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", "User-Agent": options.userAgent },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    redirect: "error",
  })
  if (!response.ok) throw new RequestError(operation, response.status)
  return response.json() as Promise<unknown>
}

const Project = Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })])
const Load = Schema.Struct({
  cloudaicompanionProject: Schema.optional(Project),
  allowedTiers: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, isDefault: Schema.optional(Schema.Boolean) })),
  ),
})

export async function project(access: string, options: Options = defaults, signal?: AbortSignal) {
  const metadata = { ideType: "ANTIGRAVITY" }
  const loaded = Schema.decodeUnknownSync(Load)(await request(access, "loadCodeAssist", { metadata }, options, signal))
  const known =
    typeof loaded.cloudaicompanionProject === "string"
      ? loaded.cloudaicompanionProject
      : loaded.cloudaicompanionProject?.id
  if (known) return known
  const tier = loaded.allowedTiers?.find((item) => item.isDefault)
  if (!tier)
    throw new Error(
      "This Google account has no eligible personal model-service tier. Gemini website access alone does not grant access to this service.",
    )
  for (let attempt = 0; attempt < 10; attempt++) {
    const onboarded = Schema.decodeUnknownSync(
      Schema.Struct({
        done: Schema.optional(Schema.Boolean),
        response: Schema.optional(Schema.Struct({ cloudaicompanionProject: Schema.optional(Project) })),
      }),
    )(await request(access, "onboardUser", { tierId: tier.id, metadata }, options, signal))
    const found = onboarded.response?.cloudaicompanionProject
    const id = typeof found === "string" ? found : found?.id
    if (onboarded.done && id) return id
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }, 1000)
      const abort = () => {
        clearTimeout(timer)
        reject(signal?.reason ?? new Error("Google onboarding cancelled"))
      }
      if (signal?.aborted) abort()
      else signal?.addEventListener("abort", abort, { once: true })
    })
  }
  throw new Error("Google account onboarding did not complete. Retry login later.")
}


/** Only this registered OAuth method owns host refresh; it is not a generic fallback. */
export function owns(integrationID: string, value: Credential.Value): value is Credential.OAuth {
  return value.type === "oauth" && value.metadata?.oauthOwner === "miao/google-account" && value.metadata.integrationID === integrationID &&
    (value.methodID === browserMethodID || value.methodID === manualMethodID)
}
