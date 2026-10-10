import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Effect, Stream } from "effect"
import { LLM, LLMError, LLMEvent, Model, TransportReason } from "@miao/llm"
import { OpenAIChat } from "@miao/llm/protocols"
import { BlackboxTape } from "@miao/core/blackbox/tape"
import { SessionBlackbox } from "@miao/core/session/blackbox"

test("blackbox records each retry attempt while preserving one live stream factory per provider turn", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-blackbox-retry-"))
  try {
    const recorder = new BlackboxTape.Recorder(path.join(directory, "bundle.json"), {})
    const request = LLM.request({
      model: Model.make({ id: "test", provider: "openai", route: OpenAIChat.route }),
      prompt: "retry",
    })
    let factories = 0
    let attempts = 0
    const expected = [LLMEvent.finish({ reason: "stop" })]
    const live = () => {
      factories++
      return Stream.suspend(() =>
        attempts++ === 0
          ? Stream.fail(
              new LLMError({
                module: "test",
                method: "stream",
                reason: new TransportReason({ message: "failed", kind: "connection-closed" }),
              }),
            )
          : Stream.fromIterable(expected),
      )
    }
    const recorded = await Effect.runPromise(
      SessionBlackbox.stream("ses_retry", request, live).pipe(
        Stream.runCollect,
        Effect.retry({ times: 1 }),
        Effect.provideService(SessionBlackbox.Current, { get: async () => recorder }),
      ),
    )
    expect(recorded).toEqual(expected)
    expect(factories).toBe(1)
    expect(attempts).toBe(2)
    const bundle = await BlackboxTape.load(recorder.file)
    expect(bundle.interactions.map((item) => item.outcome)).toEqual(["error", "complete"])
    const replay = new BlackboxTape.Replay(bundle)
    const output = await Effect.runPromise(
      SessionBlackbox.stream("ses_retry", request, () => Stream.die("must not run")).pipe(
        Stream.runCollect,
        Effect.retry({ times: 1 }),
        Effect.provideService(SessionBlackbox.Current, { get: async () => replay }),
      ),
    )
    expect(output).toEqual(expected)
    replay.assertConsumed()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
