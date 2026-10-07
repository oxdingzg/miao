import { Binary } from "@miao/core/util/binary"
import type { FileDiffInfo } from "@/utils/server"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { Message, Part, Project, Session, SessionStatus, Todo } from "@miao/schema/view-models"
import type { PermissionRequest, QuestionRequest } from "@miao/schema/view-models"
import type { State, VcsCache } from "./types"
import { trimSessions } from "./session-trim"
import { dropSessionCaches } from "./session-cache"
import { diffs as list, message as clean } from "@/utils/diffs"
import { messageKey } from "@/utils/session-message"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

export function applyGlobalEvent(input: {
  event: { type: string; properties?: unknown }
  project: Project[]
  setGlobalProject: (next: Project[] | ((draft: Project[]) => Project[])) => void
  refresh: () => void
}) {
  if (input.event.type === "global.disposed" || input.event.type === "server.connected") {
    input.refresh()
    return
  }

  if (input.event.type !== "project.updated") return
  const properties = input.event.properties as Project
  const result = Binary.search(input.project, properties.id, (s) => s.id)
  if (result.found) {
    input.setGlobalProject(
      produce((draft) => {
        draft[result.index] = { ...draft[result.index], ...properties }
      }),
    )
    return
  }
  input.setGlobalProject(
    produce((draft) => {
      draft.splice(result.index, 0, properties)
    }),
  )
}

function cleanupSessionCaches(
  setStore: SetStoreFunction<State>,
  sessionID: string,
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
) {
  if (!sessionID) return
  setSessionTodo?.(sessionID, undefined)
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, [sessionID])
    }),
  )
}

export function cleanupDroppedSessionCaches(
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  next: Session[],
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
) {
  const keep = new Set(next.map((item) => item.id))
  const stale = [
    ...Object.keys(store.message),
    ...Object.keys(store.session_diff),
    ...Object.keys(store.todo),
    ...Object.keys(store.permission),
    ...Object.keys(store.question),
    ...Object.keys(store.session_status),
    ...Object.values(store.part)
      .map((parts) => parts?.find((part) => !!part?.sessionID)?.sessionID)
      .filter((sessionID): sessionID is string => !!sessionID),
  ].filter((sessionID, index, list) => !keep.has(sessionID) && list.indexOf(sessionID) === index)
  if (stale.length === 0) return
  for (const sessionID of stale) {
    setSessionTodo?.(sessionID, undefined)
  }
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, stale)
    }),
  )
}

export function applyDirectoryEvent(input: {
  event: { type: string; properties?: unknown }
  store: Store<State>
  setStore: SetStoreFunction<State>
  push: (directory: string) => void
  directory: string
  loadLsp: () => void
  loadReferences?: () => void
  vcsCache?: VcsCache
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void
  retainedLimit?: number
  sessionContent?: boolean
  permission?: State["permission"]
}) {
  const event = input.event
  const limit = Math.max(input.store.limit, input.retainedLimit ?? 0)
  switch (event.type) {
    case "message.updated": {
      const info = clean((event.properties as { info: Message }).info)
      const messages = input.store.message[info.sessionID]
      if (!messages) {
        input.setStore("message", info.sessionID, [info])
        break
      }
      const result = Binary.search(messages, messageKey(info), messageKey)
      if (result.found) {
        input.setStore("message", info.sessionID, result.index, reconcile(info))
        break
      }
      input.setStore(
        "message",
        info.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, info)
        }),
      )
      break
    }

    case "message.removed": {
      const props = event.properties as { sessionID: string; messageID: string }
      input.setStore(
        produce((draft) => {
          const messages = draft.message[props.sessionID]
          if (messages) {
            const index = messages.findIndex((message) => message.id === props.messageID)
            if (index >= 0) messages.splice(index, 1)
          }
          const parts = draft.part[props.messageID]
          if (parts) {
            for (const part of parts) {
              delete draft.part_text_accum_delta[part.id]
            }
          }
          delete draft.part[props.messageID]
        }),
      )
      break
    }

    case "message.part.updated": {
      const part = (event.properties as { part: Part }).part
      if (SKIP_PARTS.has(part.type)) break
      input.setStore(
        produce((draft) => {
          delete draft.part_text_accum_delta[part.id]
        }),
      )
      const parts = input.store.part[part.messageID]
      if (!parts) {
        input.setStore("part", part.messageID, [part])
        break
      }
      const result = Binary.search(parts, part.id, (item) => item.id)
      if (result.found) {
        input.setStore("part", part.messageID, result.index, reconcile(part))
        break
      }
      input.setStore(
        "part",
        part.messageID,
        produce((draft) => {
          draft.splice(result.index, 0, part)
        }),
      )
      break
    }

    case "message.part.removed": {
      const props = event.properties as { messageID: string; partID: string }
      input.setStore(
        produce((draft) => {
          delete draft.part_text_accum_delta[props.partID]
        }),
      )
      const parts = input.store.part[props.messageID]
      if (!parts) break
      const result = Binary.search(parts, props.partID, (part) => part.id)
      if (result.found) {
        input.setStore(
          produce((draft) => {
            const list = draft.part[props.messageID]
            if (!list) return
            const next = Binary.search(list, props.partID, (part) => part.id)
            if (!next.found) return
            list.splice(next.index, 1)
            if (list.length === 0) delete draft.part[props.messageID]
          }),
        )
      }
      break
    }

    case "server.instance.disposed": {
      input.push(input.directory)
      return
    }
    // case "session.archived": {
    //   const properties = event.properties as { sessionID: string }
    //   const result = Binary.search(input.store.session, properties.sessionID, (session) => session.id)
    //   if (!result.found) break
    //   const info = input.store.session[result.index]
    //   input.setStore(
    //     "session",
    //     produce((draft) => void draft.splice(result.index, 1)),
    //   )
    //   cleanupSessionCaches(input.setStore, properties.sessionID)
    //   if (!info?.parentID) input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
    //   break
    // }
  }
}
