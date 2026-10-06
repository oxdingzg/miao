export * as TerminalTool from "./terminal"

import { ToolFailure } from "@miao/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { Pty } from "../pty"
import { PtyID } from "../pty/schema"
import { ToolRegistry } from "./registry"
import { Tool, type AnyTool, type Context } from "./tool"
import { Tools } from "./tools"

/**
 * Its own action, separate from `bash`: approving a terminal grants a shell that
 * every later write reaches without a per-command approval, so it has to be
 * named by a rule rather than inherited from a catch-all.
 */
export const PERMISSION = "terminal"
/** Largest slice one read returns, in UTF-8 bytes. */
export const MAX_READ_BYTES = 32 * 1024

const START = "terminal_start"
const WRITE = "terminal_write"
const READ = "terminal_read"
const LIST = "terminal_list"
const STOP = "terminal_stop"

const START_DESCRIPTION = [
  "Start an interactive terminal — a real PTY — in the active Location and return its id.",
  "Use it for a program that needs a TTY or that you keep talking to across turns: a REPL, a prompt that reads input, ssh or sudo, or a shell you want to keep open. It is not a replacement for bash with run_in_background, which is better for a command you only poll: a terminal adds echo, line buffering and escape sequences, and removes nothing.",
  "The command defaults to the configured shell, and is checked against the bash permission as the command it is.",
  `Starting a terminal is approved as \`${PERMISSION}\`, its own action, and so is every later call that uses it: an answer saved for this call covers them too, and nothing typed into the terminal is re-checked against bash. Grant it only where you would grant an open shell.`,
  "Send input with terminal_write and collect output with terminal_read; stop it with terminal_stop.",
].join(" ")

const WRITE_DESCRIPTION = [
  "Write keystrokes to a terminal started by terminal_start, exactly as given: include the trailing \\n to submit a line to a REPL.",
  "It returns once the bytes are written, not when the program reacts, so call terminal_read afterwards to collect the output. Writing to a terminal whose process has already exited reports that instead of succeeding silently.",
].join(" ")

const READ_DESCRIPTION = [
  "Return what a terminal has produced since your last read of it, or from an absolute cursor you pass explicitly.",
  "Reading also works after the process has exited, which is how you collect a program's final output.",
  "Terminal escape sequences are stripped best-effort, so a REPL prompt or a command's output reads normally, but a program that draws a full screen with cursor addressing (vim, htop) does not.",
  `At most ${MAX_READ_BYTES} bytes are returned per call; when the result says it was truncated, read again to continue from where it stopped.`,
].join(" ")

const LIST_DESCRIPTION = [
  "List the terminals this Location holds — running and exited — with their ids, commands, and the exit code of any that have finished.",
  "Exited terminals keep their retained output until they are removed or fall out of the retention window.",
].join(" ")

const STOP_DESCRIPTION = [
  "Terminate a terminal's process and drop it.",
  "Output produced since your last read is returned with the result, so the final lines are not lost; read again is unnecessary if that output is all you needed.",
].join(" ")

export const StartInput = Schema.Struct({
  command: Schema.String.pipe(Schema.optional).annotate({
    description: "Program to run. Defaults to the configured shell.",
  }),
  args: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Arguments passed to the program.",
  }),
  title: Schema.String.pipe(Schema.optional).annotate({
    description: "Short label shown for this terminal. Defaults to a name derived from the id.",
  }),
})

export const StartOutput = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  status: Schema.String,
  output: Schema.String,
})

export const WriteInput = Schema.Struct({
  id: Schema.String.annotate({ description: "Terminal id returned by terminal_start." }),
  input: Schema.String.annotate({
    description: 'Text written verbatim to the terminal\'s stdin. Add "\\n" to submit a line.',
  }),
})

export const WriteOutput = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
})

export const ReadInput = Schema.Struct({
  id: Schema.String.annotate({ description: "Terminal id returned by terminal_start." }),
  cursor: Schema.Number.pipe(Schema.optional).annotate({
    description:
      "Absolute output cursor to read from. Omit it to continue from your last read of this terminal.",
  }),
})

export const ReadOutput = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  output: Schema.String,
  cursor: Schema.Number,
  truncated: Schema.Boolean,
  exitCode: Schema.Number.pipe(Schema.optional),
})

export const ListInput = Schema.Struct({})

export const ListOutput = Schema.Struct({
  terminals: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      command: Schema.String,
      cwd: Schema.String,
      status: Schema.String,
      exitCode: Schema.Number.pipe(Schema.optional),
    }),
  ),
})

