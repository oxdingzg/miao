import { describe, expect, test } from "bun:test"
import { SessionCacheProbe } from "@miao/core/session/cache-probe"

const request = {
  model: { provider: "fixture", id: "model" },
  tools: [{ name: "read", input: { type: "object" } }],
  system: ["private system"],
  messages: [{ role: "user", text: "private user message" }],
}

describe("SessionCacheProbe", () => {
  test("copies the last completed parent and matches only an exact child prefix", () => {
    const probe = SessionCacheProbe.make()
    probe.complete("parent", request, 2048)
    probe.fork("parent", "child")
    // Parent continuation after the fork must not move the captured target.
    probe.complete("parent", { ...request, system: ["new parent rules"] }, 4096)
    const observation = probe.consume("child", {
      ...request,
      messages: [...request.messages, { role: "assistant", text: "answer" }, { role: "user", text: "follow up" }],
    })
    expect(observation).toMatchObject({
      state: "prefix-match",
      parentInputTokens: 2048,
      toolsMatch: true,
      systemMatches: true,
      historyMatches: true,
      serverCacheState: "unknown",
    })
    expect(JSON.stringify(observation)).not.toContain("private")
    expect(probe.consume("child", request)).toBeUndefined()
  })

  test("rejects tool, system, model, historical cursor and rewritten-history changes independently", () => {
    for (const changed of [
      { ...request, tools: [] },
      { ...request, system: ["other"] },
      { ...request, model: { provider: "other", id: "model" } },
      { ...request, messages: [] },
      { ...request, messages: [{ role: "user", text: "rewritten" }] },
    ]) {
      const probe = SessionCacheProbe.make()
      probe.complete("parent", request, 2048)
      probe.fork("parent", "child")
      expect(probe.consume("child", changed)?.state).toBe("prefix-changed")
    }
  })

  test("long-prefix equality remains exact beyond any sampled diagnostics window", () => {
    const probe = SessionCacheProbe.make()
    const long = {
      ...request,
      messages: Array.from({ length: 300 }, (_, index) => ({ role: "user", text: `message-${index}` })),
    }
    probe.complete("parent", long, 12000)
    probe.fork("parent", "child")
    const rewritten = {
      ...long,
      messages: long.messages.map((item, index) => (index === 250 ? { ...item, text: "changed" } : item)),
    }
    expect(probe.consume("child", rewritten)).toMatchObject({ state: "prefix-changed", historyMatches: false })
  })

  test("context rewrite invalidation removes both completed and pending evidence", () => {
    const probe = SessionCacheProbe.make()
    probe.complete("parent", request, 2000)
    probe.fork("parent", "child")
    probe.invalidate("child")
    expect(probe.consume("child", request)).toBeUndefined()
    probe.invalidate("parent")
    probe.fork("parent", "next-child")
    expect(probe.consume("next-child", request)?.state).toBe("unavailable")
  })

  test("restart, capacity eviction and missing usage remain explicitly unknown", () => {
    const probe = SessionCacheProbe.make(1)
    probe.complete("parent", request, 0)
    probe.fork("parent", "child")
    expect(probe.consume("child", request)).toMatchObject({ state: "prefix-match", parentInputTokens: null })
    probe.complete("other", request, null)
    probe.fork("parent", "evicted")
    expect(probe.consume("evicted", request)?.state).toBe("unavailable")
    const restarted = SessionCacheProbe.make()
    restarted.fork("parent", "child")
    expect(restarted.consume("child", request)?.state).toBe("unavailable")
  })
})
