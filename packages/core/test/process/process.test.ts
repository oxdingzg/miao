import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Duration, Effect, Exit, Fiber, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { LayerNode } from "@miao/core/effect/layer-node"
import { AppProcess } from "@miao/core/process"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(AppProcess.node))

const NODE = process.execPath
const cmd = (...args: string[]) => ChildProcess.make(NODE, args)

const waitForFile = (file: string) =>
  Effect.promise(async () => {
    while (true) {
      const content = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return undefined
      })
      // The output file can exist but still be empty between create and the
      // first write, so wait for the first non-empty read rather than existence.
      if (content) return content
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
  })

describe("AppProcess", () => {
  describe("run", () => {
    it.effect(
      "captures stdout and exit code zero",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.stdout.write('hi\\n')"))
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("hi\n")
        expect(result.stdoutTruncated).toBe(false)
        expect(result.stderrTruncated).toBe(false)
      }),
    )

    it.effect(
      "captures both streams and preserves each stream's emission order",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const script = [
          'process.stdout.write("out 1\\n")',
          'process.stderr.write("err 1\\n")',
          'process.stdout.write("out 2\\n")',
          'process.stderr.write("err 2\\n")',
        ].join(";")
        const result = yield* svc.run(cmd("-e", script), { combineOutput: true })
        // Separate OS pipes preserve their own order, not a shared wall clock.
        const lines = result.output?.toString("utf8").trim().split("\n") ?? []
        expect(lines).toHaveLength(4)
        expect(lines.filter((line) => line.startsWith("out"))).toEqual(["out 1", "out 2"])
        expect(lines.filter((line) => line.startsWith("err"))).toEqual(["err 1", "err 2"])
        expect(result.stdout.toString("utf8")).toBe("")
        expect(result.stderr.toString("utf8")).toBe("")
      }),
    )

    it.effect(
      "non-zero exit returns RunResult; caller can require success",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.exit(1)"))
        expect(result.exitCode).toBe(1)
      }),
    )

    it.effect(
      "requireSuccess fails on non-zero exit",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const exit = yield* Effect.exit(
          svc.run(cmd("-e", "process.exit(1)")).pipe(Effect.flatMap(AppProcess.requireSuccess)),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons[0]
          if (reason && reason._tag === "Fail") {
            expect(reason.error).toBeInstanceOf(AppProcess.AppProcessError)
            expect((reason.error as AppProcess.AppProcessError).exitCode).toBe(1)
            expect((reason.error as AppProcess.AppProcessError).message).toContain("Command failed (exit 1)")
          } else {
            throw new Error("expected fail reason")
          }
        }
      }),
    )

    it.effect(
      "requireSuccess succeeds on exit 0",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.exit(0)")).pipe(Effect.flatMap(AppProcess.requireSuccess))
        expect(result.exitCode).toBe(0)
      }),
    )

    it.effect(
      "requireExitIn allowlists multiple exit codes",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const requireZeroOrOne = AppProcess.requireExitIn([0, 1])
        const okZero = yield* svc.run(cmd("-e", "process.exit(0)")).pipe(Effect.flatMap(requireZeroOrOne))
        expect(okZero.exitCode).toBe(0)
        const okOne = yield* svc.run(cmd("-e", "process.exit(1)")).pipe(Effect.flatMap(requireZeroOrOne))
        expect(okOne.exitCode).toBe(1)
        const exit = yield* Effect.exit(svc.run(cmd("-e", "process.exit(2)")).pipe(Effect.flatMap(requireZeroOrOne)))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons[0]
          if (reason && reason._tag === "Fail") {
            expect(reason.error).toBeInstanceOf(AppProcess.AppProcessError)
            expect((reason.error as AppProcess.AppProcessError).exitCode).toBe(2)
          }
        }
      }),
    )

    it.effect(
      "truncates stdout when maxOutputBytes is set",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.stdout.write('0123456789')"), { maxOutputBytes: 5 })
        expect(result.exitCode).toBe(0)
        expect(result.stdoutTruncated).toBe(true)
        expect(result.stderrTruncated).toBe(false)
        expect(result.stdout.length).toBe(5)
        expect(result.stdout.toString("utf8")).toBe("01234")
      }),
    )

    it.effect(
      "truncates stderr when maxErrorBytes is set",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.stderr.write('0123456789')"), { maxErrorBytes: 5 })
        expect(result.exitCode).toBe(0)
        expect(result.stdoutTruncated).toBe(false)
        expect(result.stderrTruncated).toBe(true)
        expect(result.stderr.length).toBe(5)
        expect(result.stderr.toString("utf8")).toBe("01234")
      }),
    )

    it.effect(
      "result includes command description",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.stdout.write('hi')"))
        expect(result.command).toBe(`${NODE} -e process.stdout.write('hi')`)
      }),
    )

    if (process.platform !== "win32") {
      it.live(
        "timeout cleans up the scoped child process",
        Effect.acquireUseRelease(
          Effect.promise(() => fs.mkdtemp(path.join(tmpdir(), "opencode-process-timeout-"))),
          (directory) => {
            const ready = path.join(directory, "ready")
            const settled = path.join(directory, "settled")
            const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(settled)},'settled');process.exit(0)});setInterval(()=>{},60000)`
            return Effect.gen(function* () {
              const svc = yield* AppProcess.Service
              const exit = yield* Effect.exit(svc.run(cmd("-e", script), { timeout: "250 millis" }))
              expect(Exit.isFailure(exit)).toBe(true)
              expect(yield* waitForFile(ready)).toMatch(/^\d+$/)
              expect(yield* waitForFile(settled)).toBe("settled")
            })
          },
          (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
        ),
        5_000,
      )

      it.live(
        "fiber interruption cleans up the scoped child process after readiness",
        Effect.acquireUseRelease(
          Effect.promise(() => fs.mkdtemp(path.join(tmpdir(), "opencode-process-interrupt-"))),
          (directory) => {
            const ready = path.join(directory, "ready")
            const settled = path.join(directory, "settled")
            const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(settled)},'settled');process.exit(0)});setInterval(()=>{},60000)`
            return Effect.gen(function* () {
              const svc = yield* AppProcess.Service
              const fiber = yield* svc.run(cmd("-e", script)).pipe(Effect.forkChild)
              expect(yield* waitForFile(ready)).toMatch(/^\d+$/)
              yield* Fiber.interrupt(fiber)
              expect(yield* waitForFile(settled)).toBe("settled")
            })
          },
          (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
        ),
        5_000,
      )
    }

    // The cleanup tests above rely on a child handling SIGTERM, which Windows
    // does not deliver; tree cleanup there is checked by whether a descendant
    // gets to run. `start`-style detachment and direct descendants are both
    // covered because the descendant is started in a new console.
    if (process.platform === "win32") {
      const powershell = [
        process.env.SystemRoot
          ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
          : undefined,
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      ].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate))

      if (powershell) {
        // Starts a descendant that writes `marker` after `delaySeconds`; the
        // outer script then stays busy for `outerSeconds`. If the tree survives
        // the timeout/interruption the marker appears.
        const descendant = (marker: string, delaySeconds: number, outerSeconds: number) =>
          [
            `$p = Start-Process -PassThru -NoNewWindow -FilePath '${powershell.replaceAll("'", "''")}' -ArgumentList '-NoProfile','-Command',"Start-Sleep ${delaySeconds}; Set-Content -LiteralPath '$env:MIAO_TREE_MARKER' -Value alive"`,
            `Start-Sleep ${outerSeconds}`,
          ].join("; ")

        const runDescendant = (marker: string, script: string, timeout?: Duration.Input) => {
          const command = ChildProcess.make(powershell, ["-NoProfile", "-Command", script], {
            env: { MIAO_TREE_MARKER: marker },
            extendEnv: true,
            forceKillAfter: "3 seconds",
          })
          return Effect.gen(function* () {
            const svc = yield* AppProcess.Service
            return yield* Effect.exit(svc.run(command, timeout === undefined ? undefined : { timeout }))
          })
        }

        it.live(
          "the descendant marker harness runs when the command is not stopped",
          Effect.acquireUseRelease(
            Effect.promise(() => fs.mkdtemp(path.join(tmpdir(), "miao-process-tree-"))),
            (directory) => {
              const marker = path.join(directory, "alive")
              return Effect.gen(function* () {
                const exit = yield* runDescendant(marker, descendant(marker, 1, 3))
                expect(Exit.isSuccess(exit)).toBe(true)
                expect(existsSync(marker)).toBe(true)
              })
            },
            (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
          ),
          20_000,
        )

        it.live(
          "timeout cleans up the Windows process tree",
          Effect.acquireUseRelease(
            Effect.promise(() => fs.mkdtemp(path.join(tmpdir(), "miao-process-tree-"))),
            (directory) => {
              const marker = path.join(directory, "leak")
              return Effect.gen(function* () {
                const exit = yield* runDescendant(marker, descendant(marker, 4, 30), "1500 millis")
                expect(Exit.isFailure(exit)).toBe(true)
                yield* Effect.sleep("6 seconds")
                expect(existsSync(marker)).toBe(false)
              })
            },
            (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
          ),
          20_000,
        )

        it.live(
          "fiber interruption cleans up the Windows process tree",
          Effect.acquireUseRelease(
            Effect.promise(() => fs.mkdtemp(path.join(tmpdir(), "miao-process-tree-"))),
            (directory) => {
              const marker = path.join(directory, "leak")
              return Effect.gen(function* () {
                const svc = yield* AppProcess.Service
                const fiber = yield* svc
                  .run(
                    ChildProcess.make(powershell, ["-NoProfile", "-Command", descendant(marker, 4, 30)], {
                      env: { MIAO_TREE_MARKER: marker },
                      extendEnv: true,
                      forceKillAfter: "3 seconds",
                    }),
                  )
                  .pipe(Effect.forkChild)
                yield* Effect.sleep("1500 millis")
                yield* Fiber.interrupt(fiber)
                yield* Effect.sleep("6 seconds")
                expect(existsSync(marker)).toBe(false)
              })
            },
            (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
          ),
          20_000,
        )
      }
    }
  })

  describe("inherited platform methods", () => {
    it.effect(
      "string returns stdout as string",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const out = yield* svc.string(cmd("-e", "process.stdout.write('hi\\n')"))
        expect(out).toBe("hi\n")
      }),
    )

    it.effect(
      "lines returns the platform's array of lines",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const out = yield* svc.lines(cmd("-e", "process.stdout.write('a\\nb\\n')"))
        expect(Array.from(out)).toEqual(["a", "b"])
      }),
    )
  })

  describe("run with stdin option", () => {
    const echoStdin = "process.stdin.on('data', c => process.stdout.write(c))"

    it.effect(
      "feeds a string to stdin and returns it on stdout",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", echoStdin), { stdin: "hello" })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("hello")
      }),
    )

    it.effect(
      "feeds a Uint8Array to stdin",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const bytes = new TextEncoder().encode("bytes")
        const result = yield* svc.run(cmd("-e", echoStdin), { stdin: bytes })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("bytes")
      }),
    )

    it.effect(
      "feeds a Stream of Uint8Array chunks to stdin",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const enc = new TextEncoder()
        const stream = Stream.fromIterable([enc.encode("one"), enc.encode("-two"), enc.encode("-three")])
        const result = yield* svc.run(cmd("-e", echoStdin), { stdin: stream })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("one-two-three")
      }),
    )

    it.effect(
      "completes correctly with empty input",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", echoStdin), { stdin: "" })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("")
      }),
    )

    it.effect(
      "carries existing Command options like env",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const script =
          "process.stdout.write(process.env.FEED + ':'); process.stdin.on('data', c => process.stdout.write(c))"
        const command = ChildProcess.make(NODE, ["-e", script], { env: { FEED: "envset" }, extendEnv: true })
        const result = yield* svc.run(command, { stdin: "payload" })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("envset:payload")
      }),
    )

    it.effect(
      "carries existing Command options like cwd",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const dir = realpathSync(tmpdir())
        const script =
          "process.stdout.write(process.cwd() + '|'); process.stdin.on('data', c => process.stdout.write(c))"
        const command = ChildProcess.make(NODE, ["-e", script], { cwd: dir })
        const result = yield* svc.run(command, { stdin: "ok" })
        expect(result.exitCode).toBe(0)
        const [cwd, stdin] = result.stdout.toString("utf8").split("|")
        expect(realpathSync(cwd)).toBe(dir)
        expect(stdin).toBe("ok")
      }),
    )
  })

  describe("runStream", () => {
    it.live(
      "emits lines incrementally and ends cleanly on exit 0",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc
          .runStream(cmd("-e", "console.log('one'); console.log('two'); console.log('three')"))
          .pipe(Stream.runCollect)
        expect(Array.from(result)).toEqual(["one", "two", "three"])
      }),
    )

    it.live(
      "okExitCodes determines whether a non-zero exit fails the stream",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const allowed = yield* svc
          .runStream(cmd("-e", "console.log('only'); process.exit(1)"), { okExitCodes: [0, 1] })
          .pipe(Stream.runCollect)
        expect(Array.from(allowed)).toEqual(["only"])
        const exit = yield* Effect.exit(
          svc
            .runStream(cmd("-e", "console.log('a'); process.exit(2)"), { okExitCodes: [0, 1] })
            .pipe(Stream.runCollect),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons[0]
          if (reason && reason._tag === "Fail") {
            expect(reason.error).toBeInstanceOf(AppProcess.AppProcessError)
          }
        }
      }),
    )

    it.live(
      "without okExitCodes, never fails on exit code",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.runStream(cmd("-e", "console.log('only'); process.exit(7)")).pipe(Stream.runCollect)
        expect(Array.from(result)).toEqual(["only"])
      }),
    )

    it.live(
      "AbortSignal interrupts the stream",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const controller = new AbortController()
        controller.abort()
        const exit = yield* Effect.exit(
          svc
            .runStream(cmd("-e", "setInterval(() => {}, 60_000)"), { signal: controller.signal })
            .pipe(Stream.runCollect),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  describe("spawn (inherited)", () => {
    it.live(
      "returns the platform ChildProcessHandle for advanced use",
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* AppProcess.Service
          const handle = yield* svc.spawn(cmd("-e", "setInterval(() => {}, 1_000)"))
          expect(yield* handle.isRunning).toBe(true)
          yield* handle.kill()
        }),
      ),
    )
  })
})

