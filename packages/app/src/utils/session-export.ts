import type { Message, Part } from "@miao/sdk/v2/client"
import type { SessionInfo, SessionMessageInfo } from "@/utils/server"
import type { ServerApi } from "./server"

// Matches the version 2 archive written by `miao export` and read by `miao import`:
// a V1-compatible session record and transcript plus the V2 projection.
export type SessionExportData = {
  version: 2
  info: {
    id: string
    slug: string
    projectID: string
    directory: string
    path?: string
    parentID?: string
    title: string
    version: string
    cost: number
    tokens: SessionInfo["tokens"]
    time: SessionInfo["time"]
  }
  messages: {
    info: Message
    parts: Part[]
  }[]
  projection: SessionMessageInfo[]
}

export type SessionExportApi = {
  sessions: Pick<ServerApi["sessions"], "get">
  messages: Pick<ServerApi["messages"], "list">
}

// The server rejects message pages larger than 200.
const PAGE_LIMIT = 200

export async function fetchSessionExport(input: {
  sessionID: string
  api: SessionExportApi
}): Promise<SessionExportData> {
  const [session, projection] = await Promise.all([
    input.api.sessions.get({ sessionID: input.sessionID }),
    fetchProjection(input.api, input.sessionID),
  ])

  return {
    version: 2,
    info: {
      id: session.id,
      slug: session.id,
      projectID: session.projectID,
      directory: session.location.directory,
      path: session.subpath,
      parentID: session.parentID,
      title: session.title,
      version: "v2",
      cost: session.cost,
      tokens: session.tokens,
      time: session.time,
    },
    // The app has no V2 to V1 message converter; `miao import` restores from `projection`.
    messages: [],
    projection,
  }
}

// Pages oldest first through the whole timeline, including messages before any compaction.
async function fetchProjection(
  api: SessionExportApi,
  sessionID: string,
  cursor?: string,
): Promise<SessionMessageInfo[]> {
  const page = await api.messages.list(
    cursor ? { sessionID, limit: PAGE_LIMIT, cursor } : { sessionID, limit: PAGE_LIMIT, order: "asc" },
  )
  if (page.data.length < PAGE_LIMIT || !page.cursor.next) return [...page.data]
  return [...page.data, ...(await fetchProjection(api, sessionID, page.cursor.next))]
}

export function sessionExportFilename(session: { id: string; title?: string; slug?: string }) {
  const name = session.title || session.slug || session.id
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
  return `${clean || session.id}.json`
}

export function downloadSessionExport(filename: string, data: unknown) {
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
