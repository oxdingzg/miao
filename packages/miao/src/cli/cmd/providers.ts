import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"
import { ModelsCatalog } from "@miao/core/models-catalog"
import { Credential } from "@miao/core/credential"
import { Integration } from "@miao/core/integration"
import { PluginV2 } from "@miao/core/plugin"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Location } from "@miao/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@miao/core/location-services"
import { AbsolutePath } from "@miao/core/schema"
import { Deferred, Effect, Option } from "effect"

const locationScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })),
    ),
    Effect.provide(locationServiceMapLayer),
  )

const promptValue = <Value>(value: Option.Option<Value>) => {
  if (Option.isNone(value)) return Effect.die(new UI.CancelledError())
  return Effect.succeed(value.value)
}

export const ProvidersCommand = cmd({
  command: "providers",
  aliases: ["auth"],
  describe: "manage AI providers and credentials",
  builder: (yargs) =>
    yargs.command(ProvidersListCommand).command(ProvidersLoginCommand).command(ProvidersLogoutCommand).demandCommand(),
  async handler() {},
})

export const ProvidersListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list providers and credentials",
  // Lists global credentials + provider env vars; no project instance needed.
  instance: false,
  handler: Effect.fn("Cli.providers.list")(function* (_args) {
    const credentials = yield* Credential.Service.use((store) => store.all())
    const modelsCatalog = yield* ModelsCatalog.Service

    UI.empty()
    yield* Prompt.intro("Credentials")
    const database = yield* modelsCatalog.get()

    for (const credential of credentials) {
      const name = database[credential.integrationID]?.name || credential.integrationID
      yield* Prompt.log.info(`${name} ${UI.Style.TEXT_DIM}${credential.value.type}`)
    }

    yield* Prompt.outro(`${credentials.length} credentials`)

    const activeEnvVars: Array<{ provider: string; envVar: string }> = []

    for (const [providerID, provider] of Object.entries(database)) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) {
          activeEnvVars.push({
            provider: provider.name || providerID,
            envVar,
          })
        }
      }
    }

    if (activeEnvVars.length > 0) {
      UI.empty()
      yield* Prompt.intro("Environment")

      for (const { provider, envVar } of activeEnvVars) {
        yield* Prompt.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      yield* Prompt.outro(`${activeEnvVars.length} environment variable` + (activeEnvVars.length === 1 ? "" : "s"))
    }
  }, Effect.provide(LayerNode.compile(Credential.node))),
})

