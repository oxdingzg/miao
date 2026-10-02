export * as AwsCredentials from "./aws-credentials"

import { AuthenticationReason, LLMError } from "@miao/llm"
import { Effect } from "effect"

type Identity = {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
}
type Provider = () => Promise<Identity>

// One chain per profile: the SDK chain memoizes and refreshes its credentials.
const chains = new Map<string, Provider>()

/**
 * AWS credentials from the standard Node provider chain: environment
 * variables, `~/.aws/credentials` and `~/.aws/config` (including SSO and
 * `credential_process`), web identity, and container or instance roles.
 * The chain module is loaded only when a SigV4-signed provider is used.
 */
export const resolve = (profile: string | undefined) =>
  Effect.tryPromise({
    try: async () => {
      const key = profile ?? ""
      const existing = chains.get(key)
      if (existing) return existing()
      const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers")
      const chain: Provider = fromNodeProviderChain(profile ? { profile } : {})
      chains.set(key, chain)
      return chain()
    },
    catch: (cause) =>
      new LLMError({
        module: "Auth",
        method: "apply",
        reason: new AuthenticationReason({
          message: `Missing AWS credentials${profile ? ` for profile ${profile}` : ""}: ${cause instanceof Error ? cause.message : String(cause)}`,
          kind: "missing",
        }),
      }),
  })
