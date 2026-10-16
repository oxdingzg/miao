import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { startBudgetProxy } from "../../src/engine/eval-budget"

test("evaluation budget caps concurrent provider attempts and does not journal credentials or bodies", async () => {
  await using tmp = await tmpdir()
  let calls = 0
  const authorization: Array<string | null> = []
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls += 1
      authorization.push(request.headers.get("authorization"))
      expect(await request.text()).toBe("private-prompt-marker")
      return new Response("data: done\n\n", { headers: { "content-type": "text/event-stream" } })
    },
  })
  const ledger = path.join(tmp.path, "budget.jsonl")
  try {
    await using proxy = startBudgetProxy({
      upstream: new URL("/stream?private-target-marker", provider.url).toString(),
      limit: 3,
      ledger,
    })
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(proxy.endpoint, {
          method: "POST",
          headers: { authorization: "Bearer private-token-marker" },
          body: "private-prompt-marker",
        }),
      ),
    )
    expect(responses.filter((response) => response.status === 200)).toHaveLength(3)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(5)
    await Promise.all(responses.map((response) => response.text()))
    expect(calls).toBe(3)
    expect(authorization).toEqual(Array(3).fill("Bearer private-token-marker"))
    expect(proxy.stats()).toEqual({ limit: 3, forwarded: 3, remaining: 0, rejected: 5 })
    const journal = await Bun.file(ledger).text()
    for (const marker of ["private-token-marker", "private-target-marker", "private-prompt-marker"])
      expect(journal).not.toContain(marker)
  } finally {
    provider.stop(true)
  }
})

test("restarting an evaluation proxy retains spent retries and refuses a second budget owner", async () => {
  await using tmp = await tmpdir()
  let calls = 0
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls += 1
      return new Response("retry", { status: 503 })
    },
  })
  const ledger = path.join(tmp.path, "budget.jsonl")
  try {
    {
      await using proxy = startBudgetProxy({ upstream: provider.url.toString(), limit: 2, ledger })
      expect((await fetch(proxy.endpoint, { method: "POST" })).status).toBe(503)
      expect(proxy.stats().remaining).toBe(1)
      expect(() => startBudgetProxy({ upstream: provider.url.toString(), limit: 2, ledger })).toThrow()
    }
    await using proxy = startBudgetProxy({ upstream: provider.url.toString(), limit: 2, ledger })
    expect(proxy.stats().forwarded).toBe(1)
    expect((await fetch(proxy.endpoint, { method: "POST" })).status).toBe(503)
    expect((await fetch(proxy.endpoint, { method: "POST" })).status).toBe(429)
    expect(calls).toBe(2)
  } finally {
    provider.stop(true)
  }
})

test("an invalid or rebound budget ledger fails closed without an upstream call", async () => {
  await using tmp = await tmpdir()
  let calls = 0
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls += 1
      return new Response("unexpected")
    },
  })
  const ledger = path.join(tmp.path, "budget.jsonl")
  try {
    {
      await using proxy = startBudgetProxy({ upstream: provider.url.toString(), limit: 24, ledger })
    }
    expect(() => startBudgetProxy({ upstream: provider.url.toString(), limit: 25, ledger })).toThrow("does not match")
    expect(() =>
      startBudgetProxy({ upstream: new URL("/different", provider.url).toString(), limit: 24, ledger }),
    ).toThrow("does not match")
    await Bun.write(ledger, "{truncated\n")
    expect(() => startBudgetProxy({ upstream: provider.url.toString(), limit: 24, ledger })).toThrow()
    expect(calls).toBe(0)
  } finally {
    provider.stop(true)
  }
})
