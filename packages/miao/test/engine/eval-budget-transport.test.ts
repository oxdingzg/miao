import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { startBudgetProxy } from "../../src/engine/eval-budget"

test("a failed upstream connection consumes a slot and records only a safe error code", async () => {
  await using tmp = await tmpdir()
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") })
  const target = upstream.url.toString()
  await upstream.stop(true)
  const ledger = path.join(tmp.path, "budget.jsonl")
  await using proxy = startBudgetProxy({ upstream: target, limit: 1, ledger })
  const response = await fetch(proxy.endpoint, {
    method: "POST",
    body: "private-body",
    headers: { authorization: "Bearer private-key" },
  })
  expect(response.status).toBe(502)
  expect(await response.text()).toBe("evaluation upstream transport failed")
  expect(proxy.stats()).toMatchObject({ forwarded: 1, remaining: 0 })
  expect((await fetch(proxy.endpoint, { method: "POST" })).status).toBe(429)
  const lines = (await Bun.file(ledger).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(lines[2]).toMatchObject({ type: "response", ordinal: 1, status: 0 })
  expect(lines[2].errorCode).toMatch(/^[A-Za-z0-9_]{1,64}$/)
  expect(await Bun.file(ledger).text()).not.toContain("private-key")
  expect(await Bun.file(ledger).text()).not.toContain("private-body")
})
