import { Binary } from "@miao/core/util/binary"
import type { FileDiffInfo, SessionApi, SessionMessageInfo } from "@/utils/server"
import { retry } from "@miao/core/util/retry"
import type { OpenCodeEventEncoded } from "@miao/protocol/groups/event"
import type { Message, Part, Session, SessionStatus, Todo } from "@miao/schema/view-models"
import type { QuestionRequest } from "@miao/schema/view-models"
import type { PermissionV2Request } from "@miao/schema/view-models"
import { batch } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { message as cleanMessage } from "@/utils/diffs"
import { legacyContents, mergeLegacyDelta, mergeLegacyPart, removeLegacyPart } from "@/context/legacy-part-record"
import { sessionNotFoundError } from "@/utils/server-errors"
import { rootSession } from "@/utils/session-route"
import { normalizeSessionInfo } from "@/utils/session"
import { compareMessages, messageKey, normalizeSessionMessages } from "@/utils/session-message"
import { dropSessionCaches, pickSessionCacheEvictions, SESSION_CACHE_LIMIT } from "./global-sync/session-cache"
import { createV2SessionReducer, type V2SessionReduction } from "./server-session-v2-reducer"
import type { SessionMessageUser } from "@miao/session-ui/content"
import type { ServerApi } from "@/utils/server"

type MessageApi = ServerApi["messages"]

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const initialMessagePageSize = 20
const historyMessagePageSize = 200
const sessionInfoLimit = 2_048
const emptyIDs: ReadonlySet<string> = new Set()

function needsOlderTurnRoot(source: readonly SessionMessageInfo[]) {
  const boundary = source.find(
    (message) =>
      message.type === "user" ||
      message.type === "shell" ||
      message.type === "assistant" ||
      (message.type === "synthetic" && message.text.trim()),
  )
  return boundary?.type === "assistant"
}

type OptimisticItem = { message: SessionMessageUser }

type MessagePage = {
  source: SessionMessageInfo[]
  sourceMode: "latest" | "older"
  cursor?: string
  complete: boolean
}

function legacyMessageSource(items: { info: Message; parts: Part[] }[]): SessionMessageInfo[] {
  return items
    .slice()
    .sort((a, b) => compareMessages(a.info, b.info))
    .map((item) => {
      if (item.info.role === "user") {
        return {
          id: item.info.id,
          type: "user" as const,
          text: item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
          time: item.info.time,
        }
      }
      return {
        id: item.info.id,
        type: "assistant" as const,
        agent: item.info.agent ?? item.info.mode,
        model: { id: item.info.modelID, providerID: item.info.providerID, variant: item.info.variant },
        content: legacyContents(item.parts),
        time: item.info.time,
      }
    })
}

// Most markers describe the current HTTP attempt; deltaParts persists non-durable stream state across retries.
type MessageLoadState = { touchedSource: Set<string> }


function mergePendingRecords(source: SessionMessageInfo[], items: OptimisticItem[]) {
  if (items.length === 0) return source
  const incoming = new Map(source.map((message) => [message.id, message]))
  const kept = source.filter((message) => !incoming.has(message.id))
  return [...kept, ...source]
}

function runInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    if (map.get(key) === promise) map.delete(key)
  })
  map.set(key, promise)
  return promise
}

function merge<T extends { id: string }>(a: readonly T[], b: readonly T[]) {
  const items = new Map(a.map((item) => [item.id, item] as const))
  for (const item of b) items.set(item.id, item)
  return [...items.values()].sort((x, y) => cmp(x.id, y.id))
}

function reconcileFetched<T extends { id: string }>(
  fetched: T[],
  current: readonly T[],
  options: {
    touched?: ReadonlySet<string>
    retained?: ReadonlySet<string>
    removed?: ReadonlySet<string>
    preserveUnfetched?: boolean | ((item: T) => boolean)
    compare?: (a: T, b: T) => number
  } = {},
) {
  const result = new Map(fetched.map((item) => [item.id, item]))
  const live = new Map(current.map((item) => [item.id, item]))
  if (options.preserveUnfetched) {
    for (const item of current) {
      if (!result.has(item.id) && (options.preserveUnfetched === true || options.preserveUnfetched(item)))
        result.set(item.id, item)
    }
  }
  for (const id of options.retained ?? emptyIDs) {
    if (result.has(id)) continue
    const item = live.get(id)
    if (item) result.set(id, item)
  }
  // Events observed while the request is pending are the freshest client state for those identities.
  for (const id of options.touched ?? emptyIDs) {
    const item = live.get(id)
    if (item) result.set(id, item)
    if (!item) result.delete(id)
  }
  for (const id of options.removed ?? emptyIDs) result.delete(id)
  const items = [...result.values()]
  return options.compare ? items.sort(options.compare) : items
}