export const StopInput = Schema.Struct({
  id: Schema.String.annotate({ description: "Terminal id returned by terminal_start." }),
})

export const StopOutput = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  output: Schema.String,
})

/**
 * Best-effort removal of what an interactive program emits for the terminal to
 * interpret. It cannot rebuild a cursor-addressed screen, so a full-screen
 * program still arrives as its raw control stream.
 */
const plain = (value: string) =>
  value
    // CSI: ESC [ <params> <intermediates> <final>
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // OSC: ESC ] ... terminated by BEL or ST
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // Two-character escapes
    .replace(/\u001b[@-Z\\-_]/g, "")
    // A PTY reports line endings as CRLF.
    .replace(/\r\n/g, "\n")

/** Longest prefix of `value` that fits `max` UTF-8 bytes. */
const fitBytes = (value: string, max: number) => {
  if (Buffer.byteLength(value, "utf8") <= max) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= max) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

const renderRead = (output: typeof ReadOutput.Type) => {
  const header = output.exitCode === undefined ? `${output.id} (${output.status})` : `${output.id} (exited ${output.exitCode})`
  const body = output.output.length === 0 ? "(no new output)" : output.output
  const note = output.truncated ? `\n[more output is buffered; read ${output.id} again]` : ""
  return `${header}\n${body}${note}`
}

const describe = (info: (typeof ListOutput.Type)["terminals"][number]) =>
  `${info.id} — ${info.title} — ${info.status === "running" ? "running" : `exited (${info.exitCode ?? "unknown"})`} — ${info.command} — ${info.cwd}`

/**
 * Per-terminal read cursors, keyed by terminal and Session so two Sessions
 * sharing one Location do not consume each other's output. PTY sessions live
 * only in this process, so the map has exactly the same lifetime as the
 * terminals it tracks.
 */