describe("AppProcess.decodeBytes", () => {
  // Bytes captured from a Chinese Windows host (`96`, codepage 936) running
  // `cmd /c "dir C:\winenc /b"` for a file named `测试文件.txt`. UTF-8 decoding
  // produced the replacement-character mojibake the user reported.
  const gbkBytes = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xce, 0xc4, 0xbc, 0xfe, 0x2e, 0x74, 0x78, 0x74])

  test("decodes GBK shell output on the Windows branch", () => {
    expect(AppProcess.decodeBytes(gbkBytes, { windows: true })).toBe("测试文件.txt")
  })

  test("keeps already-UTF-8 output untouched on the Windows branch", () => {
    const utf8 = Buffer.from("测试文件.txt", "utf8")
    expect(AppProcess.decodeBytes(utf8, { windows: true })).toBe("测试文件.txt")
  })

  test("does not apply the code page off Windows", () => {
    expect(AppProcess.decodeBytes(gbkBytes, { windows: false })).not.toBe("测试文件.txt")
  })

  test("honors MIAO_WINDOWS_CODEPAGE", () => {
    const previous = process.env["MIAO_WINDOWS_CODEPAGE"]
    process.env["MIAO_WINDOWS_CODEPAGE"] = "gb18030"
    try {
      expect(AppProcess.decodeBytes(gbkBytes, { windows: true })).toBe("测试文件.txt")
    } finally {
      if (previous === undefined) delete process.env["MIAO_WINDOWS_CODEPAGE"]
      else process.env["MIAO_WINDOWS_CODEPAGE"] = previous
    }
  })
})

