import { Context, Duration, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { appendFile, stat } from "node:fs/promises"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "./cross-spawn-spawner"
import { makeGlobalNode } from "./effect/app-node"

// Windows shells write bytes in the console's active code page, not UTF-8, so a
// Chinese `cmd.exe` (`chcp 936`) emits GBK and `dir` file names rendered as
// replacement characters when decoded as UTF-8. Decode strictly as UTF-8 first
// and fall back to the OEM code page only when those bytes are not valid UTF-8,
// so already-UTF-8 output (the common case) is untouched. The label may be
// overridden with `MIAO_WINDOWS_CODEPAGE`; the default 936 (GBK) covers the
// reported case, and latin1 is the last resort because it never throws.
const windowsCodepageLabel = (): ConstructorParameters<typeof TextDecoder>[0] =>
  (process.env["MIAO_WINDOWS_CODEPAGE"] ?? "gbk") as ConstructorParameters<typeof TextDecoder>[0]

// Split out from `decodeOutput` so the Windows fallback is exercisable off
// Windows: pass `windows: true` in a test to run the code-page branch.
export function decodeBytes(buffer: Buffer, options: { windows: boolean }): string {
  if (!options.windows) return buffer.toString("utf8")
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer)
  } catch {
    try {
      return new TextDecoder(windowsCodepageLabel()).decode(buffer)
    } catch {
      return buffer.toString("latin1")
    }
  }
}

export function decodeOutput(buffer: Buffer): string {
  return decodeBytes(buffer, { windows: process.platform === "win32" })
}

export class AppProcessError extends Schema.TaggedErrorClass<AppProcessError>()("AppProcessError", {
  command: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  stderr: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    const detail =
      this.stderr?.trim() || (this.cause instanceof Error ? this.cause.message : this.cause && String(this.cause))
    const status = this.exitCode === undefined ? "" : ` (exit ${this.exitCode})`
    return `Command failed${status}: ${this.command}${detail ? `: ${detail}` : ""}`
  }
}

export interface RunOptions {
  readonly combineOutput?: boolean
  readonly maxOutputBytes?: number
  readonly maxErrorBytes?: number
  /**
   * Append output here as it arrives: merged stdout/stderr with combineOutput,
   * stdout otherwise. The in-memory preview stays bounded by maxOutputBytes.
   */
  readonly outputFile?: string
  /** Cap on bytes appended to `outputFile`; the file stops growing once reached. */
  readonly outputFileMaxBytes?: number
  readonly signal?: AbortSignal
  readonly timeout?: Duration.Input
  readonly stdin?: string | Uint8Array | Stream.Stream<Uint8Array, PlatformError>
}

export interface RunStreamOptions {
  readonly signal?: AbortSignal
  readonly includeStderr?: boolean
  readonly okExitCodes?: ReadonlyArray<number>
  readonly maxErrorBytes?: number
}

export interface RunResult {
  readonly command: string
  readonly exitCode: number
  readonly output?: Buffer
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly outputTruncated?: boolean
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  /** Path the full output was streamed to, when `outputFile` was set. */
  readonly outputPath?: string
  /** Total bytes received, before the in-memory preview was truncated. */
  readonly outputBytes?: number
  /** True when file capture dropped bytes due to its size cap or a write error. */
  readonly outputFileTruncated?: boolean
}

export type Interface = ChildProcessSpawner["Service"] & {
  readonly run: (command: ChildProcess.Command, options?: RunOptions) => Effect.Effect<RunResult, AppProcessError>
  readonly runStream: (
    command: ChildProcess.Command,
    options?: RunStreamOptions,
  ) => Stream.Stream<string, AppProcessError>
}

export class Service extends Context.Service<Service, Interface>()("@miao/AppProcess") {}

export const requireSuccess = (result: RunResult): Effect.Effect<RunResult, AppProcessError> =>
  result.exitCode === 0
    ? Effect.succeed(result)
    : Effect.fail(
        new AppProcessError({
          command: result.command,
          exitCode: result.exitCode,
          stderr: decodeOutput(result.stderr),
        }),
      )

