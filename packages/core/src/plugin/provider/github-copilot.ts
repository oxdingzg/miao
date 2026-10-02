import { Effect, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"
import type { IntegrationOAuthMethodRegistration } from "@opencode-ai/plugin/v2/effect/integration"
import { Credential } from "../../credential"
import { EventV2 } from "../../event"
import { CopilotModels } from "../../github-copilot/models"
import { InstallationVersion } from "../../installation/version"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { define } from "../define"

const clientID = "Ov23li8tweQw6odWQebz"
// Add a small safety buffer when polling to avoid hitting the server slightly
// too early due to clock skew / timer drift.
const pollingSafetyMargin = 3000
const methodID = Integration.MethodID.make("github-copilot-device")
const integrationID = Integration.ID.make("github-copilot")

/**
 * GitHub device flow. The GitHub OAuth token it yields is sent to the Copilot
 * API as-is (no Copilot token exchange) and does not expire, so the method has
 * no refresh; the credential stores it as both access and refresh, matching
 * the V1 `auth.json` entry that `Integration.legacyOAuth` adopts.
 */
const device = {
  integrationID,
  method: {
    id: methodID,
    type: "oauth",
    label: "Login with GitHub Copilot",
    prompts: [
      {
        type: "select",
        key: "deploymentType",
        message: "Select GitHub deployment type",
        options: [
          { label: "GitHub.com", value: "github.com", hint: "Public" },
          { label: "GitHub Enterprise", value: "enterprise", hint: "Data residency or self-hosted" },
        ],
      },
      {
        type: "text",
        key: "enterpriseUrl",
        message: "Enter your GitHub Enterprise URL or domain",
        placeholder: "company.ghe.com or https://company.ghe.com",
        when: { key: "deploymentType", op: "eq", value: "enterprise" },
      },
    ],
  },
  authorize: (inputs) =>
    Effect.gen(function* () {
      const enterprise = inputs.deploymentType === "enterprise" && inputs.enterpriseUrl
      const domain = enterprise ? CopilotModels.normalizeDomain(inputs.enterpriseUrl!) : "github.com"
      const code = yield* post<{ verification_uri: string; user_code: string; device_code: string; interval: number }>(
        `https://${domain}/login/device/code`,
        { client_id: clientID, scope: "read:user" },
      )
      return {
        mode: "auto" as const,
        url: code.verification_uri,
        instructions: `Enter code: ${code.user_code}`,
        callback: Effect.gen(function* () {
          // RFC 8628 §3.5: a slow_down answer adds 5 seconds to the interval.
          let interval = code.interval * 1000
          while (true) {
            const data = yield* post<{ access_token?: string; error?: string; interval?: number }>(
              `https://${domain}/login/oauth/access_token`,
              {
                client_id: clientID,
                device_code: code.device_code,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              },
            )
            if (data.access_token)
              return Credential.OAuth.make({
                type: "oauth",
                methodID,
                access: data.access_token,
                refresh: data.access_token,
                expires: 0,
                ...(enterprise ? { metadata: { enterpriseUrl: domain } } : {}),
              })
            if (data.error === "slow_down") interval = (data.interval ?? code.interval + 5) * 1000
            if (data.error && data.error !== "authorization_pending" && data.error !== "slow_down")
              return yield* Effect.fail(new Error(`GitHub device authorization failed: ${data.error}`))
            yield* Effect.sleep(interval + pollingSafetyMargin)
          }
        }),
      }
    }),
} satisfies IntegrationOAuthMethodRegistration

export const GithubCopilotPlugin = define<HttpClient.HttpClient | EventV2.Service>({
  id: "github-copilot",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    const events = yield* EventV2.Service
    // The account's model list from the last lookup, keyed by API base + token.
    const cache = new Map<string, { readonly expires: number; readonly models?: CopilotModels.Remote[] }>()

    const lookup = Effect.fn("GithubCopilotPlugin.lookup")(function* (connectionID: Integration.ID) {
      const connection = yield* ctx.integration.connection.active(connectionID)
      const credential =
        connection === undefined
          ? undefined
          : yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
      // Only a Copilot login can list models; an env GITHUB_TOKEN keeps the models.dev catalog.
      if (credential?.type !== "oauth") return undefined
      const enterpriseUrl = credential.metadata?.enterpriseUrl
      const base = CopilotModels.baseURL(typeof enterpriseUrl === "string" ? enterpriseUrl : undefined)
      const key = `${base}\n${credential.refresh}`
      const cached = cache.get(key)
      if (cached && cached.expires > Date.now()) return cached.models && { base, models: cached.models }
      const models = yield* CopilotModels.list({ baseURL: base, token: credential.refresh, http })
      // Retry a failed lookup soon, but not on every reload while the API is down.
      cache.set(key, { expires: Date.now() + (models ? 10 * 60_000 : 30_000), models })
      return models && { base, models }
    })

    yield* ctx.integration.transform((draft) => {
      draft.method.update(device)
    })

    // A login made while the process runs reaches an open catalog.
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.filter((event) => event.data.integrationID === integrationID),
      Stream.runForEach(() => ctx.catalog.reload()),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* ctx.catalog.transform((evt) =>
      Effect.gen(function* () {
        const item = evt.provider.get(ProviderV2.ID.githubCopilot)
        if (!item) return
        if (item.models.has(ModelV2.ID.make("gpt-5-chat-latest")))
          evt.model.update(item.provider.id, ModelV2.ID.make("gpt-5-chat-latest"), (model) => {
            // This chat-only alias conflicts with the Copilot GPT-5 Responses route,
            // so hide it only for Copilot rather than for every provider catalog.
            model.enabled = false
          })
        const found = yield* lookup(Integration.ID.make(item.provider.integrationID ?? integrationID))
        if (!found) return
        const remote = new Map(found.models.map((model) => [model.id, model]))
        // Catalog entries the account cannot call are pruned; the rest take the
        // account's endpoint, limits, and prices, keeping configured names.
        const known = new Set<string>()
        for (const [modelID, model] of item.models) {
          const match = remote.get(model.api.id)
          if (!match) {
            evt.model.remove(item.provider.id, modelID)
            continue
          }
          known.add(match.id)
          evt.model.update(item.provider.id, modelID, (draft) => CopilotModels.apply(draft, match, found.base, true))
        }
        for (const match of found.models) {
          if (known.has(match.id)) continue
          evt.model.update(item.provider.id, ModelV2.ID.make(match.id), (draft) =>
            CopilotModels.apply(draft, match, found.base, false),
          )
        }
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/github-copilot") return
        const mod = yield* Effect.promise(() => import("../../github-copilot/copilot-provider"))
        evt.sdk = mod.createOpenaiCompatible(evt.options)
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.githubCopilot) return
        if (evt.sdk.responses === undefined && evt.sdk.chat === undefined) {
          evt.language = evt.sdk.languageModel(evt.model.api.id)
          return
        }
        if (evt.options.endpoint === "responses" && evt.sdk.responses) {
          evt.language = evt.sdk.responses(evt.model.api.id)
          return
        }
        if (evt.options.endpoint === "chat" && evt.sdk.chat) {
          evt.language = evt.sdk.chat(evt.model.api.id)
          return
        }
        const match = /^gpt-(\d+)/.exec(evt.model.api.id)
        // Copilot supports Responses for GPT-5 class models, except mini variants
        // which still need the chat-completions endpoint.
        evt.language =
          match && Number(match[1]) >= 5 && !evt.model.api.id.startsWith("gpt-5-mini") && evt.sdk.responses
            ? evt.sdk.responses(evt.model.api.id)
            : evt.sdk.chat(evt.model.api.id)
      }),
    )
  }),
})

function post<A>(url: string, body: Record<string, string>) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": `miao/${InstallationVersion}`,
        },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) throw new Error(`Request failed: ${response.status}`)
      return response.json() as Promise<A>
    },
    catch: (cause) => cause,
  })
}
