#!/usr/bin/env bun
// A minimal stand-in for `miao-engine serve`. It speaks the same JSONL wire
// (id/method/params requests, event/progress messages) so the host client can be
// exercised without the Rust binary, which is not built in a plain checkout.
import { appendFileSync } from "node:fs"

const decoder = new TextDecoder()
// Harness tests assert the request order by pointing this at a file.
const requestLog = process.env.ENGINE_FAKE_REQUESTS
const prompts = new Map<string, string>()
let buffer = ""

const cursors = new Map<string, number>()
const send = (value: unknown) => {
  if (
    typeof value === "object" &&
    value !== null &&
    "method" in value &&
    value.method === "event" &&
    "params" in value &&
    typeof value.params === "object" &&
    value.params !== null &&
    "session_id" in value.params &&
    typeof value.params.session_id === "string" &&
    "seq" in value.params &&
    typeof value.params.seq === "number"
  )
    cursors.set(value.params.session_id, Math.max(cursors.get(value.params.session_id) ?? 0, value.params.seq))
  return process.stdout.write(JSON.stringify(value) + "\n")
}

// An optional scripted run for harness tests: each step may emit one progress
// or event message, with an optional delay before it. Without it the fake keeps
// its original echo behavior.
type FakeStep = {
  delayMs?: number
  progress?: unknown
  event?: unknown
  writeFile?: { path: string; text: string }
}
const script: { steps: FakeStep[]; cancelSteps?: FakeStep[] } | undefined = process.env.ENGINE_FAKE_SCRIPT
  ? await Bun.file(process.env.ENGINE_FAKE_SCRIPT).json()
  : undefined

let seqBase: number | undefined
async function seqOffset() {
  if (seqBase !== undefined) return seqBase
  const file = process.env.ENGINE_FAKE_SCRIPT ? process.env.ENGINE_FAKE_SCRIPT + ".seq" : undefined
  const previous = file && (await Bun.file(file).exists()) ? Number(await Bun.file(file).text()) : 0
  seqBase = Number.isFinite(previous) ? previous : 0
  if (file) await Bun.write(file, String(seqBase + 1_000))
  return seqBase
}

function substitute(value: unknown, session: string, inputID: string): unknown {
  if (typeof value === "string")
    return value
      .replaceAll("$SESSION", session)
      .replaceAll("$INPUT_ID", inputID)
      .replaceAll("$PROMPT", prompts.get(session) ?? "")
  if (Array.isArray(value)) return value.map((item) => substitute(item, session, inputID))
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, session, inputID)]))
  return value
}

function handle(request: { id: number; method: string; params: Record<string, unknown> }) {
  const { id, method, params } = request
  if (requestLog) appendFileSync(requestLog, method + "\n")
  if (method === "fixture_exit") {
    send({ id, result: { accepted: true } })
    process.exit(1)
  }
  if (method === "fixture_frames" && Array.isArray(params.frames)) {
    params.frames.forEach(send)
    send({ id, result: { accepted: true } })
    return
  }
  if (method === "snapshot") {
    if (process.env.ENGINE_FAKE_IGNORE_SNAPSHOT === "1") return
    send({ id, result: { session_id: params.session_id, cursor: cursors.get(String(params.session_id)) ?? 0 } })
    return
  }
  if (method === "boom") {
    send({ id, error: { code: "boom", message: "kaboom" } })
    return
  }
  if (method === "admit") {
    const input = params.input as { session_id: string; input_id: string; prompt: string }
    prompts.set(input.session_id, input.prompt)
    send({ id, result: { input_id: input.input_id, admitted_seq: 1, duplicate: false, pending: false } })
    void emit(input.session_id, input.input_id)
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
  if (method === "cancel") cancelled(params)
  send({ id, result: { accepted: true } })
}

async function emitSteps(steps: FakeStep[], session: string, inputID: string) {
  for (const step of steps) {
    if (step.delayMs) await Bun.sleep(step.delayMs)
    if (step.writeFile) await Bun.write(step.writeFile.path, step.writeFile.text)
    if (step.progress !== undefined) send({ method: "progress", params: substitute(step.progress, session, inputID) })
    if (step.event !== undefined) {
      const payload = substitute(step.event, session, inputID) as { seq?: unknown } | undefined
      // The real engine commits a Session's events with a monotonic sequence,
      // and a follow-up subscription replays the older ones. The fixture is
      // spawned per input, so persist an offset to reproduce that ordering.
      if (payload && typeof payload.seq === "number") payload.seq += await seqOffset()
      send({ method: "event", params: payload })
    }
  }
}

// A cancellation produces the scripted reaction only when the host actually
// sends `cancel`, so harness tests prove the interrupt predicate fired.
function cancelled(params: Record<string, unknown>) {
  if (!script?.cancelSteps) return
  void emitSteps(script.cancelSteps, String(params.session_id ?? ""), "cancelled")
}

async function emit(session: string, inputID: string) {
  if (script) return emitSteps(script.steps, session, inputID)
  const text = `echo:${prompts.get(session) ?? ""}`
  send({ method: "progress", params: { session_id: session, kind: "provider.delta", data: { text } } })
  send({
    method: "event",
    params: { session_id: session, seq: 1, kind: "input.admitted", data: { input_id: inputID, delivery: "steer" } },
  })
  send({
    method: "event",
    params: {
      session_id: session,
      seq: 2,
      kind: "input.promoted",
      data: { input_id: inputID, prompt: prompts.get(session), checkpoint: "checkpoint" },
    },
  })
  send({ method: "event", params: { session_id: session, seq: 3, kind: "run.started", data: { run_id: "run" } } })
  send({
    method: "event",
    params: {
      session_id: session,
      seq: 4,
      kind: "message.committed",
      recorded_at_ms: 1_700_000_000_123,
      data: { role: "assistant", content: [{ type: "text", text }] },
    },
  })
  send({
    method: "event",
    params: { session_id: session, seq: 5, kind: "run.finished", data: { run_id: "run", reason: "completed" } },
  })
  send({ method: "event", params: { session_id: session, seq: 6, kind: "stop", data: { run_id: "run" } } })
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
