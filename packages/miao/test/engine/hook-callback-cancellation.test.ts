import { expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { EngineClient } from "@/engine/client"
import { tmpdir } from "../fixture/fixture"
import { engineFake } from "../fixture/engine-binary"

const fake = engineFake
const frame = (session = "s", bridge = 11) => ({
  method: "hook_tool",
  bridge_id: bridge,
  params: {
    session_id: session,
    kind: "before",
    tool: "blocked",
    call_id: `call-${bridge}`,
    message_seq: 3,
    input: {},
  },
})
const notice = (session = "s", bridge = 11) => ({
  method: "hook_tool.cancel",
  bridge_id: bridge,
  params: { session_id: session, bridge_id: bridge },
})

async function settled(promise: Promise<void>) {
  return Promise.race([promise.then(() => true), Bun.sleep(2_000).then(() => false)])
}

for (const boundary of ["cancel", "exit", "close"] as const)
  test(`hook callback Effect is interrupted on ${boundary}`, async () => {
    await using tmp = await tmpdir()
    const cleanup = new AbortController()
    const started = Promise.withResolvers<void>()
    const interrupted = Promise.withResolvers<void>()
    const client = EngineClient.start({
      binary: fake,
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      model: "fixture",
      ephemeral: true,
      onHookTool: (call) =>
        Effect.runPromise(
          Effect.sync(() => started.resolve()).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => interrupted.resolve())),
          ),
          { signal: call.signal ? AbortSignal.any([call.signal, cleanup.signal]) : cleanup.signal },
        ),
    })
    let observed = false
    try {
      await client.request("fixture_frames", { frames: [frame()] })
      expect(await settled(started.promise)).toBe(true)
      if (boundary === "cancel") await client.request("fixture_frames", { frames: [notice()] })
      if (boundary === "exit") await client.request("fixture_exit").catch(() => undefined)
      if (boundary === "close") await client.close()
      observed = await settled(interrupted.promise)
    } finally {
      cleanup.abort()
      await client.close()
    }
    expect(observed).toBe(true)
  }, 10_000)

test("a cancel notice cannot interrupt another Session's callback", async () => {
  await using tmp = await tmpdir()
  const cleanup = new AbortController()
  const started = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  const client = EngineClient.start({
    binary: fake,
    db: path.join(tmp.path, "engine.db"),
    workspace: tmp.path,
    model: "fixture",
    ephemeral: true,
    onHookTool: (call) => {
      signal = call.signal
      started.resolve()
      return Effect.runPromise(Effect.never, {
        signal: call.signal ? AbortSignal.any([call.signal, cleanup.signal]) : cleanup.signal,
      })
    },
  })
  try {
    await client.request("fixture_frames", { frames: [frame("owner")] })
    expect(await settled(started.promise)).toBe(true)
    await client.request("fixture_frames", { frames: [notice("foreign"), notice("owner", 999)] })
    expect(signal?.aborted).toBe(false)
    await client.request("fixture_frames", { frames: [notice("owner")] })
    expect(signal?.aborted).toBe(true)
  } finally {
    cleanup.abort()
    await client.close()
  }
}, 10_000)

test("a noncooperative callback's late result is not sent after cancellation", async () => {
  await using tmp = await tmpdir()
  const replies = path.join(tmp.path, "bridge.jsonl")
  const started = Promise.withResolvers<void>()
  const completion = Promise.withResolvers<unknown>()
  const client = EngineClient.start({
    binary: fake,
    db: path.join(tmp.path, "engine.db"),
    workspace: tmp.path,
    model: "fixture",
    ephemeral: true,
    env: { ENGINE_FAKE_BRIDGE_LOG: replies },
    onHookTool: () => {
      started.resolve()
      return completion.promise
    },
  })
  try {
    await client.request("fixture_frames", { frames: [frame()] })
    expect(await settled(started.promise)).toBe(true)
    await client.request("fixture_frames", { frames: [notice()] })
    completion.resolve({ late: true })
    // Two actual wire round trips order the callback microtask and any stdin
    // reply before reading the peer's receipt, without a timing-based sleep.
    await client.request("fixture_barrier")
    await client.request("fixture_barrier")
    expect(
      await Bun.file(replies)
        .text()
        .catch(() => ""),
    ).toBe("")
  } finally {
    completion.resolve({ cleanup: true })
    await client.close()
  }
}, 10_000)
