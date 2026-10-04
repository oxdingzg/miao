export * as SessionBlobMigrate from "./blob-migrate"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Blob } from "../blob"
import type { Database } from "../database/database"
import { EventTable } from "../event/sql"
import { SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export type Report = {
  readonly messages: number
  readonly events: number
  readonly bytes: number
}

/**
 * Inline attachments at or below this decoded size stay inline. Matches
 * `SessionBlobStorage.MAX_INLINE_ATTACHMENT_BYTES`; duplicated so this migration
 * does not depend on the write-path module.
 */
const MAX_INLINE_ATTACHMENT_BYTES = 64 * 1024

const oversizedBase64 = (uri: string): string | undefined => {
  if (!uri.startsWith("data:")) return undefined
  const comma = uri.indexOf(",")
  if (comma < 0 || !uri.slice(0, comma).includes(";base64")) return undefined
  const base64 = uri.slice(comma + 1)
  return Math.floor((base64.length * 3) / 4) > MAX_INLINE_ATTACHMENT_BYTES ? base64 : undefined
}

const mimeOf = (uri: string) => uri.slice(5, uri.indexOf(",")).split(";")[0] ?? ""

const externalizeUri = (blob: Blob.Interface, uri: string) =>
  Effect.gen(function* () {
    const base64 = oversizedBase64(uri)
    if (base64 === undefined) return undefined
    const bytes = Buffer.from(base64, "base64")
    const ref = yield* blob.put({ bytes, mime: mimeOf(uri) }).pipe(Effect.orElseSucceed(() => undefined))
    return ref === undefined ? undefined : { uri: Blob.refUri(ref.hash), bytes: bytes.length }
  })

type Changed = { readonly changed: boolean; readonly bytes: number }
const unchanged: Changed = { changed: false, bytes: 0 }

/** Replaces oversized `data:` URIs inside an array of `{ uri }` items. */
const replaceIn = (blob: Blob.Interface, value: unknown) =>
  Effect.gen(function* () {
    if (!Array.isArray(value)) return { value, ...unchanged }
    const next: unknown[] = []
    let changed = false
    let bytes = 0
    for (const item of value) {
      if (typeof item === "object" && item !== null && typeof (item as { uri?: unknown }).uri === "string") {
        const result = yield* externalizeUri(blob, (item as { uri: string }).uri)
        if (result !== undefined) {
          next.push({ ...(item as object), uri: result.uri })
          changed = true
          bytes += result.bytes
          continue
        }
      }
      next.push(item)
    }
    return { value: changed ? next : value, changed, bytes }
  })

const messageData = (blob: Blob.Interface, type: string, data: Record<string, unknown>) =>
  Effect.gen(function* () {
    if (type === "user") {
      const files = yield* replaceIn(blob, data.files)
      if (!files.changed) return { data, ...unchanged }
      return { data: { ...data, files: files.value }, changed: true, bytes: files.bytes }
    }
    if (type !== "assistant" || !Array.isArray(data.content)) return { data, ...unchanged }
    const content: unknown[] = []
    let changed = false
    let bytes = 0
    for (const raw of data.content as unknown[]) {
      const item = raw as Record<string, unknown>
      const state = item?.state as Record<string, unknown> | undefined
      if (item?.type !== "tool" || typeof state !== "object" || state === null) {
        content.push(raw)
        continue
      }
      const inner = yield* replaceIn(blob, state.content)
      const attachments = yield* replaceIn(blob, state.attachments)
      if (!inner.changed && !attachments.changed) {
        content.push(raw)
        continue
      }
      content.push({
        ...item,
        state: {
          ...state,
          ...(inner.changed ? { content: inner.value } : {}),
          ...(attachments.changed ? { attachments: attachments.value } : {}),
        },
      })
      changed = true
      bytes += inner.bytes + attachments.bytes
    }
    return { data: changed ? { ...data, content } : data, changed, bytes }
  })

const eventData = (blob: Blob.Interface, type: string, data: Record<string, unknown>) =>
  Effect.gen(function* () {
    const base = type.replace(/\.\d+$/, "")
    if (base === "session.next.prompted" || base === "session.next.prompt.admitted") {
      const prompt = data.prompt as Record<string, unknown> | undefined
      if (typeof prompt !== "object" || prompt === null) return { data, ...unchanged }
      const files = yield* replaceIn(blob, prompt.files)
      if (!files.changed) return { data, ...unchanged }
      return { data: { ...data, prompt: { ...prompt, files: files.value } }, changed: true, bytes: files.bytes }
    }
    if (base === "session.next.tool.success" || base === "session.next.tool.progress") {
      const content = yield* replaceIn(blob, data.content)
      if (!content.changed) return { data, ...unchanged }
      return { data: { ...data, content: content.value }, changed: true, bytes: content.bytes }
    }
    return { data, ...unchanged }
  })

/**
 * One-time, idempotent migration of inline payloads already in the database into
 * the content-addressed blob store. Reads materialize `blob://` refs back to
 * data URIs, so this only changes storage shape. Pages by aggregate to bound
 * memory. See `specs/storage/session-storage-hardening.md`.
 */
export const migrate = (blob: Blob.Interface, db: DatabaseService, options?: { readonly dryRun?: boolean }) =>
  Effect.gen(function* () {
    const dryRun = options?.dryRun === true
    let messages = 0
    let events = 0
    let bytes = 0

    const sessions = yield* db
      .selectDistinct({ id: SessionMessageTable.session_id })
      .from(SessionMessageTable)
      .all()
      .pipe(Effect.orDie)
    for (const { id } of sessions) {
      const rows = yield* db
        .select({ id: SessionMessageTable.id, type: SessionMessageTable.type, data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, id))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        const result = yield* messageData(blob, row.type, row.data as Record<string, unknown>)
        if (!result.changed) continue
        messages += 1
        bytes += result.bytes
        if (!dryRun)
          yield* db
            .update(SessionMessageTable)
            .set({ data: result.data as typeof row.data })
            .where(eq(SessionMessageTable.id, row.id))
            .run()
            .pipe(Effect.orDie)
      }
    }

    const aggregates = yield* db
      .selectDistinct({ id: EventTable.aggregate_id })
      .from(EventTable)
      .all()
      .pipe(Effect.orDie)
    for (const { id } of aggregates) {
      const rows = yield* db
        .select({ id: EventTable.id, type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, id))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        const result = yield* eventData(blob, row.type, row.data as Record<string, unknown>)
        if (!result.changed) continue
        events += 1
        bytes += result.bytes
        if (!dryRun)
          yield* db
            .update(EventTable)
            .set({ data: result.data })
            .where(eq(EventTable.id, row.id))
            .run()
            .pipe(Effect.orDie)
      }
    }

    return { messages, events, bytes } satisfies Report
  })
