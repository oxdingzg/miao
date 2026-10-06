import type { Session } from "@miao/schema/view-models"
import type { SessionsListInput } from "@miao/client"
import type { SessionApi, SessionInfo } from "@/utils/server"
import { withTimestampedFallback } from "./session-title"

export function normalizeSessionInfo(input: SessionInfo | Session): Session {
  // The wire and the view model are the same V2 record now; the assertion only
  // sheds the generated type's readonly modifiers.
  return { ...input, title: withTimestampedFallback(input) } as Session
}

export async function listAllSessions(api: Pick<SessionApi, "list">, input: Omit<SessionsListInput, "cursor">) {
  const load = async (cursor?: string): Promise<Session[]> => {
    const result = await api.list({ ...input, limit: input.limit ?? 100, cursor })
    const sessions = result.data.map(normalizeSessionInfo)
    if (result.data.length === 0 || !result.cursor.next) return sessions
    return [...sessions, ...(await load(result.cursor.next))]
  }
  return load()
}
