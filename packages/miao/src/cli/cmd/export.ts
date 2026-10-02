import { SessionV1 } from "@miao/core/v1/session"
import { Database } from "@miao/core/database/database"
import { SessionMessage } from "@miao/core/session/message"
import { SessionSchema } from "@miao/core/session/schema"
import { SessionTable } from "@miao/core/session/sql"
import { SessionStore } from "@miao/core/session/store"
import { SessionV1Read } from "@miao/core/session/v1-read"
import { sessionContextToMessages } from "@miao/tui/context/session-v2"
import { InstanceRef } from "@/effect/instance-ref"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { desc, eq } from "drizzle-orm"
import { EOL } from "os"
import { DateTime, Effect, Schema } from "effect"

function redact(kind: string, id: string, value: string) {
  return value.trim() ? `[redacted:${kind}:${id}]` : value
}

function data(kind: string, id: string, value: Record<string, unknown> | undefined) {
  if (!value) return value
  return Object.keys(value).length ? { redacted: `${kind}:${id}` } : value
}

function span(id: string, value: { value: string; start: number; end: number }) {
  return {
    ...value,
    value: redact("file-text", id, value.value),
  }
}

function diff(kind: string, diffs: ReadonlyArray<{ file?: string; patch?: string }> | undefined) {
  return diffs?.map((item, i) => ({
    ...item,
    file: item.file === undefined ? undefined : redact(`${kind}-file`, String(i), item.file),
    patch: item.patch === undefined ? undefined : redact(`${kind}-patch`, String(i), item.patch),
  }))
}

function source(part: SessionV1.FilePart) {
  if (!part.source) return part.source
  if (part.source.type === "symbol") {
    return {
      ...part.source,
      path: redact("file-path", part.id, part.source.path),
      name: redact("file-symbol", part.id, part.source.name),
      text: span(part.id, part.source.text),
    }
  }
  if (part.source.type === "resource") {
    return {
      ...part.source,
      clientName: redact("file-client", part.id, part.source.clientName),
      uri: redact("file-uri", part.id, part.source.uri),
      text: span(part.id, part.source.text),
    }
  }
  return {
    ...part.source,
    path: redact("file-path", part.id, part.source.path),
    text: span(part.id, part.source.text),
  }
}

function filepart(part: SessionV1.FilePart): SessionV1.FilePart {
  return {
    ...part,
    url: redact("file-url", part.id, part.url),
    filename: part.filename === undefined ? undefined : redact("file-name", part.id, part.filename),
    source: source(part),
  }
}

function part(part: SessionV1.Part): SessionV1.Part {
  switch (part.type) {
    case "text":
      return {
        ...part,
        text: redact("text", part.id, part.text),
        metadata: data("text-metadata", part.id, part.metadata),
      }
    case "reasoning":
      return {
        ...part,
        text: redact("reasoning", part.id, part.text),
        metadata: data("reasoning-metadata", part.id, part.metadata),
      }
    case "file":
      return filepart(part)
    case "subtask":
      return {
        ...part,
        prompt: redact("subtask-prompt", part.id, part.prompt),
        description: redact("subtask-description", part.id, part.description),
        command: part.command === undefined ? undefined : redact("subtask-command", part.id, part.command),
      }
    case "tool":
      return {
        ...part,
        metadata: data("tool-metadata", part.id, part.metadata),
        state:
          part.state.status === "pending"
            ? {
                ...part.state,
                input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                raw: redact("tool-raw", part.id, part.state.raw),
              }
            : part.state.status === "running"
              ? {
                  ...part.state,
                  input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                  title: part.state.title === undefined ? undefined : redact("tool-title", part.id, part.state.title),
                  metadata: data("tool-state-metadata", part.id, part.state.metadata),
                }
              : part.state.status === "completed"
                ? {
                    ...part.state,
                    input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                    output: redact("tool-output", part.id, part.state.output),
                    title: redact("tool-title", part.id, part.state.title),
                    metadata: data("tool-state-metadata", part.id, part.state.metadata) ?? part.state.metadata,
                    attachments: part.state.attachments?.map(filepart),
                  }
                : {
                    ...part.state,
                    input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                    metadata: data("tool-state-metadata", part.id, part.state.metadata),
                  },
      }
    case "patch":
      return {
        ...part,
        hash: redact("patch", part.id, part.hash),
        files: part.files.map((item: string, i: number) => redact("patch-file", `${part.id}-${i}`, item)),
      }
    case "snapshot":
      return {
        ...part,
        snapshot: redact("snapshot", part.id, part.snapshot),
      }
    case "step-start":
      return {
        ...part,
        snapshot: part.snapshot === undefined ? undefined : redact("snapshot", part.id, part.snapshot),
      }
    case "step-finish":
      return {
        ...part,
        snapshot: part.snapshot === undefined ? undefined : redact("snapshot", part.id, part.snapshot),
      }
    case "agent":
      return {
        ...part,
        source: !part.source
          ? part.source
          : {
              ...part.source,
              value: redact("agent-source", part.id, part.source.value),
            },
      }
    default:
      return part
  }
}

