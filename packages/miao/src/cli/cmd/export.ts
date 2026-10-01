import { Session } from "@/session/session"
import { SessionV1 } from "@miao/core/v1/session"
import { MessageV2 } from "../../session/message-v2"
import { Database } from "@miao/core/database/database"
import { SessionLegacyTables } from "@miao/core/session/legacy-tables"
import { SessionMessage } from "@miao/core/session/message"
import { SessionStore } from "@miao/core/session/store"
import { sessionContextToMessages } from "@miao/tui/context/session-v2"
import { SessionID } from "../../session/schema"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { EOL } from "os"
import { Effect, Schema } from "effect"

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

function diff(kind: string, diffs: { file?: string; patch?: string }[] | undefined) {
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

function sanitize(data: { info: Session.Info; messages: SessionV1.WithParts[] }) {
  return {
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
  const svc = yield* Session.Service
  let sessionID = args.sessionID ? SessionID.make(args.sessionID) : undefined
  process.stderr.write(`Exporting session: ${sessionID ?? "latest"}\n`)

  if (!sessionID) {
    if (args.format === "jsonl") {
      if (!process.stdin.isTTY && !process.stdout.isTTY)
        return yield* fail("export --format jsonl requires a sessionID when not interactive")
    }
    UI.empty()
    prompts.intro("Export session", { output: process.stderr })

    const sessions = yield* svc.list()

    if (sessions.length === 0) {
      prompts.log.error("No sessions found", { output: process.stderr })
      prompts.outro("Done", { output: process.stderr })
      return
    }

    sessions.sort((a, b) => b.time.updated - a.time.updated)

    const selectedSession = yield* Effect.promise(() =>
      prompts.autocomplete({
        message: "Select session to export",
        maxItems: 10,
        options: sessions.map((session) => ({
          label: session.title,
          value: session.id,
          hint: `${new Date(session.time.updated).toLocaleString()} • ${session.id.slice(-8)}`,
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
  const sessionInfo = yield* svc.get(sessionID).pipe(Effect.catchCause(() => fail(`Session not found: ${sessionID}`)))
  const messages = yield* transcript(sessionInfo).pipe(Effect.catch((error) => fail(error.message)))
  const exportData = { info: sessionInfo, messages }

  const payload = args.sanitize ? sanitize(exportData) : exportData
  if (args.format === "jsonl") {
    for (const message of payload.messages) process.stdout.write(JSON.stringify(message) + EOL)
    return
  }
  process.stdout.write(JSON.stringify(payload, null, 2))
  process.stdout.write(EOL)
})

const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const decodeMessage = Schema.decodeUnknownSync(SessionV1.WithParts)

/**
 * The archive keeps the V1 `{ info, parts }` shape that `miao import` reads.
 * Legacy rows are exported verbatim while the V1 tables exist. History only the
 * V2 projection holds — every session once `miao db compact` dropped those
 * tables, and turns the V2 runner appended — is converted to the same shape. A
 * backfill preserves message ids, so the projected copy of a legacy message is
 * skipped instead of exported twice.
 */
export const transcript = Effect.fn("Cli.export.transcript")(function* (info: Session.Info) {
  const database = yield* Database.Service
  const store = yield* SessionStore.Service
  const svc = yield* Session.Service
  const legacy = (yield* SessionLegacyTables.present(database.db)) ? yield* svc.messages({ sessionID: info.id }) : []
  const exported = new Set<string>(legacy.map((message) => message.info.id))
  const converted = withUserSelections(
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
      messages: (yield* store.timeline(info.id)).map((message) => encodeMessage(message)) as Parameters<
        typeof sessionContextToMessages
      >[0]["messages"],
    }),
  )
  const projected = converted.flatMap((message) =>
    exported.has(message.info.id)
      ? []
      : [
          // Decoding checks the converted message against the schema `miao
          // import` applies. The cast only drops the schema's readonly modifiers.
          decodeMessage({
            info: message.info,
            // V2 content ids are provider call or block ids, not V1 part ids. V1
            // storage requires the `prt` prefix and reads a message's parts back
            // in id order, so derive ids that keep the content order.
            parts: message.parts.map((part, partIndex) => ({
              ...part,
              id: `prt_${message.info.id.replace(/^msg_/, "")}${String(partIndex).padStart(4, "0")}`,
            })),
          }) as SessionV1.WithParts,
        ],
  )
  return [...legacy, ...projected].toSorted((a, b) => a.info.time.created - b.info.time.created)
})

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
