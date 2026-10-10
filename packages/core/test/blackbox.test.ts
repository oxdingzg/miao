import { expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Effect, Exit, Cause, Stream, Deferred, Fiber } from "effect"
import { LLM, LLMError, LLMEvent, Model, TransportReason } from "@miao/llm"
import { OpenAIChat } from "@miao/llm/protocols"
import { BlackboxTape } from "@miao/core/blackbox/tape"
import { BlackboxCompare } from "@miao/core/blackbox/compare"
import { SessionBlackbox } from "@miao/core/session/blackbox"

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miao-blackbox-"))
  return { file: path.join(dir, "bundle.json"), [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) }
}
const model = Model.make({ id: "recorded-model", provider: "openai", route: OpenAIChat.route })
const request = LLM.request({ model, prompt: "hello", http: { headers: { authorization: "private-token" } } })
const events = [
  LLMEvent.textStart({ id: "text" }),
  LLMEvent.textDelta({ id: "text", text: "hello" }),
  LLMEvent.textEnd({ id: "text" }),
  LLMEvent.finish({ reason: "stop" }),
]

test("saves versioned private bundles, validates integrity, and rejects incomplete recordings", async () => {
  await using fixtureFile = await fixture()
  const recorder = new BlackboxTape.Recorder(fixtureFile.file, { engine: "typescript", fixture: "empty" })
  await recorder.begin("provider", { prompt: "hello" })
  const bundle = await BlackboxTape.load(fixtureFile.file)
  expect(bundle.interactions[0].outcome).toBe("incomplete")
  expect(() => new BlackboxTape.Replay(bundle).take("provider", { prompt: "hello" })).toThrow("Incomplete")
  if (process.platform !== "win32") expect((await stat(fixtureFile.file)).mode & 0o777).toBe(0o600)
  const envelope = await Bun.file(fixtureFile.file).json()
  envelope.bundle.metadata.engine = "tampered"
  await Bun.write(fixtureFile.file, JSON.stringify(envelope))
  await expect(BlackboxTape.load(fixtureFile.file)).rejects.toThrow("integrity")
})

test("incremental frames survive a crash without rewriting the Session snapshot", async () => {
  await using file = await fixture()
  const recorder = new BlackboxTape.Recorder(file.file, { fixture: "incremental" })
  const ticket = await recorder.begin("llm", { prompt: "hello" })
  const before = await Bun.file(file.file).text()
  await ticket.frame({ type: "text-delta", text: "partial" })
  await ticket.frame({ type: "tool-input-delta", text: '{"path":' })
  expect(await Bun.file(file.file).text()).toBe(before)
  const recovered = await BlackboxTape.load(file.file)
  expect(recovered.interactions[0].outcome).toBe("incomplete")
  expect(recovered.interactions[0].frames.map((frame) => frame.value)).toEqual([
    { type: "text-delta", text: "partial" },
    { type: "tool-input-delta", text: '{"path":' },
  ])
  expect(() => new BlackboxTape.Replay(recovered).take("llm", { prompt: "hello" })).toThrow("Incomplete")
  if (process.platform !== "win32") expect((await stat(`${file.file}.journal`)).mode & 0o777).toBe(0o600)
  await ticket.finish("cancelled")
  const settled = await BlackboxTape.load(file.file)
  await rm(`${file.file}.journal`)
  expect(await BlackboxTape.load(file.file)).toEqual(settled)
})

test("journal recovery ignores a torn final append and rejects corrupted or missing records", async () => {
  await using file = await fixture()
  const recorder = new BlackboxTape.Recorder(file.file, {})
  const ticket = await recorder.begin("llm", { prompt: "hello" })
  await ticket.frame({ text: "one" })
  await ticket.frame({ text: "two" })
  const journal = await Bun.file(`${file.file}.journal`).text()
  await Bun.write(`${file.file}.journal`, journal + '{"previous":')
  expect((await BlackboxTape.load(file.file)).interactions[0].frames).toHaveLength(2)
  await Bun.write(`${file.file}.journal`, journal.replace('"one"', '"changed"'))
  await expect(BlackboxTape.load(file.file)).rejects.toThrow("integrity")
  const lines = journal.trimEnd().split("\n")
  await Bun.write(`${file.file}.journal`, [lines[0], lines[1], lines[3]].join("\n") + "\n")
  await expect(BlackboxTape.load(file.file)).rejects.toThrow("integrity")
})

