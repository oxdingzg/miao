import { describe, expect, test } from "bun:test"
import { createOpencodeClient, type SessionMessage, type ToolPart } from "@opencode-ai/sdk/v2"
import { runHeadless } from "../../../src/cli/cmd/run/headless"

const sessionID = "ses_headless"
const directory = "/tmp/headless"

const transcript: SessionMessage[] = [
  {
    id: "msg_user",
    type: "user",
    text: "follow the chain",
    time: { created: 1 },
  },
  {
    id: "msg_assistant",
    type: "assistant",
    agent: "build",
    model: { id: "gpt-6.1-sol", providerID: "openai" },
    time: { created: 2, completed: 3 },
    finish: "stop",
    content: [
      {
        type: "tool",
        id: "call_cat",
        name: "bash",
        state: {
          status: "completed",
          input: { command: "cat step1.txt" },
          content: [{ type: "text", text: "final word: pelican\n" }],
          outputPaths: [],
          structured: { exit: 0, truncated: false },
        },
        time: { created: 2, ran: 2, completed: 2 },
      },
      { type: "text", id: "txt_answer", text: "pelican" },
    ],
  } as never,
]

// A minimal server: the transcript appears once the prompt is admitted, the event
// stream then carries a permission ask and a question, and only after both have
// been answered does the step settle and session.wait return.
function server(options: { failPrompt?: boolean; models?: { providerID: string; id: string }[] } = {}) {
  const calls: string[] = []
  const answered = new Set<string>()
  let admitted = false
  let push: (event: object) => void = () => {}
  let idle: () => void = () => {}
  const settled = new Promise<void>((resolve) => (idle = resolve))
  const fetch = async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input)
    const url = new URL(request.url)
    calls.push(`${request.method} ${url.pathname}`)
    const json = (body: unknown, status = 200) => Response.json(body, { status })
    if (url.pathname === "/event") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (event) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    }
    if (url.pathname === "/api/model" && options.models) return json({ location: { directory }, data: options.models })
    if (url.pathname === `/api/session/${sessionID}`)
      return json({ data: { id: sessionID, agent: "build", title: "t", location: { directory } } })
    if (url.pathname === `/api/session/${sessionID}/context`) return json({ data: admitted ? transcript : [] })
    if (url.pathname.endsWith("/model") || url.pathname.endsWith("/agent")) return new Response(null, { status: 204 })
    if (url.pathname === `/api/session/${sessionID}/prompt`) {
      if (options.failPrompt) return json({ name: "ConflictError", data: { message: "prompt rejected" } }, 409)
      admitted = true
      push({
        type: "permission.v2.asked",
        properties: { id: "per_1", sessionID, action: "bash", resources: ["rm -rf /"] },
      })
      push({ type: "question.v2.asked", properties: { id: "que_1", sessionID, questions: [] } })
      return json({ data: { admittedSeq: 1 } })
    }
    if (url.pathname === `/api/session/${sessionID}/wait`) {
      await settled
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith("/reply") || url.pathname.endsWith("/reject")) {
      answered.add(url.pathname)
      if (answered.size === 2) {
        push({ type: "session.next.step.ended", properties: { sessionID } })
        idle()
      }
      return json(true)
    }
    return json({ name: "NotFound", data: { message: url.pathname } }, 404)
  }
  return {
    calls,
    client: createOpencodeClient({
      baseUrl: "http://headless.test",
      fetch: Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }),
    }),
  }
}

function capture() {
  const printed: string[] = []
  const events: { type: string; data: Record<string, unknown> }[] = []
  return {
    printed,
    events,
    output: (json: boolean) => ({
      json,
      emit: (type: string, data: Record<string, unknown>) => {
        if (!json) return false
        events.push({ type, data })
        return true
      },
      print: {
        header: (agent: string, model: string) => void printed.push(`> ${agent} · ${model}`),
        tool: async (part: ToolPart) => void printed.push(`tool ${part.tool}`),
        toolError: async (part: ToolPart) => void printed.push(`tool-error ${part.tool}`),
        text: (text: string) => void printed.push(`text ${text}`),
        reasoning: (text: string) => void printed.push(`reasoning ${text}`),
        warning: (text: string) => void printed.push(`warning ${text}`),
        error: (text: string) => void printed.push(`error ${text}`),
      },
    }),
  }
}

const base = {
  sessionID,
  directory,
  agent: undefined,
  model: { providerID: "openai", modelID: "gpt-6.1-sol" },
  variant: "medium",
  message: "follow the chain",
  files: [],
  command: undefined,
  thinking: false,
}

describe("headless V2 run", () => {
  test("prints each settled part once and declines what nobody can answer", async () => {
    const { calls, client } = server()
    const out = capture()
    const error = await runHeadless({ ...base, client, auto: false, ...out.output(false) })

    expect(error).toBeUndefined()
    expect(out.printed.filter((line) => !line.startsWith("warning"))).toEqual([
      "> build · gpt-6.1-sol",
      "tool bash",
      "text pelican",
    ])
    expect(out.printed).toContain("warning permission requested: bash (rm -rf /); auto-rejecting")
    expect(calls).toContain(`POST /api/session/${sessionID}/permission/per_1/reply`)
    expect(calls).toContain(`POST /api/session/${sessionID}/question/que_1/reject`)
    expect(calls.indexOf(`POST /api/session/${sessionID}/model`)).toBeLessThan(
      calls.indexOf(`POST /api/session/${sessionID}/prompt`),
    )
  })

  test("writes the V1-shaped JSON event sequence", async () => {
    const { client } = server()
    const out = capture()
    await runHeadless({ ...base, client, auto: true, ...out.output(true) })

    expect(out.events.map((event) => event.type)).toEqual(["step_start", "tool_use", "text", "step_finish"])
    expect(out.events[1].data.part).toMatchObject({ type: "tool", tool: "bash", state: { status: "completed" } })
    expect(out.printed).toEqual([])
  })

  test("returns the error when the prompt is refused", async () => {
    const { client } = server({ failPrompt: true })
    const out = capture()
    const error = await runHeadless({ ...base, client, auto: false, ...out.output(false) })

    expect(error).toBe("prompt rejected")
    expect(out.printed).toEqual(["error prompt rejected"])
  })
  test("refuses a model the catalog does not list before sending anything", async () => {
    const { calls, client } = server({ models: [{ providerID: "openai", id: "gpt-6.1-sol" }] })
    const out = capture()
    const error = await runHeadless({
      ...base,
      model: { providerID: "openai", modelID: "no-such-model" },
      client,
      auto: false,
      ...out.output(true),
    })

    expect(error).toBe("Model not found: openai/no-such-model")
    expect(out.events.map((event) => event.type)).toEqual(["error"])
    expect(calls.some((call) => call.endsWith("/prompt"))).toBe(false)
  })
})