export const requireExitIn =
  (codes: ReadonlyArray<number>) =>
  (result: RunResult): Effect.Effect<RunResult, AppProcessError> =>
    codes.includes(result.exitCode)
      ? Effect.succeed(result)
      : Effect.fail(
          new AppProcessError({
            command: result.command,
            exitCode: result.exitCode,
            stderr: decodeOutput(result.stderr),
          }),
        )

const describeCommand = (command: ChildProcess.Command): string => {
  if (command._tag === "StandardCommand") {
    return command.args.length ? `${command.command} ${command.args.join(" ")}` : command.command
  }
  return `${describeCommand(command.left)} | ${describeCommand(command.right)}`
}

const wrapError = (description: string, cause: unknown): AppProcessError =>
  cause instanceof AppProcessError ? cause : new AppProcessError({ command: description, cause })

export const abortError = (signal: AbortSignal): Error => {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}

export const waitForAbort = (signal: AbortSignal) =>
  Effect.callback<never, Error>((resume) => {
    if (signal.aborted) {
      resume(Effect.fail(abortError(signal)))
      return
    }
    const onabort = () => resume(Effect.fail(abortError(signal)))
    signal.addEventListener("abort", onabort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onabort))
  })

const normalizeStdin = (
  input: string | Uint8Array | Stream.Stream<Uint8Array, PlatformError>,
): Stream.Stream<Uint8Array, PlatformError> =>
  typeof input === "string"
    ? Stream.make(new TextEncoder().encode(input))
    : input instanceof Uint8Array
      ? Stream.make(input)
      : input

