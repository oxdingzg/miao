import { Project } from "@miao/schema/project"
import type { Location } from "@miao/schema/location"
import { SessionInfo } from "@miao/schema/session-info"
import type { SessionID } from "@miao/schema/session-id"
import { DateTime } from "effect"

/**
 * Project the engine-owned Session snapshot into the product record the HTTP
 * API serves. Native Sessions are stored by the engine, so its snapshot is the
 * authority for identity, title, and time; the caller supplies the resolved
 * project and Location because those are placement facts, not engine facts.
 *
 * Honesty rules, matching the agreed conventions: `cost` stays 0 (pricing is
 * a product catalog the engine does not own), `tokens` are 0 until the engine
 * reports usage, `agent`/`model` stay unknown (the engine knows collaboration
 * mode, not product identities), and a missing creation time renders as epoch
 * only for Sessions that predate the metadata column.
 */
export function nativeSessionInfo(input: {
  sessionID: SessionID
  projectID: Project.ID
  location: Location.Ref
  snapshot: Readonly<Record<string, unknown>>
}): SessionInfo.Info {
  const created = number(input.snapshot["created_at_ms"])
  const updated = number(input.snapshot["updated_at_ms"])
  const title = input.snapshot["title"]
  return {
    id: input.sessionID,
    projectID: input.projectID,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created: DateTime.makeUnsafe(created ?? 0),
      updated: DateTime.makeUnsafe(updated ?? created ?? 0),
    },
    title: typeof title === "string" ? title : "",
    location: input.location,
  }
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
