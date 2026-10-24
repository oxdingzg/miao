import { Effect, Stream, Schema } from "effect"
import { define } from "../define"
import { GoogleAccount } from "../../google-account"
import { models, modelFetch } from "../../google-account/transport"
import { Credential } from "../../credential"
import { EventV2 } from "../../event"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { ProviderGateway } from "../../provider-gateway"


/** Personal Google-account model service, separate from Google API-key models. */
export const createGoogleAccountPlugin = (options: GoogleAccount.Options = GoogleAccount.defaults, identifier = GoogleAccount.providerID) => {
  const id = ProviderV2.ID.make(identifier)
  const integrationID = Integration.ID.make(identifier)
  return define<Credential.Service | Integration.Service | EventV2.Service>({
  id: identifier,
  effect: Effect.fn(function* (ctx) {
    const credentials = yield* Credential.Service
    const integration = yield* Integration.Service
    const events = yield* EventV2.Service
    const signatures = new Map<string, string>()
    const pendingRefresh = new Map<string, Promise<Credential.Value | undefined>>()
    let gateway: ReturnType<typeof Bun.serve> | undefined

    yield* Effect.addFinalizer(() => Effect.sync(() => gateway?.stop(true)))
    yield* ctx.integration.transform((draft) => {
      draft.update(integrationID, (item) => {
        item.name = "Gemini (Google account)"
      })
      draft.method.update(GoogleAccount.oauth(options, false, integrationID))
      draft.method.update(GoogleAccount.oauth(options, true, integrationID))
    })
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.filter((event) => event.data.integrationID === integrationID),
      Stream.runForEach(() => ctx.catalog.reload()),
      Effect.forkScoped({ startImmediately: true }),
    )

    const resolve = (entry: Credential.Info) => {
      const running = pendingRefresh.get(entry.id)
      if (running) return running
      const next = Effect.runPromise(
        integration.connection.resolve({ type: "credential", id: entry.id, label: entry.label, active: entry.active }),
      )
      pendingRefresh.set(entry.id, next)
      void next
        .finally(() => {
          if (pendingRefresh.get(entry.id) === next) pendingRefresh.delete(entry.id)
        })
        .catch(() => {})
      return next
    }

    const start = () =>
      (gateway ??= Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        async fetch(request) {
          if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
            return Response.json({ error: { message: "Unknown Google account bridge endpoint" } }, { status: 404 })
          const authorization = request.headers.get("authorization")
          if (!authorization?.startsWith("Bearer "))
            return Response.json({ error: { message: "Google account authorization is required" } }, { status: 401 })
          const token = authorization.slice(7)
          try {
            const saved = await Effect.runPromise(credentials.list(integrationID))
            const entry = saved.find((row) => row.value.type === "oauth" && row.value.access === token)
            if (!entry)
              return Response.json(
                { error: { message: "Google account credential is not registered" } },
                { status: 401 },
              )
            const value = await resolve(entry)
            if (value?.type !== "oauth" || typeof value.metadata?.projectID !== "string")
              return Response.json(
                { error: { message: "Reconnect the Google account to establish model-service access" } },
                { status: 401 },
              )
            const body = await request
              .json()
              .then(Schema.decodeUnknownSync(ProviderGateway.ChatRequestSchema))
              .catch(() => undefined)
            if (
              !body ||
              !Array.isArray(body.messages) ||
              typeof body.model !== "string" ||
              !body.model.startsWith("gemini-")
            )
              return Response.json(
                { error: { message: "A Gemini model and chat messages are required" } },
                { status: 400 },
              )
            if (body.stream === false)
              return Response.json(
                { error: { message: "The Google account bridge streams responses" } },
                { status: 400 },
              )
            const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
            const sdk = createGoogleGenerativeAI({
              apiKey: "google-account-oauth",
              fetch: modelFetch(value.access, value.metadata.projectID, options),
            })
            const prefix = `${entry.id}/${body.model}/`
            return await ProviderGateway.reply(sdk.languageModel(body.model), body, request.signal, body.model, {
              // Gemini documents this sentinel for reconstructed tool history.
              // Live calls retain and return the actual signature unchanged.
              get: (callID) => signatures.get(prefix + callID) ?? "skip_thought_signature_validator",
              set: (callID, signature) => {
                if (signatures.size >= 4096) {
                  const oldest = signatures.keys().next().value
                  if (oldest !== undefined) signatures.delete(oldest)
                }
                signatures.set(prefix + callID, signature)
              },
            })
          } catch (error) {
            const status = error instanceof GoogleAccount.RequestError ? error.status : 502
            return Response.json(
              {
                error: {
                  message:
                    error instanceof GoogleAccount.RequestError
                      ? error.message
                      : "Google account request failed; reconnect or retry.",
                  type: "google_account_error",
                },
              },
              { status },
            )
          }
        },
      }))

    yield* ctx.catalog.transform((catalog) =>
      Effect.gen(function* () {
        // Always expose the connection method, but never manufacture a callable
        // model list before the account has successfully discovered its models.
        // Attach the OAuth methods to the existing google provider so one
        // entry offers browser login AND API key. Never touch the provider
        // api/keys that API-key users rely on.
        catalog.provider.update(id, (provider) => {
          provider.integrationID = integrationID
        })
        const connection = yield* ctx.integration.connection.active(integrationID)
        if (!connection || connection.type !== "credential") return
        const value = yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (value?.type !== "oauth" || typeof value.metadata?.projectID !== "string") return
        const projectID = value.metadata.projectID
        const found = yield* Effect.tryPromise({
          try: (signal) => models(value.access, projectID, options, signal),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              cause instanceof GoogleAccount.RequestError ? cause.message : "Google account model discovery failed",
            ).pipe(Effect.as([])),
          ),
        )
        if (!found.length) return
        const server = start()
        const base = `http://127.0.0.1:${server.port}/v1`
        for (const remote of found)
          catalog.model.update(id, ModelV2.ID.make(remote.id), (model) => {
            model.name = `${remote.displayName ?? remote.id} (Google account)`
            model.api = {
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: base,
              id: ModelV2.ID.make(remote.id),
            }
            model.enabled = true
            model.limit = { context: remote.maxTokens ?? 200_000, output: remote.maxOutputTokens ?? 32_768 }
            model.capabilities = {
              tools: true,
              input: remote.supportsImages ? ["text", "image"] : ["text"],
              output: ["text"],
            }
            // Included subscription quotas are not a measured per-token invoice.
            model.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
          })
      }),
    )
  }),
})

}

export const GoogleAccountPlugin = createGoogleAccountPlugin()
