import { expect, test } from "bun:test"
import { OpenCode } from "@miao/client"
import { retryPromptSend } from "../src/context/prompt-send"

test("a slow preparation and admission wait for their receipts without a deadline", async () => {
  const calls: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    calls.push(path)
    await Bun.sleep(path === "/prepare" ? 50 : 400)
    return new Response("received")
  } })
  const shutdown = new AbortController()
  const signals: (AbortSignal | undefined)[] = []
  try {
    const result = await retryPromptSend({
      signal: shutdown.signal,
      prepare: async (signal) => {
        signals.push(signal)
        await fetch(new URL("prepare", server.url), { signal })
      },
      send: async (signal) => {
        signals.push(signal)
        return (await fetch(new URL("admit", server.url), { signal })).text()
      },
      received: () => false,
      retry: () => { throw new Error("A slow but valid receipt must not retry") },
    })
    expect(result).toBe("received")
    expect(calls).toEqual(["/prepare", "/admit"])
    // Both phases share the shutdown signal; neither gets a timeout signal.
    expect(signals).toEqual([shutdown.signal, shutdown.signal])
    expect(shutdown.signal.aborted).toBe(false)
  } finally { server.stop(true) }
})

test("a lost HTTP receipt retries the exact same durable prompt identity", async () => {
  const ids: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json()
    ids.push(body.id)
    if (ids.length === 1) return Response.error()
    return Response.json({ data: { id: body.id } })
  } })
  let retries = 0
  try {
    const api = OpenCode.make({ baseUrl: server.url.toString() })
    await retryPromptSend({
      send: (signal) => api.sessions.prompt({ sessionID: "ses_receipt", id: "msg_receipt", prompt: { text: "Continue" } }, { signal }),
      received: () => false,
      retry: () => { retries++ },
    })
    expect(retries).toBe(1)
    expect(ids).toEqual(["msg_receipt", "msg_receipt"])
  } finally { server.stop(true) }
})

test("an event receipt during preparation prevents another admission", async () => {
  let received = false
  let sends = 0
  await retryPromptSend({
    prepare: async () => { received = true },
    send: async () => { sends++; return "unexpected" },
    received: () => received,
    retry: () => {},
  })
  expect(sends).toBe(0)
})

test("shutdown aborts an in-flight admission without retrying or failing it", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    await Bun.sleep(10_000)
    return new Response("late")
  } })
  const shutdown = new AbortController()
  let retries = 0
  try {
    const task = retryPromptSend({
      signal: shutdown.signal,
      send: async (signal) => (await fetch(server.url, { signal })).text(),
      received: () => false,
      retry: () => { retries++ },
    })
    await Bun.sleep(50)
    shutdown.abort()
    expect(await task).toBeUndefined()
    expect(retries).toBe(0)
  } finally { server.stop(true) }
})