const cursorKey = (id: string, sessionID: string) => `${id}\u0000${sessionID}`

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const pty = yield* Pty.Service
    const permission = yield* PermissionV2.Service

    const cursors = new Map<string, number>()

    // Reads from `from` and advances this Session's cursor by exactly the raw
    // characters returned, never past them: a truncated read must not swallow
    // the bytes it did not show.
    const drain = (id: PtyID, sessionID: string, from: number) =>
      Effect.gen(function* () {
        const result = yield* pty.read(id, from).pipe(
          Effect.mapError(() => new ToolFailure({ message: `Unknown terminal: ${id}` })),
        )
        const raw = fitBytes(result.chunk, MAX_READ_BYTES)
        const cursor = from + raw.length
        if (raw.length > 0) cursors.set(cursorKey(id, sessionID), cursor)
        return {
          output: plain(raw),
          cursor,
          truncated: raw.length < result.chunk.length,
          status: result.status,
          ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        }
      })

    const source = (context: Context) => ({
      type: "tool" as const,
      messageID: context.assistantMessageID,
      callID: context.toolCallID,
    })

    // Every call that reaches a terminal asserts the `terminal` action, not just
    // the spawn. `withPermission` only decides whether the tool is advertised,
    // so without this a Session holding an id — they are short and guessable —
    // could drive another Session's terminal with nothing to answer to. The
    // action is asserted explicitly, so a catch-all `*` rule asks rather than
    // grants, and one saved answer covers the whole family.
    const authorize = (context: Context) =>
      permission
        .assert({
          action: PERMISSION,
          resources: ["*"],
          save: ["*"],
          explicit: true,
          sessionID: context.sessionID,
          agent: context.agent,
          source: source(context),
        })
        .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied for the terminal.` })))

    const start = Tool.make({
      description: START_DESCRIPTION,
      input: StartInput,
      output: StartOutput,
      toModelOutput: ({ output }) =>
        [
          {
            type: "text",
            text: [
              `Started terminal ${output.id} (${output.title}) running ${output.command} in ${output.cwd}.`,
              output.output.length === 0 ? "" : output.output,
            ]
              .filter((line) => line.length > 0)
              .join("\n"),
          },
        ],
      execute: (input, context) =>
        Effect.gen(function* () {
          // The bash action decides what may run, so an existing `bash` rule keeps
          // working; `*` stands in for the configured shell, which this layer does
          // not resolve. Both assertions are explicit, so a catch-all rule decides
          // neither: a terminal has to be granted by name.
          const command = input.command ?? "*"
          yield* permission.assert({
            action: "bash",
            resources: [command],
            save: [command],
            explicit: true,
            sessionID: context.sessionID,
            agent: context.agent,
            source: source(context),
          })
          yield* authorize(context)
          const info = yield* pty.create({
            ...(input.command === undefined ? {} : { command: input.command }),
            ...(input.args === undefined ? {} : { args: [...input.args] }),
            ...(input.title === undefined ? {} : { title: input.title }),
          })
          const initial = yield* drain(info.id, context.sessionID, 0)
          return {
            id: info.id,
            title: info.title,
            command: info.command,
            cwd: info.cwd,
            status: info.status,
            output: initial.output,
          }
        }).pipe(
          Effect.mapError((error) =>
            error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to start a terminal" }),
          ),
        ),
    })

    const write = Tool.make({
      description: WRITE_DESCRIPTION,
      input: WriteInput,
      output: WriteOutput,
      toModelOutput: ({ output }) => [
        {
          type: "text",
          text:
            output.status === "running"
              ? `Wrote to ${output.id}. Read ${output.id} for the response.`
              : `${output.id} has already exited; nothing was written.`,
        },
      ],
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* authorize(context)
          // `Pty.write` silently ignores an exited Session, so the status is
          // checked here rather than reported as a successful write.
          const info = yield* pty
            .get(PtyID.make(input.id))
            .pipe(Effect.mapError(() => new ToolFailure({ message: `Unknown terminal: ${input.id}` })))
          if (info.status === "exited")
            return yield* new ToolFailure({
              message: `Terminal ${input.id} has exited (${info.exitCode ?? "unknown"}); read its output or start a new terminal.`,
            })
          yield* pty.write(info.id, input.input).pipe(
            Effect.mapError(() => new ToolFailure({ message: `Unknown terminal: ${input.id}` })),
          )
          return { id: input.id, status: info.status }
        }),
    })

    const read = Tool.make({
      description: READ_DESCRIPTION,
      input: ReadInput,
      output: ReadOutput,
      toModelOutput: ({ output }) => [{ type: "text", text: renderRead(output) }],
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* authorize(context)
          const id = PtyID.make(input.id)
          const stored = cursors.get(cursorKey(id, context.sessionID))
          return { id, ...(yield* drain(id, context.sessionID, input.cursor ?? stored ?? 0)) }
        }),
    })

    const list = Tool.make({
      description: LIST_DESCRIPTION,
      input: ListInput,
      output: ListOutput,
      toModelOutput: ({ output }) => [
        {
          type: "text",
          text:
            output.terminals.length === 0
              ? "No terminals in this Location."
              : output.terminals.map(describe).join("\n"),
        },
      ],
      execute: (_input, context) =>
        Effect.gen(function* () {
          yield* authorize(context)
          const infos = yield* pty.list()
          return {
            terminals: infos.map((info) => ({
              id: info.id,
              title: info.title,
              command: info.command,
              cwd: info.cwd,
              status: info.status,
              ...(info.exitCode === undefined ? {} : { exitCode: info.exitCode }),
            })),
          }
        }),
    })

    const stop = Tool.make({
      description: STOP_DESCRIPTION,
      input: StopInput,
      output: StopOutput,
      toModelOutput: ({ output }) => [
        {
          type: "text",
          text: [`Stopped ${output.id}.`, output.output.length === 0 ? "" : output.output]
            .filter((line) => line.length > 0)
            .join("\n"),
        },
      ],
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* authorize(context)
          const id = PtyID.make(input.id)
          // Drain before removing: removal kills the process and drops the
          // retained buffer, so anything read after it would be gone.
          const stored = cursors.get(cursorKey(id, context.sessionID))
          const drained = yield* drain(id, context.sessionID, stored ?? 0)
          yield* pty.remove(id).pipe(Effect.mapError(() => new ToolFailure({ message: `Unknown terminal: ${input.id}` })))
          for (const key of cursors.keys()) if (key.startsWith(`${id}\u0000`)) cursors.delete(key)
          return { id, status: drained.status, output: drained.output }
        }),
    })

    const withPermission = (tool: AnyTool) => Tool.withPermission(tool, PERMISSION, { explicit: true })

    yield* tools
      .register({
        [START]: withPermission(start),
        [WRITE]: withPermission(write),
        [READ]: withPermission(read),
        [LIST]: withPermission(Tool.withConcurrency(list, "concurrent")),
        [STOP]: withPermission(stop),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/terminal",
  layer,
  deps: [ToolRegistry.node, Pty.node, PermissionV2.node],
})