test("validates requests before delivering results, poisons mismatched replay, and checks unconsumed input", async () => {
  await using file = await fixture()
  const recorder = new BlackboxTape.Recorder(file.file, {})
  await BlackboxTape.recordCall(recorder, "tool", { name: "write", input: { path: "a", text: "one" } }, async () => ({
    ok: true,
  }))
  const bundle = await BlackboxTape.load(file.file)
  const replay = new BlackboxTape.Replay(bundle)
  expect(() => replay.assertConsumed()).toThrow("Unconsumed")
  await expect(replay.call("tool", { name: "write", input: { path: "a", text: "two" } })).rejects.toThrow("mismatch")
  await expect(replay.call("tool", bundle.interactions[0].request)).rejects.toThrow("mismatch")
  const exact = new BlackboxTape.Replay(bundle)
  expect(await exact.call("tool", { input: { text: "one", path: "a" }, name: "write" })).toEqual({ ok: true })
  exact.assertConsumed()
})

test("records and replays the runner provider and tool boundaries without executing live callbacks", async () => {
  await using file = await fixture()
  const recorder = new BlackboxTape.Recorder(file.file, {})
  let providerCalls = 0
  let toolCalls = 0
  const run = () =>
    Effect.gen(function* () {
      const output = yield* SessionBlackbox.stream("ses_record", request, () => {
        providerCalls++
        return Stream.fromIterable(events)
      }).pipe(Stream.runCollect)
      const tool = yield* SessionBlackbox.tool(
        "ses_record",
        "write",
        { path: "a", text: "one" },
        Effect.sync(() => {
          toolCalls++
          return { result: { type: "text" as const, value: "written" } }
        }),
      )
      return { output, tool }
    })
  const recorded = await Effect.runPromise(
    run().pipe(Effect.provideService(SessionBlackbox.Current, { get: async () => recorder })),
  )
  const bundle = await BlackboxTape.load(file.file)
  expect(await Bun.file(file.file).text()).not.toContain("private-token")
  const replay = new BlackboxTape.Replay(bundle)
  const replayed = await Effect.runPromise(
    run().pipe(Effect.provideService(SessionBlackbox.Current, { get: async () => replay })),
  )
  expect(replayed).toEqual(recorded)
  expect(providerCalls).toBe(1)
  expect(toolCalls).toBe(1)
  replay.assertConsumed()
})

test("partial provider output and retryable transport classification survive replay without secrets", async () => {
  await using file = await fixture()
  const recorder = new BlackboxTape.Recorder(file.file, {})
  const broken = Stream.concat(
    Stream.fromIterable(events.slice(0, 2)),
    Stream.fail(
      new LLMError({
        module: "test",
        method: "stream",
        reason: new TransportReason({
          kind: "stream-read",
          message: "private-error-token",
          url: "https://private/?key=secret",
        }),
      }),
    ),
  )
  const capture = await Effect.runPromise(
    SessionBlackbox.stream("ses_partial", request, () => broken).pipe(
      Stream.runCollect,
      Effect.exit,
      Effect.provideService(SessionBlackbox.Current, { get: async () => recorder }),
    ),
  )
  expect(Exit.isFailure(capture)).toBe(true)
  const bundle = await BlackboxTape.load(file.file)
  expect(bundle.interactions[0].frames).toHaveLength(2)
  expect(await Bun.file(file.file).text()).not.toContain("private-error-token")
  expect(await Bun.file(file.file).text()).not.toContain("key=secret")
  const replay = new BlackboxTape.Replay(bundle)
  const observed: LLMEvent[] = []
  const result = await Effect.runPromise(
    SessionBlackbox.stream("ses_partial", request, () => Stream.die("must not run")).pipe(
      Stream.tap((event) =>
        Effect.sync(() => {
          observed.push(event)
        }),
      ),
      Stream.runDrain,
      Effect.exit,
      Effect.provideService(SessionBlackbox.Current, { get: async () => replay }),
    ),
  )
  expect(observed).toEqual(events.slice(0, 2))
  if (!Exit.isFailure(result)) throw new Error("Expected replay failure")
  const error = Cause.squash(result.cause)
  expect(error).toBeInstanceOf(LLMError)
  expect(error instanceof LLMError && error.retryable).toBe(true)
  replay.assertConsumed()
})

