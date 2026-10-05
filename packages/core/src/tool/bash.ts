export * as BashTool from "./bash"

import { existsSync } from "fs"
import path from "path"
import { ToolFailure } from "@miao/llm"
import { Duration, Effect, Layer, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { AppProcess } from "../process"
import { BackgroundJob } from "../background-job"
import { PermissionV2 } from "../permission"
import { Sandbox } from "../sandbox"
import { ShellApproval } from "../shell/approval"
import { ShellEnvironment } from "../shell/environment"
import { SandboxPolicy } from "../sandbox/policy"
import { PositiveInt } from "../schema"
import { Hash } from "../util/hash"
import { which } from "../util/which"
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
/** Largest `stdin` payload, in UTF-8 bytes. */
export const MAX_STDIN_BYTES = 1024 * 1024
/** How long the pre-run `-n` syntax check may take before it is ignored. */
export const SYNTAX_CHECK_TIMEOUT_MS = 2_000

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
  stdin: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Text written verbatim to the command's standard input, never parsed by the shell. Use it to hand a script to another interpreter instead of nesting quotes or heredocs, for example `ssh host 'bash -s'`, `docker exec -i <container> sh`, `kubectl exec -i <pod> -- sh`, `python3 -`, or `psql`. At most 1 MiB. Omit it and standard input is closed.",
  }),
  run_in_background: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Run the command as a managed background job and return immediately with its id instead of waiting. Observe it with job_list, job_wait, and job_cancel.",
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

export const StructuredOutput = Schema.Struct({
  exit: Schema.Number.pipe(Schema.optional),
  truncated: Schema.Boolean,
  timeout: Schema.Boolean.pipe(Schema.optional),
  sandbox: SandboxInfo.pipe(Schema.optional),
  jobID: Schema.String.pipe(Schema.optional),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
})

type Output = typeof Output.Type