export const collectStream = (
  stream: Stream.Stream<Uint8Array, PlatformError>,
  maxOutputBytes: number | undefined,
  outputFile?: string,
  outputFileMaxBytes?: number,
) =>
  Effect.gen(function* () {
    // Subscribe immediately after spawning: awaiting filesystem work here can
    // lose output from short-lived children that finish before stream setup.
    // File-write failures mark capture incomplete without failing the command.
    let fileBytes = 0
    let fileTruncated = false
    let fileFailed = false
    const teed =
      outputFile === undefined
        ? stream
        : stream.pipe(
            Stream.mapEffect((chunk) => {
              if (fileFailed) return Effect.succeed(chunk)
              const remaining =
                outputFileMaxBytes === undefined ? chunk.length : Math.max(0, outputFileMaxBytes - fileBytes)
              const captured = chunk.subarray(0, remaining)
              if (captured.length < chunk.length) fileTruncated = true
              if (captured.length === 0) return Effect.succeed(chunk)
              return Effect.tryPromise(() => appendFile(outputFile, captured)).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    fileBytes += captured.length
                  }),
                ),
                Effect.catch(() =>
                  Effect.sync(() => {
                    fileFailed = true
                    fileTruncated = true
                  }),
                ),
                Effect.as(chunk),
              )
            }),
          )
    return yield* Stream.runFold(
      teed,
      () => ({ chunks: [] as Uint8Array[], bytes: 0, truncated: false }),
      (acc, chunk) => {
        if (maxOutputBytes === undefined) {
          acc.chunks.push(chunk)
          acc.bytes += chunk.length
          return acc
        }
        const remaining = maxOutputBytes - acc.bytes
        if (remaining > 0) acc.chunks.push(remaining >= chunk.length ? chunk : chunk.slice(0, remaining))
        acc.bytes += chunk.length
        acc.truncated = acc.truncated || acc.bytes > maxOutputBytes
        return acc
      },
    ).pipe(
      Effect.map((x) => ({
        buffer: Buffer.concat(x.chunks),
        truncated: x.truncated,
        bytes: x.bytes,
        fileTruncated,
      })),
    )
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    const runCommand = (command: ChildProcess.Command, options?: RunOptions) => {
      const description = describeCommand(command)
      const collect = Effect.scoped(
        Effect.gen(function* () {
          // Include output from earlier attempts in the file cap, before the
          // child starts so capture can subscribe without an asynchronous gap.
          const file = options?.outputFile
          const maximum = options?.outputFileMaxBytes
          const fileBudget =
            file === undefined || maximum === undefined
              ? maximum
              : yield* Effect.tryPromise(() => stat(file)).pipe(
                  Effect.map((info) => Math.max(0, maximum - info.size)),
                  Effect.catch(() => Effect.succeed(maximum)),
                )
          const handle = yield* spawner.spawn(command)
          if (options?.combineOutput) {
            const [output, exitCode] = yield* Effect.all(
              [collectStream(handle.all, options.maxOutputBytes, options.outputFile, fileBudget), handle.exitCode],
              { concurrency: "unbounded" },
            )
            return {
              command: description,
              exitCode,
              output: output.buffer,
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
              outputTruncated: output.truncated,
              stdoutTruncated: false,
              stderrTruncated: false,
              ...(options.outputFile === undefined
                ? {}
                : {
                    outputPath: options.outputFile,
                    outputBytes: output.bytes,
                    outputFileTruncated: output.fileTruncated,
                  }),
            } satisfies RunResult
          }
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collectStream(handle.stdout, options?.maxOutputBytes, options?.outputFile, fileBudget),
              collectStream(handle.stderr, options?.maxErrorBytes),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          )
          return {
            command: description,
            exitCode,
            stdout: stdout.buffer,
            stderr: stderr.buffer,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            ...(options?.outputFile === undefined
              ? {}
              : {
                  outputPath: options.outputFile,
                  outputBytes: stdout.bytes,
                  outputFileTruncated: stdout.fileTruncated,
                }),
          } satisfies RunResult
        }),
      )
      const timed = options?.timeout
        ? Effect.timeoutOrElse(collect, {
            duration: options.timeout,
            orElse: () => Effect.fail(new AppProcessError({ command: description, cause: new Error("Timed out") })),
          })
        : collect
      const aborted = options?.signal
        ? timed.pipe(
            Effect.raceFirst(
              waitForAbort(options.signal).pipe(Effect.mapError((cause) => wrapError(description, cause))),
            ),
          )
        : timed
      return aborted.pipe(Effect.catch((cause) => Effect.fail(wrapError(description, cause))))
    }

    const run = Effect.fn("AppProcess.run")(function* (command: ChildProcess.Command, options?: RunOptions) {
      if (options?.stdin === undefined) return yield* runCommand(command, options)
      if (command._tag !== "StandardCommand") {
        return yield* new AppProcessError({
          command: describeCommand(command),
          cause: new Error("stdin option only supports StandardCommand; received PipedCommand"),
        })
      }
      const next = ChildProcess.make(command.command, command.args, {
        ...command.options,
        stdin: normalizeStdin(options.stdin),
      })
      return yield* runCommand(next, options)
    })

    const runStream = (
      command: ChildProcess.Command,
      options?: RunStreamOptions,
    ): Stream.Stream<string, AppProcessError> => {
      const description = describeCommand(command)
      const okExitCodes = options?.okExitCodes
      const built: Stream.Stream<string, AppProcessError | PlatformError> = Stream.unwrap(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(command)
          const stderrFiber = yield* Effect.forkScoped(
            collectStream(handle.stderr, options?.maxErrorBytes).pipe(Effect.map((x) => decodeOutput(x.buffer))),
          )
          const source = options?.includeStderr === true ? handle.all : handle.stdout
          const lines = source.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
          )
          const tail = Stream.unwrap(
            Effect.gen(function* () {
              const code = yield* handle.exitCode
              if (okExitCodes && okExitCodes.length > 0 && !okExitCodes.includes(code)) {
                const stderr = yield* Fiber.join(stderrFiber)
                return Stream.fail(new AppProcessError({ command: description, exitCode: code, stderr }))
              }
              return Stream.empty
            }),
          )
          return Stream.concat(lines, tail) as Stream.Stream<string, AppProcessError | PlatformError>
        }),
      )
      const mapped = built.pipe(
        Stream.catch((cause): Stream.Stream<string, AppProcessError> => Stream.fail(wrapError(description, cause))),
      )
      if (!options?.signal) return mapped
      const signal = options.signal
      return mapped.pipe(
        Stream.interruptWhen(waitForAbort(signal).pipe(Effect.mapError((cause) => wrapError(description, cause)))),
      )
    }

    return Service.of({ ...spawner, run, runStream })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [CrossSpawnSpawner.node] })

export * as AppProcess from "./process"