export const ProvidersLoginCommand = effectCmd({
  command: "login [provider]",
  describe: "log in to a provider",
  // The core integration registry is location-scoped; the handler opens its own
  // scope, so no instance bootstrap is needed.
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("provider", {
        describe: "provider id or name to log in to",
        type: "string",
      })
      .option("method", {
        alias: ["m"],
        describe: "login method label (skips method selection)",
        type: "string",
      }),
  handler: (args) =>
    Effect.gen(function* () {
      UI.empty()
      yield* Prompt.intro("Add credential")

      // The catalog plugin registers one integration per provider; without its
      // boot barrier the registry is empty (same trap as `debug v2`).
      yield* Deferred.await((yield* PluginV2.Service).booted)

      const modelsCatalog = yield* ModelsCatalog.Service
      yield* Effect.ignore(modelsCatalog.refresh(true))
      const catalog = yield* modelsCatalog.get()

      const integrations = yield* Integration.Service
      const infos = yield* integrations.list()
      const priority: Record<string, number> = {
        opencode: 0,
        openai: 1,
        "github-copilot": 2,
        google: 3,
        anthropic: 4,
        openrouter: 5,
        vercel: 6,
      }
      const options = infos
        .filter((info) => info.methods.some((method) => method.type !== "env"))
        .toSorted(
          (a, b) =>
            (priority[a.id] ?? 99) - (priority[b.id] ?? 99) ||
            (catalog[a.id]?.name ?? a.name ?? a.id).localeCompare(catalog[b.id]?.name ?? b.name ?? b.id),
        )
        .map((info) => ({
          label: catalog[info.id]?.name ?? info.name ?? info.id,
          value: info.id as string,
          hint: (
            {
              opencode: "recommended",
              openai: "ChatGPT Plus/Pro or API key",
            } as Record<string, string | undefined>
          )[info.id],
        }))

      if (options.length === 0) {
        yield* Prompt.log.error("No provider with login methods is available")
        yield* Prompt.outro("Done")
        return
      }

      const requested = args.provider
      const match = requested
        ? (options.find((option) => option.value === requested) ??
          options.find((option) => option.label.toLowerCase() === requested.toLowerCase()))
        : undefined
      if (requested && !match) return yield* fail(`Unknown provider "${requested}"`)
      const providerID =
        match?.value ??
        (yield* promptValue(
          yield* Prompt.autocomplete({
            message: "Select provider",
            maxItems: 8,
            options,
          }),
        ))

      const info = yield* integrations.get(Integration.ID.make(providerID))
      if (!info) return yield* fail(`Provider "${providerID}" is not available`)
      const methods = info.methods.filter((method) => method.type === "key" || method.type === "oauth")
      if (methods.length === 0) return yield* fail(`No login methods available for "${providerID}"`)

      const label = (method: (typeof methods)[number]) => method.label ?? method.type
      const requestedMethod = args.method
      const requestedIndex = requestedMethod
        ? methods.findIndex((method) => label(method).toLowerCase() === requestedMethod.toLowerCase())
        : -1
      if (requestedMethod && requestedIndex === -1) {
        return yield* fail(
          `Unknown method "${requestedMethod}" for ${providerID}. Available: ${methods.map(label).join(", ")}`,
        )
      }
      const method =
        requestedIndex !== -1
          ? methods[requestedIndex]
          : methods[
              yield* promptValue(
                yield* Prompt.select({
                  message: "Login method",
                  options: methods.map((method, index) => ({ label: label(method), value: index })),
                }),
              )
            ]

      if (method.type === "key") {
        if (providerID === "opencode" || providerID === "opencode-go") {
          yield* Prompt.log.info("Create an api key at https://opencode.ai/auth")
        }
        if (providerID === "vercel") {
          yield* Prompt.log.info("You can create an api key at https://vercel.link/ai-gateway-token")
        }
        const apiKey = yield* promptValue(
          yield* Prompt.password({
            message: "Enter your API key",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          }),
        )
        yield* integrations.connection
          .key({ integrationID: info.id, key: apiKey })
          .pipe(Effect.catch((error) => fail(error.message)))
        yield* Prompt.outro("Done")
        return
      }

      const attempt = yield* integrations.connection
        .oauth({ integrationID: info.id, methodID: method.id, inputs: {} })
        .pipe(Effect.catch((error) => fail(error.message)))
      if (attempt.url) yield* Prompt.log.info("Go to: " + attempt.url)
      if (attempt.instructions) yield* Prompt.log.info(attempt.instructions)
      if (attempt.mode === "code") {
        const code = yield* promptValue(
          yield* Prompt.text({
            message: "Paste the authorization code here: ",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          }),
        )
        yield* integrations.attempt
          .complete({ attemptID: attempt.attemptID, code })
          .pipe(Effect.catch((error) => fail(error.message)))
      }

      const spinner = Prompt.spinner()
      yield* spinner.start("Waiting for authorization...")
      const status = yield* awaitAttempt(integrations, attempt.attemptID)
      if (status.status === "complete") {
        yield* spinner.stop("Login successful")
      } else {
        yield* spinner.stop("Failed to authorize", 1)
        yield* Prompt.log.error("message" in status ? status.message : `Authorization ${status.status}`)
      }
      yield* Prompt.outro("Done")
    }).pipe(locationScope),
})

/**
 * Poll a pending OAuth attempt until it settles. The core attempt expires on
 * its own, so the loop terminates even when the user never finishes.
 */
function awaitAttempt(integrations: Integration.Interface, attemptID: Integration.AttemptID) {
  return Effect.gen(function* () {
    while (true) {
      const status = yield* integrations.attempt.status(attemptID)
      if (status.status !== "pending") return status
      yield* Effect.sleep("1 seconds")
    }
  })
}

export const ProvidersLogoutCommand = effectCmd({
  command: "logout [provider]",
  describe: "log out from a configured provider",
  builder: (yargs) =>
    yargs.positional("provider", {
      describe: "provider id or name to log out from",
      type: "string",
    }),
  // Removes a global auth credential; no project instance needed.
  instance: false,
  handler: Effect.fn("Cli.providers.logout")(function* (args) {
    const credentials = yield* Credential.Service.use((store) => store.all())
    const modelsCatalog = yield* ModelsCatalog.Service

    UI.empty()
    yield* Prompt.intro("Remove credential")
    if (credentials.length === 0) {
      yield* Prompt.log.error("No credentials found")
      return
    }
    const database = yield* modelsCatalog.get()
    const options = credentials.map((credential) => ({
      label:
        (database[credential.integrationID]?.name || credential.integrationID) +
        UI.Style.TEXT_DIM +
        " (" +
        credential.value.type +
        ")",
      value: credential.id,
    }))
    const provider = args.provider
      ? options.find(
          (option) => {
            const integrationID = credentials.find((credential) => credential.id === option.value)?.integrationID
            return (
              option.value === args.provider ||
              integrationID === args.provider ||
              database[integrationID ?? ""]?.name?.toLowerCase() === args.provider?.toLowerCase()
            )
          },
        )?.value
      : yield* promptValue(
          yield* Prompt.autocomplete({
            message: "Select provider",
            maxItems: 8,
            options,
          }),
        )
    if (!provider) return yield* fail(`Unknown configured provider "${args.provider}"`)
    yield* Credential.Service.use((store) => store.remove(provider))
    yield* Prompt.outro("Logout successful")
  }, Effect.provide(LayerNode.compile(Credential.node))),
})