test("reports the first changed context/tool value and ignores only object-key order and performance timing", async () => {
  await using file = await fixture()
  const recorder = new BlackboxTape.Recorder(file.file, {})
  await BlackboxTape.recordCall(recorder, "tool", { name: "read", input: { path: "a" } }, async () => ({ text: "one" }))
  const bundle = await BlackboxTape.load(file.file)
  expect(
    BlackboxCompare.compare(bundle, {
      ...bundle,
      interactions: bundle.interactions.map((item) => ({
        ...item,
        frames: item.frames.map((frame) => ({ ...frame, elapsedMs: 999 })),
      })),
    }),
  ).toMatchObject({ equal: true })
  const changed = {
    ...bundle,
    interactions: bundle.interactions.map((item) => ({ ...item, request: { name: "read", input: { path: "b" } } })),
  }
  expect(BlackboxCompare.compare(bundle, changed)).toEqual({
    equal: false,
    channel: "interaction",
    lane: "tool",
    ordinal: 0,
    difference: { path: "$.request.input.path", expected: "a", actual: "b" },
  })
})

test("independent Session trace interleaving preserves causal equality, while missing/changed states are detected", () => {
  const bundle: BlackboxTape.Bundle = {
    format: "miao-blackbox",
    version: 1,
    metadata: {},
    interactions: [],
    trace: [
      { session: "a", kind: "input.promoted", data: { text: "a" }, recordedAtMs: 0 },
      { session: "b", kind: "input.promoted", data: { text: "b" }, recordedAtMs: null },
      { session: "a", kind: "run.finished", data: {}, recordedAtMs: 10 },
    ],
  }
  expect(
    BlackboxCompare.compare(bundle, { ...bundle, trace: [bundle.trace[1], bundle.trace[0], bundle.trace[2]] }),
  ).toMatchObject({ equal: true })
  expect(BlackboxCompare.compare(bundle, { ...bundle, trace: bundle.trace.slice(0, 2) })).toMatchObject({
    equal: false,
    channel: "trace",
    lane: "a",
    ordinal: 1,
  })
  const replay = new BlackboxTape.Replay(bundle)
  replay.expectTrace("a", "input.promoted", { text: "a" })
  expect(() => replay.assertConsumed()).toThrow("trace")
})

test("interrupted tools persist cancellation and replay interruption without entering the executor", async () => {
  await using file = await fixture()
  const recorder = new BlackboxTape.Recorder(file.file, {})
  const interrupted = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const fiber = yield* SessionBlackbox.tool(
        "ses_cancel",
        "wait",
        {},
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      return yield* Fiber.await(fiber)
    }).pipe(Effect.provideService(SessionBlackbox.Current, { get: async () => recorder })),
  )
  expect(Exit.isFailure(interrupted)).toBe(true)
  const bundle = await BlackboxTape.load(file.file)
  expect(bundle.interactions[0].outcome).toBe("cancelled")
  const replay = new BlackboxTape.Replay(bundle)
  const result = await Effect.runPromise(
    SessionBlackbox.tool("ses_cancel", "wait", {}, Effect.die("must not run")).pipe(
      Effect.exit,
      Effect.provideService(SessionBlackbox.Current, { get: async () => replay }),
    ),
  )
  if (!Exit.isFailure(result)) throw new Error("Expected interruption")
  expect(Cause.hasInterruptsOnly(result.cause)).toBe(true)
  replay.assertConsumed()
})
