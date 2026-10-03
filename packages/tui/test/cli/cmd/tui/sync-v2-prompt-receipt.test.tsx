/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionMessage } from "@miao/sdk/v2"
import type { GlobalEvent } from "../../../../src/context/sdk"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

const sessionID = "ses_prompt_receipt"
const session = {
  id: sessionID,
  projectID: "proj_test",
  title: "prompt receipt",
  agent: "build",
  model: { id: "model", providerID: "test" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory },
}
const input = {
  sessionID,
  agent: "build",
  model: { providerID: "test", modelID: "model" },
  parts: [{ type: "text" as const, text: "还没完成吗？" }],
}

function payload(event: GlobalEvent["payload"]): GlobalEvent {
  return { directory, project: "proj_test", payload: event }
}

function mountReceipt(
  state: string,
  prompt: (request: Request) => Promise<Response> | Response,
  history: () => SessionMessage[] = () => [],
) {
  return mount((url, request) => {
    if (url.pathname === "/api/session") return json({ data: [session] })
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
    if (url.pathname === `/api/session/${sessionID}/context`) return json({ data: history() })
    if (url.pathname === `/api/session/${sessionID}/todo` || url.pathname === `/api/session/${sessionID}/diff`)
      return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/status`) return json({ data: { type: "busy" } })
    // Sending applies the footer's model and agent to the session first.
    if (url.pathname === `/api/session/${sessionID}/model` || url.pathname === `/api/session/${sessionID}/agent`)
      return new Response(null, { status: 204 })
    if (url.pathname === `/api/session/${sessionID}/prompt`) {
      if (!request) throw new Error("Expected SDK request")
      return prompt(request)
    }
    return undefined
  }, state)
}

test("submitted text appears synchronously even while HTTP admission and an existing tool are still pending", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const response = Promise.withResolvers<Response>()
  let body: unknown
  const history: SessionMessage[] = [
    {
      id: "msg_running_tool",
      type: "assistant",
      agent: "build",
      model: { id: "model", providerID: "test" },
      time: { created: 1 },
      content: [
        {
          id: "call_wait",
          type: "tool",
          name: "bash",
          time: { created: 1, ran: 1 },
          state: { status: "running", input: { command: "sleep 600" }, structured: {}, content: [] },
        },
      ],
    },
  ]
  const mounted = await mountReceipt(
    tmp.path,
    async (request) => {
      body = await request.clone().json()
      return response.promise
    },
    () => history,
  )
  await mounted.sync.session.sync(sessionID)
  const sent = mounted.sync.prompt.send(input)
  try {
    const [receipt] = Object.values(mounted.sync.prompt.data)
    expect(receipt.state).toBe("sending")
    expect(receipt.parts[0]).toMatchObject({ type: "text", text: "还没完成吗？" })
    expect(mounted.sync.prompt.messages(sessionID, mounted.sync.data.message[sessionID])).toHaveLength(2)
    expect(mounted.sync.data.message[sessionID]).toHaveLength(1)
    expect(mounted.sync.data.message[sessionID][0].role).toBe("assistant")
    expect(mounted.sync.data.part["msg_running_tool"][0]).toMatchObject({ type: "tool", state: { status: "running" } })
    await wait(() => body !== undefined)
    expect(body).toMatchObject({ id: receipt.info.id, prompt: { text: "还没完成吗？" } })
    await mounted.sync.session.sync(sessionID)
    expect(mounted.sync.prompt.data[receipt.info.id]?.state).toBe("sending")
    response.resolve(
      json({
        data: {
          id: receipt.info.id,
          sessionID,
          delivery: "steer",
          admittedSeq: 1,
          timeCreated: 2,
          prompt: { text: "还没完成吗？" },
        },
      }),
    )
    await sent
    expect(mounted.sync.prompt.data[receipt.info.id]?.state).toBe("admitted")
    expect(mounted.sync.data.message[sessionID]).toHaveLength(1)
    expect(mounted.sync.data.message[sessionID][0].role).toBe("assistant")
  } finally {
    response.resolve(json({ data: {} }))
    await sent.catch(() => {})
    mounted.app.renderer.destroy()
  }
})

test("admission is a receipt, promotion reconciles one visible message, and a late HTTP response cannot resurrect it", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const response = Promise.withResolvers<Response>()
  const history: SessionMessage[] = []
  const mounted = await mountReceipt(
    tmp.path,
    () => response.promise,
    () => history,
  )
  const sent = mounted.sync.prompt.send(input)
  try {
    const [receipt] = Object.values(mounted.sync.prompt.data)
    const properties = {
      sessionID,
      messageID: receipt.info.id,
      timestamp: receipt.info.time.created,
      delivery: "steer" as const,
      prompt: { text: "还没完成吗？" },
    }
    mounted.emit(payload({ id: "evt_admitted", type: "session.next.prompt.admitted", properties }))
    await wait(() => mounted.sync.prompt.data[receipt.info.id]?.state === "admitted")
    expect(mounted.sync.data.message[sessionID] ?? []).toHaveLength(0)
    history.push({ id: receipt.info.id, type: "user", text: "还没完成吗？", time: { created: properties.timestamp } })
    mounted.emit(payload({ id: "evt_prompted", type: "session.next.prompted", properties }))
    await wait(() => mounted.sync.data.message[sessionID]?.some((message) => message.id === receipt.info.id) === true)
    expect(mounted.sync.prompt.data[receipt.info.id]).toBeUndefined()
    expect(mounted.sync.prompt.messages(sessionID, mounted.sync.data.message[sessionID])).toHaveLength(1)
    response.resolve(
      json({
        data: {
          id: receipt.info.id,
          sessionID,
          delivery: "steer",
          admittedSeq: 1,
          promotedSeq: 2,
          timeCreated: properties.timestamp,
          prompt: properties.prompt,
        },
      }),
    )
    await sent
    mounted.emit(payload({ id: "evt_admitted_replay", type: "session.next.prompt.admitted", properties }))
    await Bun.sleep(60)
    expect(mounted.sync.prompt.data[receipt.info.id]).toBeUndefined()
    expect(mounted.sync.prompt.messages(sessionID, mounted.sync.data.message[sessionID])).toHaveLength(1)
  } finally {
    response.resolve(json({ data: {} }))
    await sent.catch(() => {})
    mounted.app.renderer.destroy()
  }
})

test("a rejected send keeps the text with a failed receipt, not a phantom projected user message", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const mounted = await mountReceipt(tmp.path, () =>
    json({ name: "UnknownError", data: { message: "Prompt rejected" } }, { status: 503 }),
  )
  try {
    await expect(mounted.sync.prompt.send(input)).rejects.toThrow()
    const [receipt] = Object.values(mounted.sync.prompt.data)
    expect(receipt.state).toBe("failed")
    expect(receipt.error).toContain("Prompt rejected")
    expect(receipt.parts[0]).toMatchObject({ type: "text", text: "还没完成吗？" })
    expect(mounted.sync.data.message[sessionID] ?? []).toHaveLength(0)
  } finally {
    mounted.app.renderer.destroy()
  }
})

test("an externally admitted queued message is visible before its promotion", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const mounted = await mountReceipt(tmp.path, () => json({ data: {} }))
  try {
    mounted.emit(
      payload({
        id: "evt_peer_admitted",
        type: "session.next.prompt.admitted",
        properties: {
          sessionID,
          messageID: "msg_peer",
          timestamp: 3,
          delivery: "queue",
          prompt: { text: "Peer message" },
        },
      }),
    )
    await wait(() => mounted.sync.prompt.data["msg_peer"]?.state === "admitted")
    expect(mounted.sync.prompt.data["msg_peer"].delivery).toBe("queue")
    expect(mounted.sync.prompt.messages(sessionID, mounted.sync.data.message[sessionID] ?? [])).toHaveLength(1)
    expect(mounted.sync.data.message[sessionID] ?? []).toHaveLength(0)
  } finally {
    mounted.app.renderer.destroy()
  }
})
