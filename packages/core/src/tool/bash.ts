export * as BashTool from "./bash"

import path from "path"
import { ToolFailure } from "@miao/llm"
import { Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import { Sandbox } from "../sandbox"
import { SandboxPolicy } from "../sandbox/policy"
import { PositiveInt } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_CAPTURE_BYTES = 1024 * 1024
/** Sandboxed runs per command while approving blocked directories. */
export const MAX_SANDBOX_ATTEMPTS = 4
/** Permission action for rerunning one command without the OS sandbox. Its approval is never saved. */
export const UNSANDBOXED_ACTION = "bash_unsandboxed"

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory. Defaults to the active Location; relative paths resolve from that Location.",
  }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({
      description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} and may not exceed ${MAX_TIMEOUT_MS}.`,
    }),
})

const SandboxInfo = Schema.Struct({
  /** sandboxed: the final run was confined; unsandboxed: rerun outside after approval. */
  state: Schema.Literals(["sandboxed", "unsandboxed"]),
  backend: Schema.String,
  network: Schema.Boolean,
  denied: Schema.Array(Schema.String),
  approved: Schema.Array(Schema.String),
})

type SandboxInfo = typeof SandboxInfo.Type

const StructuredOutput = Schema.Struct({
  exit: Schema.Number.pipe(Schema.optional),
  truncated: Schema.Boolean,
  timeout: Schema.Boolean.pipe(Schema.optional),
  sandbox: SandboxInfo.pipe(Schema.optional),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
})

type Output = typeof Output.Type

const defaultShell = () => (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")

const modelOutput = (output: Output) => {
  const warnings = output.warnings?.length
    ? `\n\nWarnings:\n${output.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : ""
  if (output.timeout) return `${warnings.trimStart()}${warnings ? "\n\n" : ""}Command timed out before completion.`
  return `${warnings.trimStart()}${warnings ? "\n\n" : ""}Command exited with code ${output.exit}.`
}

const isTimeout = (error: AppProcess.AppProcessError) =>
  error.cause instanceof Error && error.cause.message === "Timed out"

const description = (status: Sandbox.Status) => {
  const authority =
    status.enabled && status.available
      ? `Execute one shell command string inside an OS sandbox (${status.backend}): reads are unrestricted, writes are limited to the active Location, the working directory, temp directories, and approved paths, and network access is ${status.network ? "allowed" : "denied"}. When the sandbox blocks a write, the user is asked to allow that directory and the command is rerun, so avoid writing outside the workspace unless the task needs it.`
      : "Execute one shell command string with the host user's filesystem, process, and network authority."
  const unavailable =
    status.enabled && !status.available
      ? " An OS sandbox was requested but is unavailable on this host, so commands run unsandboxed."
      : ""
  return `${authority}${unavailable} The active Location is the default working directory. Relative workdir values resolve from that Location. External workdir values require external_directory approval; best-effort command-argument path warnings are advisory only. Timeout values are milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}). Uses the configured shell when set; otherwise uses /bin/sh on POSIX and COMSPEC or cmd.exe on Windows.`
}

const UNAVAILABLE_WARNING =
  "The OS sandbox is enabled but no sandbox runner is available on this host; the command ran unsandboxed."

type Approval = { readonly approved: true } | { readonly approved: false; readonly feedback?: string }

interface Outcome {
  readonly result: AppProcess.RunResult | undefined
  readonly sandbox?: SandboxInfo
  readonly warnings: readonly string[]
}

const blockedWarning = (denied: readonly string[], unmapped: readonly string[], feedback?: string) =>
  [
    denied.length ? `The OS sandbox blocked writes to: ${denied.join(", ")}.` : undefined,
    unmapped.length
      ? `The OS sandbox blocked an operation without a path (for example network access): ${unmapped[0]!.trim()}`
      : undefined,
    "The command was not rerun outside the sandbox.",
    feedback ? `User feedback: ${feedback}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join(" ")

/**
 * Minimal V2 core shell boundary. Keep parity debt visible without pulling the
 * legacy shell runtime into core.
 */
// TODO: Port tree-sitter bash / PowerShell parser-based approval reduction.
// TODO: Port BashArity reusable command-prefix approvals.
// TODO: Replace token-based command-argument external-directory advisories with parser-based detection.
// TODO: Restore PowerShell and cmd-specific invocation/path handling on Windows.
// TODO: Add plugin shell.env environment augmentation once V2 plugin hooks exist.
// TODO: Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.
// TODO: Persist background job status and define restart recovery before exposing remote observation.
// TODO: Re-add model-facing background launch only with owner-bound get/wait/cancel tools and completion delivery.
// TODO: Add HTTP background-job observation only after durable status, restart recovery, and authorization are defined.
// TODO: Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.
// TODO: Revisit binary output handling if stdout/stderr decoding is text-only.
// TODO: Stream full shell output into managed storage while retaining only a bounded in-memory preview.

const shellTokens = (command: string) => command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, "$2")
const externalCommandDirectories = Effect.fn("BashTool.externalCommandDirectories")(function* (
  fs: FSUtil.Interface,
  command: string,
  cwd: string,
) {
  const directories = new Set<string>()
  for (const token of shellTokens(command)) {
    const value = unquote(token).replace(/[;,|&]+$/, "")
    if (!path.isAbsolute(value)) continue
    const resolved = yield* fs.resolve(value)
    if (FSUtil.contains(cwd, resolved)) continue
    directories.add(yield* fs.resolve(path.dirname(resolved)))
  }
  return [...directories]
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const permission = yield* PermissionV2.Service
    const sandbox = yield* Sandbox.Service

    const exec = (command: ChildProcess.Command, timeout: number) =>
      appProcess
        .run(command, {
          combineOutput: true,
          timeout: Duration.millis(timeout),
          maxOutputBytes: MAX_CAPTURE_BYTES,
        })
        .pipe(
          Effect.catchTag("AppProcessError", (error) =>
            isTimeout(error) ? Effect.succeed(undefined) : Effect.fail(error),
          ),
        )

    // A declined, corrected, or rule-blocked escalation is an answer, not a
    // tool failure: the caller keeps the sandboxed result. Interruption and
    // every other defect still propagate.
    const decide = (input: PermissionV2.AssertInput) =>
      permission.assert(input).pipe(
        Effect.as<Approval>({ approved: true }),
        Effect.catchTags({
          "PermissionV2.BlockedError": () => Effect.succeed<Approval>({ approved: false }),
          "PermissionV2.CorrectedError": (error) =>
            Effect.succeed<Approval>({ approved: false, feedback: error.feedback }),
        }),
        Effect.catchDefect((defect) =>
          defect instanceof PermissionV2.DeclinedError
            ? Effect.succeed<Approval>({ approved: false })
            : Effect.die(defect),
        ),
      )

    /**
     * Run under the OS sandbox. Level 1: when the kernel blocks paths, ask
     * external_directory approval for their directories and rerun with them
     * writable. Level 2: when that is declined or exhausted, or a denial names
     * no path, ask once to rerun the command without the sandbox.
     */
    const confined = Effect.fn("BashTool.confined")(function* (input: {
      readonly command: string
      readonly shell: string
      readonly cwd: string
      readonly timeout: number
      readonly network: boolean
      readonly options: ChildProcess.CommandOptions
      readonly request: Pick<PermissionV2.AssertInput, "sessionID" | "agent" | "source">
    }) {
      const plain = ChildProcess.make(input.command, [], { ...input.options, shell: input.shell })
      const approved: string[] = []
      const run = (attempt: number) =>
        Effect.gen(function* () {
          const wrapped = yield* sandbox.wrap({
            shell: input.shell,
            script: input.command,
            cwd: input.cwd,
            writable: approved,
            options: input.options,
          })
          if (!wrapped) return undefined
          const result = yield* exec(wrapped.command, input.timeout)
          const denied = yield* wrapped.denied
          yield* Effect.annotateCurrentSpan({
            "sandbox.backend": wrapped.backend,
            "sandbox.denied_count": denied.length,
          })
          return { result, denied, backend: wrapped.backend, writable: wrapped.writable }
        }).pipe(
          Effect.withSpan("Sandbox.run", {
            attributes: {
              "sandbox.mode": "workspace-write",
              "sandbox.network": input.network,
              "sandbox.attempt": attempt,
              "sandbox.escalation": attempt === 1 ? "none" : "paths",
            },
          }),
        )
      const info = (state: SandboxInfo["state"], backend: string, denied: readonly string[]): SandboxInfo => ({
        state,
        backend,
        network: input.network,
        denied: [...denied],
        approved: [...approved],
      })

      for (let attempt = 1; ; attempt++) {
        const current = yield* run(attempt)
        // The runner disappeared between the status check and the wrap.
        if (!current) return { result: yield* exec(plain, input.timeout), warnings: [UNAVAILABLE_WARNING] } as Outcome
        const done: Outcome = {
          result: current.result,
          sandbox: info("sandboxed", current.backend, current.denied),
          warnings: [],
        }
        // A timeout is not retried: rerunning would double the wait.
        if (!current.result || current.result.exitCode === 0) return done
        const blocked = yield* Effect.forEach(current.denied, (item) => fs.resolve(path.dirname(item)))
        const directories = [...new Set(blocked)].filter(
          (directory) => !current.writable.some((root) => FSUtil.contains(root, directory)),
        )
        const unmapped = SandboxPolicy.unmappedDenials(current.result.output?.toString("utf8") ?? "", {
          network: input.network,
        })
        // Nothing the sandbox could have caused: an ordinary failing command.
        if (directories.length === 0 && unmapped.length === 0) return done

        const patterns = directories.map((directory) => path.join(directory, "*").replaceAll("\\", "/"))
        const level1 =
          directories.length > 0 && attempt < MAX_SANDBOX_ATTEMPTS
            ? yield* decide({
                ...input.request,
                action: "external_directory",
                resources: patterns,
                save: patterns,
                metadata: { command: input.command, denied: current.denied, directories, sandbox: true },
              })
            : undefined
        if (level1?.approved) {
          approved.push(...directories)
          continue
        }

        // No `save`: an "always" reply cannot persist leaving the sandbox.
        const level2 = yield* decide({
          ...input.request,
          action: UNSANDBOXED_ACTION,
          resources: [input.command],
          metadata: { command: input.command, denied: current.denied, unmapped },
        })
        if (!level2.approved) {
          const feedback = level2.feedback ?? (level1 && !level1.approved ? level1.feedback : undefined)
          return { ...done, warnings: [blockedWarning(current.denied, unmapped, feedback)] } as Outcome
        }
        const result = yield* exec(plain, input.timeout).pipe(
          Effect.withSpan("Sandbox.run", {
            attributes: {
              "sandbox.mode": "unsandboxed",
              "sandbox.backend": current.backend,
              "sandbox.attempt": attempt + 1,
              "sandbox.escalation": "unsandboxed",
            },
          }),
        )
        return {
          result,
          sandbox: info("unsandboxed", current.backend, current.denied),
          warnings: ["The OS sandbox blocked this command; after one-time approval it was rerun without the sandbox."],
        } as Outcome
      }
    })

    yield* tools
      .register({
        [name]: Tool.make({
          description: description(yield* sandbox.status()),
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({
            truncated: output.truncated,
            ...(output.exit === undefined ? {} : { exit: output.exit }),
            ...(output.timeout === undefined ? {} : { timeout: output.timeout }),
            ...(output.sandbox === undefined ? {} : { sandbox: output.sandbox }),
          }),
          toModelOutput: ({ output }) => [
            { type: "text", text: output.output },
            { type: "text", text: modelOutput(output) },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.workdir ?? ".", kind: "directory" })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              const warnings = (yield* externalCommandDirectories(fs, input.command, target.canonical)).map(
                (directory) =>
                  `Command argument references external directory ${path.join(directory, "*").replaceAll("\\", "/")}. Bash runs with host-user filesystem, process, and network authority; this scan is advisory only.`,
              )
              yield* permission.assert({
                action: name,
                resources: [input.command],
                save: [input.command],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })

              if ((yield* fs.stat(target.canonical)).type !== "Directory")
                return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.canonical}`))

              const entries = yield* config.entries()
              const shell =
                Object.assign({}, ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : [])))
                  .shell ?? defaultShell()
              const options = {
                cwd: target.canonical,
                stdin: "ignore",
                detached: process.platform !== "win32",
                forceKillAfter: Duration.seconds(3),
              } as const
              const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
              const status = yield* sandbox.status()
              if (status.enabled && !status.available && status.onUnavailable === "fail")
                return yield* new ToolFailure({
                  message:
                    "The OS sandbox is enabled with sandbox.on_unavailable set to fail, but no sandbox runner is available on this host.",
                })
              const outcome: Outcome =
                status.enabled && status.available
                  ? yield* confined({
                      command: input.command,
                      shell,
                      cwd: target.canonical,
                      timeout,
                      network: status.network,
                      options,
                      request: { sessionID: context.sessionID, agent: context.agent, source },
                    })
                  : {
                      result: yield* exec(ChildProcess.make(input.command, [], { ...options, shell }), timeout),
                      warnings: status.enabled ? [UNAVAILABLE_WARNING] : [],
                    }
              const allWarnings = [...warnings, ...outcome.warnings]
              const extra = {
                ...(allWarnings.length ? { warnings: allWarnings } : {}),
                ...(outcome.sandbox ? { sandbox: outcome.sandbox } : {}),
              }
              if (!outcome.result) {
                return {
                  output: `Command exceeded timeout of ${timeout} ms. Retry with a larger timeout if the command is expected to take longer.`,
                  truncated: false,
                  timeout: true,
                  ...extra,
                }
              }

              const output = outcome.result.output?.toString("utf8") || "(no output)"
              const notice = outcome.result.outputTruncated
                ? "[output capture truncated at the in-memory safety limit]"
                : undefined
              return {
                exit: outcome.result.exitCode,
                output: notice ? `${output}\n\n${notice}` : output,
                truncated: outcome.result.outputTruncated === true,
                ...extra,
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to execute command: ${input.command}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/bash",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FSUtil.node,
    AppProcess.node,
    Config.node,
    PermissionV2.node,
    Sandbox.node,
  ],
})
