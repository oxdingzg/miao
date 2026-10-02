export * as AzureEntra from "./azure-entra"

import { execFile } from "node:child_process"
import { Auth } from "@miao/llm/route"
import { Effect, Option, Redacted, Schema } from "effect"

/** Token audience for Azure OpenAI and Azure AI Foundry. */
const RESOURCE = "https://cognitiveservices.azure.com"
/** Refresh this long before the CLI-reported expiry. */
const SKEW = 5 * 60_000

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

let cached: { readonly token: string; readonly expires: number } | undefined

/**
 * A Microsoft Entra access token for Azure OpenAI from the Azure CLI login
 * (`az login`), cached until shortly before it expires. This is the link of
 * `DefaultAzureCredential` that needs no extra dependency; a service principal
 * or managed identity can configure an `Authorization` header instead.
 */
export const token = Effect.gen(function* () {
  if (cached && cached.expires - SKEW > Date.now()) return Redacted.make(cached.token)
  const output = yield* Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) =>
        execFile(
          "az",
          ["account", "get-access-token", "--resource", RESOURCE, "--output", "json"],
          { timeout: 30_000 },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        ),
      ),
    catch: () => new Auth.MissingCredentialError("Azure API key, or a Microsoft Entra login (az login)"),
  })
  const parsed = parse(output)
  if (!parsed) return yield* Effect.fail(new Auth.MissingCredentialError("Azure CLI access token"))
  cached = parsed
  return Redacted.make(parsed.token)
})

const parse = (output: string) => {
  const value = Option.getOrUndefined(decodeJson(output))
  if (typeof value !== "object" || value === null) return
  const record = value as Record<string, unknown>
  if (typeof record.accessToken !== "string") return
  // `expires_on` (epoch seconds) is present on current CLIs; `expiresOn` is local time.
  const expires =
    typeof record.expires_on === "number"
      ? record.expires_on * 1000
      : typeof record.expiresOn === "string"
        ? Date.parse(record.expiresOn)
        : Date.now() + 30 * 60_000
  return { token: record.accessToken, expires: Number.isNaN(expires) ? Date.now() + 30 * 60_000 : expires }
}
