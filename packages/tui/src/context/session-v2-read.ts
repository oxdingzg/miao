import type { Session, SessionV2Info } from "@miao/sdk/v2"

/**
 * Maps a V2 `SessionV2Info` into the V1 `Session` shape the TUI store and
 * components already use. V2 has no `slug` or `version`, and exposes the
 * location as `location`/`subpath` instead of `directory`/`path`.
 */
export function sessionInfo(session: SessionV2Info): Session {
  return {
    id: session.id,
    slug: session.id,
    projectID: session.projectID,
    workspaceID: session.location.workspaceID,
    directory: session.location.directory,
    path: session.subpath,
    parentID: session.parentID,
    cost: session.cost,
    tokens: session.tokens,
    title: session.title,
    agent: session.agent,
    model: session.model,
    version: "",
    time: session.time,
    revert: session.revert && {
      messageID: session.revert.messageID,
      partID: session.revert.partID,
      snapshot: session.revert.snapshot,
      diff: session.revert.diff,
    },
  }
}