type ServerSessionOptions = { retry?: typeof retry }

// The cache still accepts projected rendering records in unit tests. Production
// supplies the V2 Session and Message APIs below; the SDK has no V1 session routes.
export type SessionReadClient = {
  session: {
    get: (input: { sessionID: string }) => Promise<{ data?: Session }>
    messages: (input: { sessionID: string; limit: number; before?: string }) => Promise<{
      data?: { info: Message; parts: Part[] }[]
      response: { headers: Headers }
    }>
    message: (input: { sessionID: string; messageID: string }) => Promise<{
      data?: { info: Message; parts: Part[] }
    }>
  }
}

export function createServerSession(
  client: Pick<ServerApi, "sessions"> | SessionReadClient,
  sessionApiOrOptions?: SessionApi | ServerSessionOptions,
  messageApi?: MessageApi,
  currentOptions?: ServerSessionOptions,
) {
  const sessionApi = messageApi ? (sessionApiOrOptions as SessionApi) : undefined
  const options = messageApi ? currentOptions : (sessionApiOrOptions as ServerSessionOptions | undefined)
  const [data, setData] = createStore({
    info: {} as Record<string, Session | undefined>,
    session_status: {} as Record<string, SessionStatus>,
    session_diff: {} as Record<string, FileDiffInfo[]>,
    todo: {} as Record<string, Todo[]>,
    permission: {} as Record<string, PermissionV2Request[]>,
    question: {} as Record<string, QuestionRequest[]>,
    message: {} as Record<string, SessionMessageInfo[]>,
    session_working(id: string) {
      return (this.session_status[id]?.type ?? "idle") !== "idle"
    },
  })
  const requests = new Map<string, Promise<Session>>()
  const inflight = new Map<string, Promise<void>>()
  const inflightTodo = new Map<string, Promise<void>>()
  // Bumped on every live `todo.updated`. A snapshot fetch records the count when
  // it starts and skips its result if a live update landed while it was in
  // flight, so a slow snapshot cannot revert a newer live todo list.
  const todoRevisions = new Map<string, number>()
  const optimistic = new Map<string, Map<string, OptimisticItem>>()
  const v2 = createV2SessionReducer()
  const messageLoads = new Map<string, MessageLoadState>()
  const pendingParts = new Map<string, Map<string, Set<string>>>()
  const orphanParts = new Map<string, Set<string>>()
  const removedMessages = new Map<string, Set<string>>()
  const deltaBases = new Map<string, { base: string; sessionID: string }>()
  const deleteMessageParts = (
    cache: { part: Record<string, Part[] | undefined>; part_text_accum_delta: Record<string, string | undefined> },
    messageID: string,
  ) => {
    for (const part of cache.part[messageID] ?? []) {
      delete cache.part_text_accum_delta[part.id]
      deltaBases.delete(part.id)
    }
    delete cache.part[messageID]
  }
  const seen = new Set<string>()
  const infoSeen = new Set<string>()
  const pinned = new Map<string, number>()
  const generations = new Map<string, object>()
  const generation = (sessionID: string) => {
    const current = generations.get(sessionID)
    if (current) return current
    const created = {}
    generations.set(sessionID, created)
    return created
  }
  const [meta, setMeta] = createStore({
    limit: {} as Record<string, number | undefined>,
    cursor: {} as Record<string, string | undefined>,
    complete: {} as Record<string, boolean | undefined>,
    loading: {} as Record<string, boolean | undefined>,
    at: {} as Record<string, number | undefined>,
  })

  const remember = (session: Session) => {
    setData("info", session.id, reconcile(session))
    infoSeen.delete(session.id)
    infoSeen.add(session.id)
    if (infoSeen.size > sessionInfoLimit) {
      const preserve = new Set([
        ...pinned.keys(),
        ...requests.keys(),
        ...inflight.keys(),
        ...inflightTodo.keys(),
        ...messageLoads.keys(),
        ...optimistic.keys(),
        ...Object.entries(data.permission)
          .filter(([, items]) => items.length > 0)
          .map(([sessionID]) => sessionID),
        ...Object.entries(data.question)
          .filter(([, items]) => items.length > 0)
          .map(([sessionID]) => sessionID),
        ...Object.entries(data.session_status)
          .filter(([, status]) => status.type !== "idle")
          .map(([sessionID]) => sessionID),
      ])
      for (const sessionID of preserve) {
        let current = data.info[sessionID]
        while (current) {
          preserve.add(current.id)
          current = current.parentID ? data.info[current.parentID] : undefined
        }
      }
      const stale: string[] = []
      for (const sessionID of infoSeen) {
        if (infoSeen.size - stale.length <= sessionInfoLimit) break
        if (!preserve.has(sessionID)) stale.push(sessionID)
      }
      stale.forEach((sessionID) => infoSeen.delete(sessionID))
      stale.forEach((sessionID) => generations.delete(sessionID))
      setData(
        "info",
        produce((draft) => stale.forEach((sessionID) => delete draft[sessionID])),
      )
    }
    return session
  }

  const resolve = (sessionID: string, options?: { force?: boolean }) => {
    const cached = data.info[sessionID]
    if (cached && !options?.force) return Promise.resolve(cached)
    const pending = requests.get(sessionID)
    if (pending) return pending
    const active = generation(sessionID)
    const request = sessionApi
      ? sessionApi.get({ sessionID }).then(normalizeSessionInfo)
      : ("session" in client
          ? client.session.get({ sessionID })
          : Promise.reject(new Error("V2 Session API is required"))
        ).then((result) => {
          if (!result.data) throw sessionNotFoundError(sessionID)
          return result.data
        })
    const resolved = request.then((result) => {
      if (generations.get(sessionID) !== active) return result
      return remember(result)
    })
    requests.set(sessionID, resolved)
    const cleanup = () => {
      if (requests.get(sessionID) === resolved) requests.delete(sessionID)
      if (
        generations.get(sessionID) === active &&
        !data.info[sessionID] &&
        !requests.has(sessionID) &&
        !messageLoads.has(sessionID) &&
        !inflight.has(sessionID) &&
        !inflightTodo.has(sessionID)
      )
        generations.delete(sessionID)
    }
    void resolved.then(cleanup, cleanup)
    return resolved
  }

  const peekLineage = (sessionID: string) => {
    const session = data.info[sessionID]
    if (!session) return
    const seen = new Set([session.id])
    let root = session
    while (root.parentID) {
      if (seen.has(root.parentID)) throw new Error(`Session parent cycle: ${root.parentID}`)
      seen.add(root.parentID)
      const parent = data.info[root.parentID]
      if (!parent) return
      root = parent
    }
    return { session, root }
  }

  const clearOptimistic = (sessionID: string, messageID?: string) => {
    if (!messageID) {
      optimistic.delete(sessionID)
      return
    }
    const items = optimistic.get(sessionID)
    if (!items) return
    items.delete(messageID)
    if (items.size === 0) optimistic.delete(sessionID)
  }

  const resetMessageLoad = (sessionID: string, load?: MessageLoadState) => {
    const state: MessageLoadState = { touchedSource: new Set() }
    if (load) state.touchedSource = load.touchedSource
    return state
  }

  const evict = (sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    const evicted = new Set(sessionIDs)
    for (const [partID, item] of deltaBases) {
      if (evicted.has(item.sessionID)) deltaBases.delete(partID)
    }
    sessionIDs.forEach((sessionID) => {
      generations.delete(sessionID)
      clearOptimistic(sessionID)
      requests.delete(sessionID)
      inflight.delete(sessionID)
      inflightTodo.delete(sessionID)
      todoRevisions.delete(sessionID)
      messageLoads.delete(sessionID)
      v2.clear(sessionID)
      pendingParts.delete(sessionID)
      orphanParts.delete(sessionID)
      removedMessages.delete(sessionID)
    })
    setData(
      produce((draft) => {
        dropSessionCaches(draft, sessionIDs)
      }),
    )
    setMeta(
      produce((draft) => {
        for (const sessionID of sessionIDs) {
          delete draft.limit[sessionID]
          delete draft.cursor[sessionID]
          delete draft.complete[sessionID]
          delete draft.loading[sessionID]
          delete draft.at[sessionID]
        }
      }),
    )
  }

  const protectedSessions = () =>
    new Set([
      ...pinned.keys(),
      ...requests.keys(),
      ...inflight.keys(),
      ...inflightTodo.keys(),
      ...messageLoads.keys(),
      ...optimistic.keys(),
      ...Object.entries(data.permission)
        .filter(([, items]) => items.length > 0)
        .map(([sessionID]) => sessionID),
      ...Object.entries(data.question)
        .filter(([, items]) => items.length > 0)
        .map(([sessionID]) => sessionID),
      ...Object.entries(data.session_status)
        .filter(([, status]) => status.type !== "idle")
        .map(([sessionID]) => sessionID),
    ])

  const touch = (sessionID: string) =>
    evict(
      pickSessionCacheEvictions({ seen, keep: sessionID, limit: SESSION_CACHE_LIMIT, preserve: protectedSessions() }),
    )

  const loadTodo = (sessionID: string, request?: { force?: boolean }) => {
    if (data.todo[sessionID] !== undefined && !request?.force) return Promise.resolve()
    if (!("sessions" in client)) return Promise.reject(new Error("V2 Session API is required"))
    return runInflight(inflightTodo, sessionID, () => {
      const active = generation(sessionID)
      const revision = todoRevisions.get(sessionID) ?? 0
      return (options?.retry ?? retry)(() => client.sessions.todo({ sessionID })).then((result) => {
        if (generations.get(sessionID) !== active) return
        if ((todoRevisions.get(sessionID) ?? 0) !== revision) return
        setData("todo", sessionID, reconcile([...result], { key: "id" }))
      })
    })
  }

  const fetchMessages = async (sessionID: string, limit: number, before?: string, onAttempt?: () => void) => {
    if (messageApi) {
      const request = (cursor?: string) =>
        (options?.retry ?? retry)(() => {
          onAttempt?.()
          return messageApi.list(cursor ? { sessionID, limit, cursor } : { sessionID, limit, order: "desc" })
        })
      const first = await request(before)
      const pages = [first]
      while (pages.at(-1)?.cursor.next && pages.at(-1)!.data.at(-1)?.type !== "user") {
        const response = await request(pages.at(-1)!.cursor.next ?? undefined)
        pages.push(response)
        if (!response.data.length) break
      }
      const response = pages.at(-1)!
      return {
        source: pages.flatMap((page) => page.data).toReversed(),
        sourceMode: before ? ("older" as const) : ("latest" as const),
        cursor: response.cursor.next ?? undefined,
        complete: response.data.length === 0,
      }
    }
    const response = await (options?.retry ?? retry)(() => {
      onAttempt?.()
      if (!("session" in client)) throw new Error("V2 Message API is required")
      return client.session.messages({ sessionID, limit, before })
    })
    const items = (response.data ?? []).filter((item) => !!item?.info?.id)
    return {
      source: legacyMessageSource(items),
      sourceMode: before ? ("older" as const) : ("latest" as const),
      cursor: response.response.headers.get("x-next-cursor") ?? undefined,
      complete: !response.response.headers.get("x-next-cursor"),
    }
  }

  const applyMessagePage = (sessionID: string, page: MessagePage, load: MessageLoadState | undefined) => {
    const incomingIDs = new Map(page.source.map((message) => [message.id, message]))
    const pending = optimistic.get(sessionID)
    if (pending) for (const id of [...pending.keys()]) if (incomingIDs.has(id)) pending.delete(id)
    const existing = data.message[sessionID] ?? []
    const current = existing.filter((message) => !incomingIDs.has(message.id))
    const live = new Map(existing.map((message) => [message.id, message]))
    const source = (page.sourceMode === "older" ? [...page.source, ...current] : [...current, ...page.source]).map(
      (message) => (load?.touchedSource.has(message.id) ? (live.get(message.id) ?? message) : message),
    )
    batch(() => {
      setData("message", sessionID, reconcile(source))
      setMeta("limit", sessionID, source.length)
      setMeta("cursor", sessionID, page.cursor)
      setMeta("complete", sessionID, page.complete)
      setMeta("at", sessionID, Date.now())
    })
  }

  const loadMessages = async (sessionID: string, limit: number, before?: string, mode?: "replace" | "prepend") => {
    if (meta.loading[sessionID]) return
    const active = generation(sessionID)
    const load = resetMessageLoad(sessionID, messageLoads.get(sessionID))
    messageLoads.set(sessionID, load)
    let applied = false
    try {
      const page = await fetchMessages(sessionID, limit, mode === "prepend" ? before : undefined, () =>
        resetMessageLoad(sessionID, load),
      )
      if (generations.get(sessionID) !== active) return
      applyMessagePage(sessionID, page, messageLoads.get(sessionID) === load ? load : undefined)
      applied = true
    } finally {
      if (messageLoads.get(sessionID) === load) messageLoads.delete(sessionID)
      if (generations.get(sessionID) === active) setMeta("loading", sessionID, false)
    }
  }

  const sync = (sessionID: string, options?: { force?: boolean; messageLimit?: number }) => {
    touch(sessionID)
    return runInflight(inflight, sessionID, async () => {
      const cached = data.message[sessionID] !== undefined && meta.limit[sessionID] !== undefined
      if (cached && data.info[sessionID] && !options?.force) return
      await Promise.all([
        resolve(sessionID, options),
        cached && !options?.force
          ? Promise.resolve()
          : loadMessages(sessionID, options?.messageLimit ?? meta.limit[sessionID] ?? initialMessagePageSize),
      ])
    })
  }

  const prefetch = async (sessionID: string, limit: number) => {
    touch(sessionID)
    await inflight.get(sessionID)
    if (
      Date.now() - (meta.at[sessionID] ?? 0) <= 15_000 &&
      (meta.complete[sessionID] || (data.message[sessionID]?.length ?? 0) >= limit)
    )
      return
    await runInflight(inflight, sessionID, () => loadMessages(sessionID, limit))
  }

  const eventSessionID = (event: { type: string; properties?: unknown }) => {
    const properties = event.properties
    if (!properties || typeof properties !== "object") return
    if ("sessionID" in properties && typeof properties.sessionID === "string") return properties.sessionID
    if (
      "info" in properties &&
      properties.info &&
      typeof properties.info === "object" &&
      "sessionID" in properties.info &&
      typeof properties.info.sessionID === "string"
    )
      return properties.info.sessionID
    if (
      "part" in properties &&
      properties.part &&
      typeof properties.part === "object" &&
      "sessionID" in properties.part &&
      typeof properties.part.sessionID === "string"
    )
      return properties.part.sessionID
  }

  const projectV2 = (reduction: V2SessionReduction) => {
    reduction.touched.forEach((messageID) => messageLoads.get(reduction.sessionID)?.touchedSource.add(messageID))
    setData("message", reduction.sessionID, reconcile(reduction.messages))
  }

  const applyV2 = (event: OpenCodeEventEncoded) => {
    if (!("data" in event) || !("sessionID" in event.data) || typeof event.data.sessionID !== "string") return
    const sessionID = event.data.sessionID
    if (event.type === "session.next.status") setData("session_status", sessionID, reconcile(event.data.status))
    const reduction = v2.reduce(data.message[sessionID] ?? [], event)
    if (reduction) projectV2(reduction)

    const info = data.info[sessionID]
    if (event.type === "session.next.info.updated" && info)
      remember({
        ...info,
        title: event.data.title ?? info.title,
        time: {
          ...info.time,
          updated: event.data.timestamp,
          // The event carries the archive flag, while the projected info stores the moment it happened.
          archived:
            event.data.archived === undefined
              ? info.time.archived
              : event.data.archived
                ? event.data.timestamp
                : undefined,
        },
      })
    if (event.type === "session.next.moved" && info)
      remember({
        ...info,
        location: {
          ...info.location,
          workspaceID: event.data.location.workspaceID,
          directory: event.data.location.directory,
        },
        subpath: event.data.subdirectory,
        time: { ...info.time, updated: event.data.timestamp },
      })
    // The drain itself has no settlement event, so a turn counts as busy while a step is open and
    // settles only when a step finishes without handing off to more tool work. A live
    // `session.next.status` already carries the drain phase, so keep it instead of clobbering it
    // with a phase-less busy; `step.started` only seeds busy when nothing more precise arrived.
    if (event.type === "session.next.step.started" && data.session_status[sessionID]?.type !== "busy")
      setData("session_status", sessionID, { type: "busy" })
    if (
      (event.type === "session.next.step.ended" && event.data.finish !== "tool-calls") ||
      event.type === "session.next.step.failed"
    )
      setData("session_status", sessionID, { type: "idle" })
    if (event.type === "session.next.retried")
      setData("session_status", sessionID, {
        type: "retry",
        attempt: event.data.attempt,
        message: event.data.error.message,
        next: event.data.timestamp,
      })
    if (event.type === "session.next.created") void resolve(sessionID, { force: true }).catch(() => {})
    if (
      event.type === "session.next.revert.staged" ||
      event.type === "session.next.revert.cleared" ||
      event.type === "session.next.revert.committed"
    )
      void resolve(sessionID, { force: true }).catch(() => {})
  }

  const apply = (event: { type: string; properties?: unknown }) => {
    const eventID = eventSessionID(event)
    if (eventID) {
      touch(eventID)
      if (
        !data.info[eventID] &&
        event.type !== "session.created" &&
        event.type !== "session.updated" &&
        event.type !== "session.deleted"
      )
        void resolve(eventID).catch(() => {})
    }
    switch (event.type) {
      case "session.created":
        remember((event.properties as { info: Session }).info)
        return
      case "session.updated": {
        const info = (event.properties as { info: Session }).info
        remember(info)
        if (info.time.archived) evict([info.id])
        return
      }
      case "session.deleted": {
        const properties = event.properties as { sessionID?: string; info?: Session }
        const sessionID = properties.info?.id ?? properties.sessionID
        if (!sessionID) return
        infoSeen.delete(sessionID)
        setData(
          "info",
          produce((draft) => void delete draft[sessionID]),
        )
        evict([sessionID])
        return
      }
      case "todo.updated": {
        const props = event.properties as { sessionID: string; todos: Todo[] }
        todoRevisions.set(props.sessionID, (todoRevisions.get(props.sessionID) ?? 0) + 1)
        setData("todo", props.sessionID, reconcile(props.todos, { key: "id" }))
        return
      }
      case "server.connected": {
        // A reconnect can miss todo updates, and a snapshot started before the
        // drop may still be in flight. Bump its revision so the stale result
        // cannot apply, then fetch fresh once it settles: `runInflight` would
        // otherwise join the in-flight request and never refresh.
        for (const sessionID of new Set([...Object.keys(data.todo), ...inflightTodo.keys()])) {
          todoRevisions.set(sessionID, (todoRevisions.get(sessionID) ?? 0) + 1)
          const active = generation(sessionID)
          const pending = inflightTodo.get(sessionID)
          void (async () => {
            // Wait out the pre-reconnect request even if it rejected, so the
            // fresh read is not skipped by the coalescing inflight map.
            await pending?.catch(() => {})
            // A session deleted while waiting must not have its cache resurrected.
            if (generations.get(sessionID) !== active) return
            await loadTodo(sessionID, { force: true }).catch(() => {})
          })()
        }
        return
      }
      case "permission.v2.asked": {
        const permission = event.properties as PermissionV2Request
        const permissions = data.permission[permission.sessionID]
        if (!permissions) {
          setData("permission", permission.sessionID, [permission])
          return
        }
        const result = Binary.search(permissions, permission.id, (item) => item.id)
        if (result.found) setData("permission", permission.sessionID, result.index, reconcile(permission))
        if (!result.found)
          setData(
            "permission",
            permission.sessionID,
            produce((draft) => void draft.splice(result.index, 0, permission)),
          )
        return
      }
      case "permission.v2.replied": {
        const props = event.properties as { sessionID: string; requestID: string }
        setData(
          "permission",
          props.sessionID,
          produce((draft) => {
            if (!draft) return
            const result = Binary.search(draft, props.requestID, (item) => item.id)
            if (result.found) draft.splice(result.index, 1)
          }),
        )
        return
      }
      case "question.v2.asked": {
        const question = event.properties as QuestionRequest
        const questions = data.question[question.sessionID]
        if (!questions) {
          setData("question", question.sessionID, [question])
          return
        }
        const result = Binary.search(questions, question.id, (item) => item.id)
        if (result.found) setData("question", question.sessionID, result.index, reconcile(question))
        if (!result.found)
          setData(
            "question",
            question.sessionID,
            produce((draft) => void draft.splice(result.index, 0, question)),
          )
        return
      }
      case "question.v2.replied":
      case "question.v2.rejected": {
        const props = event.properties as { sessionID: string; requestID: string }
        setData(
          "question",
          props.sessionID,
          produce((draft) => {
            if (!draft) return
            const result = Binary.search(draft, props.requestID, (item) => item.id)
            if (result.found) draft.splice(result.index, 1)
          }),
        )
      }
    }
  }

  return {
    data,
    set: setData,
    get: (sessionID: string) => data.info[sessionID],
    peek: (sessionID: string) => data.info[sessionID],
    remember,
    resolve,
    lineage: {
      peek: peekLineage,
      async resolve(sessionID: string) {
        const session = await resolve(sessionID)
        return { session, root: await rootSession(session, resolve) }
      },
    },
    sync,
    prefetch,
    shouldPrefetch(sessionID: string, limit: number) {
      if (data.message[sessionID] === undefined) return true
      if (Date.now() - (meta.at[sessionID] ?? 0) > 15_000) return true
      if (meta.complete[sessionID]) return false
      return (meta.limit[sessionID] ?? 0) <= limit
    },
    fresh(sessionID: string, ttl: number) {
      return Date.now() - (meta.at[sessionID] ?? 0) <= ttl
    },
    optimistic: {
      add(input: { sessionID: string; message: SessionMessageUser }) {
        const items = optimistic.get(input.sessionID)
        if (items) items.set(input.message.id, { message: input.message })
        else optimistic.set(input.sessionID, new Map([[input.message.id, { message: input.message }]]))
        setData("message", input.sessionID, (messages = []) =>
          [...messages.filter((message) => message.id !== input.message.id), input.message].sort(
            (a, b) => a.time.created - b.time.created || (a.id < b.id ? -1 : 1),
          ),
        )
      },
      remove(input: { sessionID: string; messageID: string }) {
        const items = optimistic.get(input.sessionID)
        if (!items?.delete(input.messageID)) return
        if (items.size === 0) optimistic.delete(input.sessionID)
        setData("message", input.sessionID, (messages = []) =>
          messages.filter((message) => message.id !== input.messageID),
        )
      },
    },
    async todo(sessionID: string, request?: { force?: boolean }) {
      touch(sessionID)
      return loadTodo(sessionID, request)
    },
    history: {
      more: (sessionID: string) =>
        data.message[sessionID] !== undefined &&
        meta.limit[sessionID] !== undefined &&
        !meta.complete[sessionID] &&
        !!meta.cursor[sessionID],
      loading: (sessionID: string) => meta.loading[sessionID] ?? false,
      async loadMore(sessionID: string, count = historyMessagePageSize) {
        touch(sessionID)
        if (meta.loading[sessionID] || meta.complete[sessionID] || !meta.cursor[sessionID]) return
        await loadMessages(sessionID, count, meta.cursor[sessionID], "prepend")
      },
    },
    evict(sessionID: string) {
      if (protectedSessions().has(sessionID)) return
      seen.delete(sessionID)
      evict([sessionID])
    },
    pin(sessionID: string) {
      pinned.set(sessionID, (pinned.get(sessionID) ?? 0) + 1)
      touch(sessionID)
    },
    unpin(sessionID: string) {
      const count = pinned.get(sessionID)
      if (!count || count === 1) pinned.delete(sessionID)
      if (count && count > 1) pinned.set(sessionID, count - 1)
    },
    apply,
    applyV2,
  }
}

export type ServerSession = ReturnType<typeof createServerSession>