const partFn = part

function sanitize(data: Archive) {
  return {
    version: data.version,
    info: {
      ...data.info,
      title: redact("session-title", data.info.id, data.info.title),
      directory: redact("session-directory", data.info.id, data.info.directory),
      summary: !data.info.summary
        ? data.info.summary
        : {
            ...data.info.summary,
            diffs: diff("session-diff", data.info.summary.diffs),
          },
      revert: !data.info.revert
        ? data.info.revert
        : {
            ...data.info.revert,
            snapshot:
              data.info.revert.snapshot === undefined
                ? undefined
                : redact("revert-snapshot", data.info.id, data.info.revert.snapshot),
            diff:
              data.info.revert.diff === undefined
                ? undefined
                : redact("revert-diff", data.info.id, data.info.revert.diff),
          },
    },
    // The projection repeats the transcript verbatim, so a sanitized archive
    // carries only the redacted V1-shaped messages and imports from those.
    messages: data.messages.map((msg) => ({
      info:
        msg.info.role === "user"
          ? {
              ...msg.info,
              system: msg.info.system === undefined ? undefined : redact("system", msg.info.id, msg.info.system),
              summary: !msg.info.summary
                ? msg.info.summary
                : {
                    ...msg.info.summary,
                    title:
                      msg.info.summary.title === undefined
                        ? undefined
                        : redact("summary-title", msg.info.id, msg.info.summary.title),
                    body:
                      msg.info.summary.body === undefined
                        ? undefined
                        : redact("summary-body", msg.info.id, msg.info.summary.body),
                    diffs: diff("message-diff", msg.info.summary.diffs),
                  },
            }
          : {
              ...msg.info,
              path: {
                cwd: redact("cwd", msg.info.id, msg.info.path.cwd),
                root: redact("root", msg.info.id, msg.info.path.root),
              },
            },
      parts: msg.parts.map(partFn),
    })),
  }
}

export const ExportCommand = effectCmd({
  command: "export [sessionID]",
  describe: "export session data as JSON or JSONL",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session id to export",
        type: "string",
      })
      .option("sanitize", {
        describe: "redact sensitive transcript and file data",
        type: "boolean",
      })
      .option("format", {
        describe: "output format: json (pretty) or jsonl (one line per message)",
        type: "string",
        choices: ["json", "jsonl"],
        default: "json",
      }),
  handler: Effect.fn("Cli.export")(function* (args) {
    return yield* run(args)
  }),
})

