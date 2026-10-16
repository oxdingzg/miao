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

test("budget disposal aborts terminal-but-open upstream SSE and releases the ledger lock", async () => {
  await using tmp = await tmpdir()
  const sockets = new Set<Bun.Socket<undefined>>()
  const answered = new WeakSet<Bun.Socket<undefined>>()
  const upstream = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        sockets.add(socket)
      },
      data(socket) {
        if (answered.has(socket)) return
        answered.add(socket)
        socket.write(
          'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {"type":"response.completed"}\n\n',
        )
        // Keep the TCP connection open after the terminal event.
      },
      close(socket) {
        sockets.delete(socket)
      },
      error() {},
    },
  })
  const target = `http://127.0.0.1:${upstream.port}/stream`
  const ledger = path.join(tmp.path, "budget.jsonl")
  const proxy = startBudgetProxy({ upstream: target, limit: 2, ledger })
  try {
    const response = await fetch(proxy.endpoint, { method: "POST", body: "fixture" })
    const reader = response.body?.getReader()
    if (!reader) throw new Error("missing provider stream")
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("response.completed")
    const closing = proxy[Symbol.asyncDispose]()
    expect(await Promise.race([closing.then(() => true), Bun.sleep(1500).then(() => false)])).toBe(true)
    for (let attempt = 0; attempt < 100 && sockets.size; attempt++) await Bun.sleep(5)
    expect(sockets.size).toBe(0)
    await using resumed = startBudgetProxy({ upstream: target, limit: 2, ledger })
    expect(resumed.stats()).toMatchObject({ forwarded: 1, remaining: 1 })
  } finally {
    for (const socket of sockets) socket.end()
    upstream.stop(true)
    await proxy[Symbol.asyncDispose]()
  }
})