const defaultShell = () => (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")

/**
 * PowerShell and PowerShell 7 need `-Command`; the runtime's generic `shell`
 * option only promises `/bin/sh`-style `-c` handling. Match by file name so a
 * resolved path such as `C:\...\powershell.exe` is detected too.
 */
const isPowerShell = (shell: string) => {
  const base = path.basename(shell).toLowerCase()
  return base === "powershell" || base === "powershell.exe" || base === "pwsh" || base === "pwsh.exe"
}

/**
 * Resolve a configured bare shell name on Windows to its executable path.
 * Without this, the spawner sees a non-executable command name and wraps the
 * call in `cmd.exe /d /s /c`, re-parsing the script the way cmd.exe does
 * rather than the way the configured shell does.
 */
const resolveShell = (shell: string) => {
  if (process.platform !== "win32") return shell
  if (path.isAbsolute(shell)) return shell
  return which(shell) ?? shell
}

/**
 * Build the command that runs `command` under `shell`. On Windows a
 * PowerShell is invoked profile-free with `-NoProfile -Command`, so a host
 * profile can neither change parsing nor prepend output. cmd.exe and every
 * other shell keep the runtime's `shell` handling, which on Windows already
 * applies the correct `/d /s /c` quoting.
 */
const shellCommand = (shell: string, command: string, options: ChildProcess.CommandOptions): ChildProcess.Command =>
  process.platform === "win32" && isPowerShell(shell)
    ? ChildProcess.make(shell, ["-NoProfile", "-Command", command], options)
    : ChildProcess.make(command, [], { ...options, shell })

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
  return `${authority}${unavailable} The active Location is the default working directory. Relative workdir values resolve from that Location. External workdir values require external_directory approval; best-effort command-argument path warnings are advisory only. Timeout values are milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}). Uses the configured shell when set; otherwise uses /bin/sh on POSIX and COMSPEC or cmd.exe on Windows. When a script runs inside another interpreter or on a remote host (ssh, docker exec, kubectl exec, python, psql), put the script in \`stdin\` instead of nesting quotes or heredocs inside \`command\`. A command the shell cannot parse is not run; the shell's syntax error is returned instead.`
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
// TODO: Port PowerShell parser-based approval reduction (bash commands already split per command with BashArity prefixes).
// TODO: Replace token-based command-argument external-directory advisories with parser-based detection.
// TODO: Restore PowerShell and cmd-specific invocation/path handling on Windows.
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

/**
 * Separates the command from its stdin in permission resources, so a saved
 * exact rule reads as the command, a `<<stdin` line, and the script it
 * approved. The leading space keeps prefix rules such as `cat *` (which
 * Wildcard reads as "cat, optionally followed by a space and anything")
 * matching a bare `cat` that is given stdin.
 */
const STDIN_MARKER = " \n<<stdin"

/**
 * Permission resources (and the matching `save` list) for one call.
 *
 * Without stdin this is exactly `[command]`, as before. With stdin it is the
 * command plus the full script, so the prompt and saved rule show the script,
 * and a second resource naming the script's sha256. Every resource must be
 * allowed, and wildcard characters in the script would make the full-text rule
 * a pattern (`SELECT *`), so the digest is what keeps an exact rule from
 * approving a different script. Rules written as patterns, such as `ssh *`,
 * match both resources and keep their meaning.
 *
 * A command without stdin that itself contains the marker could spell out a
 * saved stdin rule (and, run as shell text, would expand that script locally).
 * It gets an extra resource that no rule built from a command matches, so
 * only a catch-all rule allows it without a prompt.
 */
const permissionResources = (command: string, stdin: string | undefined) => {
  if (stdin !== undefined)
    return [`${command}${STDIN_MARKER}\n${stdin}`, `${command}${STDIN_MARKER} sha256:${Hash.sha256(stdin)}`]
  if (command.includes(STDIN_MARKER)) return [command, `<<no-stdin\n${command}`]
  return [command]
}

/** Shells whose `-n` flag parses a `-c` script without running any of it. */
const SYNTAX_CHECKED_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh"])

/**
 * Words that make `<shell> -n` an unreliable stand-in for the real run, so the
 * syntax check is skipped when the script mentions any of them.
 *
 * `-n` parses the whole script without running anything, but the real run
 * parses and runs it a line at a time (bash, dash, ksh). Builtins that change
 * how later lines parse (aliases, `shopt -s extglob`, `set -o`, zsh options,
 * sourced files, eval, posix mode) take effect in the real run only, so `-n`
 * could reject a script that runs fine. `exit`, `exec`, and `logout` end the
 * real run before later lines are parsed at all. `trap` is skipped to stay
 * conservative. Matching is by whole word anywhere in the text, including
 * quoted text and heredoc bodies; skipping more often only means checking less.
 */
const PARSE_STATE_WORDS = new Set([
  "shopt",
  "alias",
  "unalias",
  "set",
  "source",
  "eval",
  "enable",
  "disable",
  "setopt",
  "unsetopt",
  "emulate",
  "builtin",
  "trap",
  "exit",
  "exec",
  "logout",
  // zsh parameters that change aliases or options when assigned.
  "options",
  "aliases",
  "galiases",
  "saliases",
  // bash variables that define aliases or change the parser's mode.
  "BASH_ALIASES",
  "POSIXLY_CORRECT",
  "BASH_COMPAT",
])

/** A `.` (source) command: a lone dot followed by whitespace. */
const DOT_COMMAND = /(?:^|[\s;&|(){}`!])\.(?=\s)/

const changesParseState = (command: string) =>
  // Also test the text with quotes and backslashes removed, since the shell
  // runs `sh'opt'` or `\set` as the builtin itself.
  [command, command.replace(/['"\\]/g, "")].some(
    (text) => DOT_COMMAND.test(text) || text.split(/[^\w-]+/).some((word) => PARSE_STATE_WORDS.has(word)),
  )

/**
 * Whether `<shell> -n -c <command>` parses exactly as `<shell> -c <command>`
 * will. Startup files run before the script and may change parsing (for
 * example `shopt -s extglob` in BASH_ENV), but `-n` does not run them, so any
 * shell that would read one is skipped.
 */
const syntaxCheckable = (shell: string, command: string) => {
  if (process.platform === "win32") return false
  const name = path.basename(shell)
  if (!SYNTAX_CHECKED_SHELLS.has(name)) return false
  // bash reads BASH_ENV, and some shells read ENV, before a `-c` script.
  if (process.env.BASH_ENV || process.env.ENV) return false
  if (name === "zsh" && !zshWithoutStartupFiles(shell)) return false
  return !changesParseState(command)
}

/**
 * zsh always reads zshenv, even for `-c`. Only the system zsh builds have a
 * known global zshenv location, so other zsh binaries are not checked.
 */
const zshWithoutStartupFiles = (shell: string) => {
  if (shell !== "/bin/zsh" && shell !== "/usr/bin/zsh") return false
  const home = process.env.ZDOTDIR || process.env.HOME
  if (!home) return false
  return ["/etc/zshenv", "/etc/zsh/zshenv", path.join(home, ".zshenv"), path.join(home, ".zshenv.zwc")].every(
    (file) => !existsSync(file),
  )
}

const syntaxErrorMessage = (shell: string, stderr: string) =>
  [
    `The command was not run: ${shell} -n reported a syntax error.`,
    stderr.trim() || "(the shell printed no details)",
    "If the command nests quotes or heredocs for another interpreter or a remote host, pass that script through the `stdin` parameter instead (for example command `ssh host 'bash -s'` with the script in stdin).",
  ].join("\n\n")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const permission = yield* PermissionV2.Service
    const sandbox = yield* Sandbox.Service
    const shellEnvironment = yield* ShellEnvironment.Service
    const location = yield* Location.Service

    // With stdin, AppProcess pipes it in from a separate fiber and closes the
    // pipe when done; a command that exits without reading it does not wait on
    // the write, and the timeout still ends the run.
    const exec = (command: ChildProcess.Command, timeout: number, stdin: string | undefined) =>
      appProcess
        .run(command, {
          combineOutput: true,
          timeout: Duration.millis(timeout),
          maxOutputBytes: MAX_CAPTURE_BYTES,
          ...(stdin === undefined ? {} : { stdin }),
        })
        .pipe(
          Effect.catchTag("AppProcessError", (error) =>
            isTimeout(error) ? Effect.succeed(undefined) : Effect.fail(error),
          ),
        )

    /**
     * Parse the command with the shell that will run it: the same executable,
     * `-n` added before the same `-c <command>`, the same working directory and
     * inherited environment. The sandboxed path runs `<shell> -c <command>`
     * under the runner, so this matches it too; parsing reads nothing the
     * sandbox restricts. Returns the shell's report only when it exited
     * normally with a non-zero code. A check that cannot spawn, times out, or
     * dies from a signal never blocks the command.
     */
    const syntaxError = Effect.fn("BashTool.syntaxError")(function* (
      shell: string,
      command: string,
      options: ChildProcess.CommandOptions,
    ) {
      if (!syntaxCheckable(shell, command)) return undefined
      const result = yield* appProcess
        .run(ChildProcess.make(shell, ["-n", "-c", command], options), {
          combineOutput: true,
          timeout: Duration.millis(SYNTAX_CHECK_TIMEOUT_MS),
          maxOutputBytes: 64 * 1024,
        })
        .pipe(Effect.option)
      if (result._tag === "None" || result.value.exitCode === 0) return undefined
      return result.value.output ? AppProcess.decodeOutput(result.value.output) : ""
    })

    // A declined, corrected, or rule-blocked escalation is an answer, not a
    // tool failure: the caller keeps the sandboxed result. Interruption and
    // every other defect still propagate.
    const decide = (input: PermissionV2.AssertInput) =>
      permission.assert({ ...input, explicit: true }).pipe(
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
      readonly stdin: string | undefined
      readonly shell: string
      readonly cwd: string
      readonly timeout: number
      readonly network: boolean
      readonly options: ChildProcess.CommandOptions
      readonly request: Pick<PermissionV2.AssertInput, "sessionID" | "agent" | "source">
    }) {
      const plain = shellCommand(input.shell, input.command, input.options)
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
          const result = yield* exec(wrapped.command, input.timeout, input.stdin)
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
        if (!current)
          return { result: yield* exec(plain, input.timeout, input.stdin), warnings: [UNAVAILABLE_WARNING] } as Outcome
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
        const unmapped = SandboxPolicy.unmappedDenials(current.result.output ? AppProcess.decodeOutput(current.result.output) : "", {
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
                metadata: {
                  command: input.command,
                  ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
                  denied: current.denied,
                  directories,
                  sandbox: true,
                },
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
          resources: permissionResources(input.command, input.stdin),
          metadata: {
            command: input.command,
            ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
            denied: current.denied,
            unmapped,
          },
        })
        if (!level2.approved) {
          const feedback = level2.feedback ?? (level1 && !level1.approved ? level1.feedback : undefined)
          return { ...done, warnings: [blockedWarning(current.denied, unmapped, feedback)] } as Outcome
        }
        const result = yield* exec(plain, input.timeout, input.stdin).pipe(
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
              if (input.stdin !== undefined && Buffer.byteLength(input.stdin, "utf8") > MAX_STDIN_BYTES)
                return yield* new ToolFailure({
                  message: `stdin is ${Buffer.byteLength(input.stdin, "utf8")} bytes, over the ${MAX_STDIN_BYTES}-byte limit. The command was not run.`,
                })
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
              const exact = permissionResources(input.command, input.stdin)
              // A plain command is approved per command it runs, and "always"
              // saves prefix rules such as `git status *`, as V1 did. With stdin
              // (or the stdin marker spelled out) the exact resources stay, so a
              // script is never approved through a broad prefix.
              const split =
                exact.length === 1 && process.platform !== "win32"
                  ? yield* Effect.tryPromise(() => ShellApproval.bash(input.command)).pipe(
                      Effect.option,
                      Effect.map(Option.getOrUndefined),
                    )
                  : undefined
              yield* permission.assert({
                action: name,
                resources: split?.resources ?? exact,
                save: split?.save ?? exact,
                ...(input.stdin === undefined ? {} : { metadata: { command: input.command, stdin: input.stdin } }),
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })

              if ((yield* fs.stat(target.canonical)).type !== "Directory")
                return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.canonical}`))

              const entries = yield* config.entries()
              const shell =
                resolveShell(
                  Object.assign({}, ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : []))).shell ??
                    defaultShell(),
                )
              // Plugin `shell.env` variables, layered over the inherited environment as in V1.
              const env = yield* shellEnvironment.get({
                directory: location.directory,
                cwd: target.canonical,
                sessionID: context.sessionID,
                callID: context.toolCallID,
              })
              const options = {
                cwd: target.canonical,
                ...(Object.keys(env).length === 0 ? {} : { env, extendEnv: true }),
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
              const invalid = yield* syntaxError(shell, input.command, options)
              if (invalid !== undefined) return yield* new ToolFailure({ message: syntaxErrorMessage(shell, invalid) })
              // Everything above is permission, syntax, and sandbox setup and
              // runs before a background job starts; only the command itself is
              // deferred, so a background command keeps the same authorization
              // and confinement as a foreground one.
              const run = Effect.gen(function* () {
                const outcome: Outcome =
                  status.enabled && status.available
                    ? yield* confined({
                        command: input.command,
                        stdin: input.stdin,
                        shell,
                        cwd: target.canonical,
                        timeout,
                        network: status.network,
                        options,
                        request: { sessionID: context.sessionID, agent: context.agent, source },
                      })
                    : {
                        result: yield* exec(shellCommand(shell, input.command, options), timeout, input.stdin),
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

                const output =
                  (outcome.result.output ? AppProcess.decodeOutput(outcome.result.output) : "") || "(no output)"
                const notice = outcome.result.outputTruncated
                  ? "[output capture truncated at the in-memory safety limit]"
                  : undefined
                return {
                  exit: outcome.result.exitCode,
                  output: notice ? `${output}\n\n${notice}` : output,
                  truncated: outcome.result.outputTruncated === true,
                  ...extra,
                }
              })
              if (input.run_in_background === true) {
                const jobs = yield* Effect.serviceOption(BackgroundJob.Service)
                if (Option.isNone(jobs))
                  return yield* new ToolFailure({ message: "Background jobs are not available in this runtime." })
                const job = yield* jobs.value.start({
                  type: "bash",
                  title: input.command,
                  metadata: { sessionID: context.sessionID },
                  run: run.pipe(
                    Effect.map((result) => modelOutput(result)),
                    Effect.catchCause((cause) => Effect.succeed(`Background command failed: ${cause}`)),
                  ),
                })
                return {
                  output: `Command started in the background as job ${job.id}.`,
                  truncated: false,
                  jobID: job.id,
                }
              }
              return yield* run
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
    ShellEnvironment.node,
    Location.node,
  ],
})