const run = Effect.fn("Cli.export.body")(function* (args: { sessionID?: string; sanitize?: boolean; format?: string }) {
  const { db } = yield* Database.Service
  const ctx = yield* InstanceRef
  let sessionID = args.sessionID ? SessionSchema.ID.make(args.sessionID) : undefined
  process.stderr.write(`Exporting session: ${sessionID ?? "latest"}\n`)

  if (!sessionID) {
    if (args.format === "jsonl") {
      if (!process.stdin.isTTY && !process.stdout.isTTY)
        return yield* fail("export --format jsonl requires a sessionID when not interactive")
    }
    UI.empty()
    prompts.intro("Export session", { output: process.stderr })

    const sessions = yield* db
      .select({ id: SessionTable.id, title: SessionTable.title, updated: SessionTable.time_updated })
      .from(SessionTable)
      .where(ctx ? eq(SessionTable.project_id, ctx.project.id) : undefined)
      .orderBy(desc(SessionTable.time_updated))
      .all()
      .pipe(Effect.orDie)

    if (sessions.length === 0) {
      prompts.log.error("No sessions found", { output: process.stderr })
      prompts.outro("Done", { output: process.stderr })
      return
    }

    const selectedSession = yield* Effect.promise(() =>
      prompts.autocomplete({
        message: "Select session to export",
        maxItems: 10,
        options: sessions.map((session) => ({
          label: session.title,
          value: session.id,
          hint: `${new Date(session.updated).toLocaleString()} • ${session.id.slice(-8)}`,
        })),
        output: process.stderr,
      }),
    )

    if (prompts.isCancel(selectedSession)) {
      return yield* Effect.die(new UI.CancelledError())
    }

    sessionID = selectedSession

    prompts.outro("Exporting session...", { output: process.stderr })
  }

  // Only a missing session reads as "not found"; a transcript that cannot be
  // read must surface its own cause instead of hiding behind that message.
  const exportData = yield* archive(sessionID).pipe(Effect.catch((error) => fail(error.message)))
  if (!exportData) return yield* fail(`Session not found: ${sessionID}`)

  const payload = args.sanitize ? sanitize(exportData) : exportData
  if (args.format === "jsonl") {
    for (const message of payload.messages) process.stdout.write(JSON.stringify(message) + EOL)
    return
  }
  process.stdout.write(JSON.stringify(payload, null, 2))
  process.stdout.write(EOL)
})

/**
 * Archive format version. Version 2 adds `version` and `projection` (the
 * session's V2 messages, encoded) next to the V1-shaped `info` and `messages`
 * that older miao builds and tools read. `miao import` restores from
 * `projection` when present, so a round trip keeps everything the projection
 * holds; an archive without `version` is a V1 export.
 */
export const ARCHIVE_VERSION = 2

export interface Archive {
  readonly version: typeof ARCHIVE_VERSION
  readonly info: SessionV1.SessionInfo
  readonly messages: SessionV1.WithParts[]
  readonly projection?: ReadonlyArray<(typeof SessionMessage.Message)["Encoded"]>
}

const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const decodeMessage = Schema.decodeUnknownSync(SessionV1.WithParts)

/** Builds a session's archive from the V2 projection, or `undefined` when the session does not exist. */
export const archive = Effect.fn("Cli.export.archive")(function* (sessionID: SessionSchema.ID) {
  const { db } = yield* Database.Service
  const store = yield* SessionStore.Service
  const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  if (!row) return undefined
  // A session the backfill has not reached yet is served from the legacy
  // tables, mapped the same way a backfill would project it.
  const state = yield* store.historyState(sessionID)
  const projection =
    state === "legacy" || state === "mixed" ? yield* store.context(sessionID) : yield* store.timeline(sessionID)
  const info = sessionInfo(row)
  return {
    version: ARCHIVE_VERSION,
    info,
    messages: transcript(info, projection),
    projection: projection.map((message) => encodeMessage(message)),
  } satisfies Archive
})

/**
 * The V1 `{ info, parts }` transcript of a projection. Detail a V1 mapping kept
 * under `metadata.v1` (step markers, patches, compaction and subtask parts, the
 * original error) goes back where it was, so the archive of a backfilled session
 * matches the legacy one even after `miao db compact`.
 */
