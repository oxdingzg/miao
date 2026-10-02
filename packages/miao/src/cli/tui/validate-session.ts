import { createOpencodeClient } from "@opencode-ai/sdk/v2"
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

  const result = await createOpencodeClient({
    baseUrl: input.url,
    directory: input.directory,
    fetch: input.fetch,
    headers: input.headers,
  }).v2.session.get({ sessionID })
  if (result.response.status === 404) throw new Error(`Session not found: ${sessionID}`)
  if (result.error !== undefined) throw new Error("Failed to load session", { cause: { body: result.error } })
}