describe("AppProcess.run outputFile", () => {
  const script = (chunks: number, size: number) =>
    `(async()=>{for(let i=0;i<${chunks};i++){process.stdout.write("A".repeat(${size}));await new Promise((r)=>setTimeout(r,1))}})()`

  it.effect("streams the full output to a file while the in-memory preview stays bounded", () =>
    Effect.gen(function* () {
      const svc = yield* AppProcess.Service
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(tmpdir(), "appproc-")))
      const file = path.join(dir, "out.log")

      const result = yield* svc.run(cmd("-e", script(50, 100)), {
        combineOutput: true,
        maxOutputBytes: 256,
        outputFile: file,
        outputFileMaxBytes: 1_000_000,
      })

      expect(result.outputTruncated).toBe(true)
      expect(result.output?.length).toBe(256)
      expect(result.outputPath).toBe(file)
      expect(result.outputBytes).toBe(5_000)
      expect(result.outputFileTruncated).toBe(false)
      const written = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      expect(written.length).toBe(5_000)
    }),
  )

  it.effect("stops appending once the file cap is reached", () =>
    Effect.gen(function* () {
      const svc = yield* AppProcess.Service
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(tmpdir(), "appproc-")))
      const file = path.join(dir, "capped.log")

      const result = yield* svc.run(cmd("-e", script(50, 100)), {
        combineOutput: true,
        maxOutputBytes: 256,
        outputFile: file,
        outputFileMaxBytes: 1_000,
      })

      expect(result.outputFileTruncated).toBe(true)
      expect(result.outputBytes).toBe(5_000)
      const written = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      expect(written.length).toBe(1_000)
    }),
  )

  it.effect("keeps the file cap exact even when one chunk exceeds it", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => fs.mkdtemp(path.join(tmpdir(), "appproc-"))),
      (directory) =>
        Effect.gen(function* () {
          const svc = yield* AppProcess.Service
          const file = path.join(directory, "single-chunk.log")
          const result = yield* svc.run(cmd("-e", 'process.stdout.write("A".repeat(5000))'), {
            combineOutput: true,
            maxOutputBytes: 256,
            outputFile: file,
            outputFileMaxBytes: 999,
          })
          expect(result.outputFileTruncated).toBe(true)
          expect((yield* Effect.promise(() => fs.readFile(file))).length).toBe(999)
          const retry = yield* svc.run(cmd("-e", 'process.stdout.write("more")'), {
            combineOutput: true,
            outputFile: file,
            outputFileMaxBytes: 999,
          })
          expect(retry.outputFileTruncated).toBe(true)
          expect((yield* Effect.promise(() => fs.readFile(file))).length).toBe(999)
        }),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    ),
  )

  it.effect("writes output before the process exits", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => fs.mkdtemp(path.join(tmpdir(), "appproc-"))),
      (directory) =>
        Effect.scoped(
          Effect.gen(function* () {
            const svc = yield* AppProcess.Service
            const file = path.join(directory, "live.log")
            const release = path.join(directory, "release")
            const script =
              'process.stdout.write("started"); const timer=setInterval(()=>{if(require("fs").existsSync(process.argv[1])){clearInterval(timer);process.stdout.write(" finished")}},10)'
            const child = yield* svc
              .run(cmd("-e", script, release), {
                combineOutput: true,
                maxOutputBytes: 4,
                outputFile: file,
                timeout: "5 seconds",
              })
              .pipe(Effect.forkScoped)
            expect(yield* waitForFile(file).pipe(Effect.timeout("3 seconds"))).toBe("started")
            yield* Effect.promise(() => fs.writeFile(release, ""))
            const result = yield* Fiber.join(child)
            expect(result.output?.toString()).toBe("star")
            expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("started finished")
          }),
        ),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    ),
  )

  it.effect("reports failed file capture without failing the command", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => fs.mkdtemp(path.join(tmpdir(), "appproc-"))),
      (directory) =>
        Effect.gen(function* () {
          const svc = yield* AppProcess.Service
          const result = yield* svc.run(cmd("-e", 'process.stdout.write("ok")'), {
            combineOutput: true,
            outputFile: path.join(directory, "missing", "out.log"),
          })
          expect(result.exitCode).toBe(0)
          expect(result.output?.toString()).toBe("ok")
          expect(result.outputFileTruncated).toBe(true)
        }),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    ),
  )
})
