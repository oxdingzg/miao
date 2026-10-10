#!/usr/bin/env bun
// A minimal stand-in for `miao-engine serve`. It speaks the same JSONL wire
// (id/method/params requests, event/progress messages) so the host client can be
// exercised without the Rust binary, which is not built in a plain checkout.
const decoder = new TextDecoder()
const prompts = new Map<string, string>()
let buffer = ""

const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")

function handle(request: { id: number; method: string; params: Record<string, unknown> }) {
  const { id, method, params } = request
  if (method === "boom") {
    send({ id, error: { code: "boom", message: "kaboom" } })
    return
  }
  if (method === "admit") {
    const input = params.input as { session_id: string; input_id: string; prompt: string }
    prompts.set(input.session_id, input.prompt)
    send({ id, result: { input_id: input.input_id, admitted_seq: 1, duplicate: false, pending: false } })
    emit(input.session_id)
    return
  }
  if (method === "history") {
    const session = params.session_id as string
    const prompt = prompts.get(session) ?? ""
    send({
      id,
      result: [
        { role: "user", content: [{ type: "text", text: prompt }] },
        { role: "assistant", content: [{ type: "text", text: `echo:${prompt}` }] },
      ],
    })
    return
  }
  if (method === "shutdown") {
    send({ id, result: { accepted: true } })
    process.exit(0)
  }
  send({ id, result: { accepted: true } })
}

function emit(session: string) {
  const text = `echo:${prompts.get(session) ?? ""}`
  send({ method: "progress", params: { session_id: session, kind: "provider.delta", data: { text } } })
  send({ method: "event", params: { session_id: session, seq: 1, kind: "run.started", data: { run_id: "run" } } })
  send({
    method: "event",
    params: { session_id: session, seq: 2, kind: "message.committed", recorded_at_ms: 1_700_000_000_123, data: { role: "assistant", content: [{ type: "text", text }] } },
  })
  send({ method: "event", params: { session_id: session, seq: 3, kind: "run.finished", data: { run_id: "run" } } })
}

const reader = Bun.stdin.stream().getReader()
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  let index = buffer.indexOf("\n")
  while (index >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim()) handle(JSON.parse(line))
    index = buffer.indexOf("\n")
  }
}
