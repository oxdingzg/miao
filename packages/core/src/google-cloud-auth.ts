export * as GoogleCloudAuth from "./google-cloud-auth"

import { Auth } from "@miao/llm/route"
import { Effect, Redacted } from "effect"
import type { GoogleAuth } from "google-auth-library"

let auth: GoogleAuth | undefined

/**
 * A Google Cloud access token from Application Default Credentials: the
 * `GOOGLE_APPLICATION_CREDENTIALS` service account file, `gcloud auth
 * application-default login`, or the metadata server. The library caches the
 * token and refreshes it before expiry, so this is cheap to call per request.
 */
export const token = Effect.tryPromise({
  try: async () => {
    if (!auth) {
      const { GoogleAuth } = await import("google-auth-library")
      auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
    }
    const client = await auth.getClient()
    const result = await client.getAccessToken()
    if (!result.token) throw new Error("empty token")
    return Redacted.make(result.token)
  },
  catch: () => new Auth.MissingCredentialError("Google Cloud Application Default Credentials"),
})
