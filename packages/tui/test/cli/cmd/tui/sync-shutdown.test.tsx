/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait } from "./sync-fixture"

test("shutdown observes in-flight bootstrap cancellation and skips late bootstrap calls", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const state = { pending: false, started: false, reads: 0 }
  const mounted = await mount((url, request) => {
    state.reads++
    if (!state.pending || url.pathname !== "/api/location" || !request) return
    state.started = true
    return new Promise<Response>((_, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
    })
  }, tmp.path)
  try {
    state.pending = true
    const pending = mounted.sync.bootstrap()
    await wait(() => state.started)
    mounted.app.renderer.destroy()
    await pending
    // Give any unobserved Promise rejection a chance to reach Bun's test runner.
    await Bun.sleep(20)
    const reads = state.reads
    await mounted.sync.bootstrap()
    expect(state.reads).toBe(reads)
  } finally {
    mounted.app.renderer.destroy()
  }
})
