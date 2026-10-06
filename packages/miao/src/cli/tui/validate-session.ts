import { createClient } from "@/client"
// The core session module drags in the database; the TUI thread only needs the ID schema.
import { SessionSchema } from "@miao/core/session/schema"
import { Schema } from "effect"

const decodeSessionID = Schema.decodeUnknownSync(SessionSchema.ID)

export async function validateSession(input: {
  url: string
  sessionID?: string
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
}) {
  if (!input.sessionID) return

  let sessionID: SessionSchema.ID
  try {
    sessionID = decodeSessionID(input.sessionID)
  } catch (error) {
    throw new Error(`Invalid session ID: ${error instanceof Error ? error.message : "unknown error"}`, { cause: error })
  }

  const error = await createClient({
    baseUrl: input.url,
    directory: input.directory,
    fetch: input.fetch,
    headers: input.headers,
  })
    .sessions.get({ sessionID })
    .then(
      () => undefined,
      (error: unknown) => error,
    )
  if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "SessionNotFoundError")
    throw new Error(`Session not found: ${sessionID}`)
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "SessionLocationMissingError"
  ) {
    const body = error as { directory?: unknown }
    throw new Error(
      `Session ${sessionID} can no longer be loaded: its directory "${String(body.directory)}" no longer exists`,
      { cause: { body: error } },
    )
  }
  if (error !== undefined) throw new Error("Failed to load session", { cause: { body: error } })
}