export function transcript(info: SessionV1.SessionInfo, projection: ReadonlyArray<SessionMessage.Message>) {
  const converted = new Map(
    withUserSelections(
      sessionContextToMessages({
        sessionID: info.id,
        cwd: info.directory,
        // `path` is the session directory relative to its worktree.
        root:
          info.path && info.directory.endsWith(`/${info.path}`)
            ? info.directory.slice(0, -info.path.length - 1)
            : info.directory,
        // The encoded schema is the JSON the V2 API serves; it differs from the
        // generated SDK type only in readonly modifiers.
        messages: projection.map((message) => encodeMessage(message)) as Parameters<
          typeof sessionContextToMessages
        >[0]["messages"],
      }),
    ).map((entry) => [entry.info.id, entry] as const),
  )
  const result: SessionV1.WithParts[] = []
  let lastUser = ""
  let lastAssistant: { modelID: string; providerID: string; path: { cwd: string; root: string } } | undefined
  for (const message of projection) {
    const kept = SessionV1Read.preserved(message)
    if (message.type === "compaction") {
      if (kept?.info) {
        result.push(
          v1Message(
            info.id,
            message.id,
            kept.info,
            (kept.parts ?? []).map((item) => item.part),
          ),
        )
        continue
      }
      // A V2 compaction has no V1 message; V1 recorded one as a summary reply.
      result.push(
        v1Message(
          info.id,
          message.id,
          {
            role: "assistant",
            // The summary answers the turn before it; a compaction that opens the
            // session has no such turn, so it stands in as its own parent.
            parentID: lastUser || message.id,
            modelID: lastAssistant?.modelID ?? "",
            providerID: lastAssistant?.providerID ?? "",
            path: lastAssistant?.path ?? { cwd: info.directory, root: info.directory },
            agent: "compaction",
            mode: "compaction",
            summary: true,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
            time: { created: DateTime.toEpochMillis(message.time.created) },
          },
          [{ type: "text", text: message.summary } as { readonly type: string }],
        ),
      )
      continue
    }
    const entry = converted.get(message.id)
    if (!entry) continue
    if (entry.info.role === "user") lastUser = entry.info.id
    if (entry.info.role === "assistant") lastAssistant = entry.info
    const parts: ReadonlyArray<{ readonly type: string }>[number][] = kept?.parts?.some(
      (item) => item.part.type === "text",
    )
      ? entry.parts.filter((part) => part.type !== "text")
      : [...entry.parts]
    for (const item of (kept?.parts ?? []).toSorted((a, b) => a.index - b.index)) parts.splice(item.index, 0, item.part)
    result.push(v1Message(info.id, message.id, { ...entry.info, ...kept?.info }, parts))
  }
  return result
}

/** Decoding checks the rebuilt message against the schema `miao import` applies. */
function v1Message(
  sessionID: string,
  messageID: string,
  info: Record<string, unknown>,
  parts: ReadonlyArray<{ readonly type: string }>,
) {
  return decodeMessage({
    info: { ...info, id: messageID, sessionID },
    // V2 content ids are provider call or block ids, not V1 part ids. V1 storage
    // requires the `prt` prefix and reads a message's parts back in id order, so
    // derive ids that keep the original order.
    parts: parts.map((part, index) => ({
      ...part,
      id: `prt_${messageID.replace(/^msg_/, "")}${String(index).padStart(4, "0")}`,
      sessionID,
      messageID,
    })),
  }) as SessionV1.WithParts
}

/** The V1 session record archives carry, read from the session row. */
function sessionInfo(row: typeof SessionTable.$inferSelect) {
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    path: row.path ?? undefined,
    parentID: row.parent_id ?? undefined,
    title: row.title,
    agent: row.agent ?? undefined,
    model: row.model ?? undefined,
    version: row.version,
    summary:
      row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
        ? {
            additions: row.summary_additions ?? 0,
            deletions: row.summary_deletions ?? 0,
            files: row.summary_files ?? 0,
            diffs: row.summary_diffs ?? undefined,
          }
        : undefined,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
    },
    metadata: row.metadata ?? undefined,
    permission: row.permission ? [...row.permission] : undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  } as SessionV1.SessionInfo
}

/**
 * History backfilled from V1 records no agent or model switches, so the
 * converter leaves user messages without the agent and model they were sent
 * with. The assistant that answered a message ran with that selection; the
 * compaction agent answers on the user's behalf and an unanswered message never
 * ran, so both keep the selection of the user message before them.
 */
function withUserSelections(converted: ReturnType<typeof sessionContextToMessages>) {
  const replies = new Map(
    // The first reply of a turn carries the selection it was sent with.
    converted
      .toReversed()
      .flatMap((entry) =>
        entry.info.role === "assistant" && entry.info.agent !== "compaction" ? [[entry.info.parentID, entry.info]] : [],
      ),
  )
  let previous: { agent: string; model: { providerID: string; modelID: string; variant?: string } } | undefined
  return converted.map((entry) => {
    if (entry.info.role !== "user") return entry
    const reply = replies.get(entry.info.id)
    const selected =
      entry.info.agent && entry.info.model.providerID
        ? { agent: entry.info.agent, model: entry.info.model }
        : reply
          ? {
              agent: reply.agent ?? reply.mode,
              model: { providerID: reply.providerID, modelID: reply.modelID, variant: reply.variant },
            }
          : previous
    previous = selected ?? previous
    return selected ? { ...entry, info: { ...entry.info, ...selected } } : entry
  })
}
