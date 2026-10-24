import { expect, test } from "bun:test"
import { OpenCode } from "@miao/client"
import { retryPromptSend } from "../src/context/prompt-send"

test("slow native preparation and admission have independent receipt deadlines", async () => {
  const calls: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 30, async fetch(request) {
    const path = new URL(request.url).pathname
    calls.push(path)
    await Bun.sleep(path === "/prepare" ? 50 : 10_100)
    return new Response("received")
  } })
  let preparation: AbortSignal | undefined
  try {
    const result = await retryPromptSend({
      prepare: async (signal) => {
        preparation = signal
        await fetch(new URL("prepare", server.url), { signal })
      },
      send: async (signal) => {
        expect(signal).not.toBe(preparation)
        return (await fetch(new URL("admit", server.url), { signal })).text()
      },
      received: () => false,
      retry: () => { throw new Error("A valid slow receipt must not retry") },
    })
    expect(result).toBe("received")
    expect(calls).toEqual(["/prepare", "/admit"])
  } finally { server.stop(true) }
}, 20_000)

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
