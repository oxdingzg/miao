import { randomUUID } from "crypto"
import { EngineClient, EngineError, type EngineEvent, type EngineOptions } from "./client"
import { BlackboxTape } from "@miao/core/blackbox/tape"
import { EngineTrace } from "../blackbox/engine-trace"

/**
 * Headless driver for one engine prompt. It subscribes before admitting so no
 * committed event is missed, resolves approvals with a fixed decision (the PoC
 * has no interactive approval UI), waits for `run.finished`, then reads the
 * committed history for the assistant text. A question request is unsupported
 * here and fails the run instead of hanging on the engine's timeout.
 */

export interface EngineRunOptions extends EngineOptions {
  prompt: string
  session?: string
  inputId?: string
  approve?: "allow" | "deny"
  timeoutMs?: number
  onEvent?: (event: EngineEvent) => void
  blackbox?: BlackboxTape.Recorder | BlackboxTape.Replay
}

export interface EngineRunResult {
  session: string
  text: string
  events: EngineEvent[]
}

export async function runEnginePrompt(options: EngineRunOptions): Promise<EngineRunResult> {
  const session = options.session ?? `ses_${randomUUID()}`
  const inputId = options.inputId ?? `in_${randomUUID()}`
  const client = EngineClient.start(options)
  const events: EngineEvent[] = []
  const recordings: Promise<void>[] = []
  const trace = new EngineTrace()
  let recordingFailure: unknown
  let finished: (() => void) | undefined
  const done = new Promise<void>((resolve) => (finished = resolve))
  let failure: Error | undefined
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined

  client.onEvent((event) => {
    events.push(event)
    if (options.blackbox) {
      const recorded = event.kind === "provider.failed" ? { ...event, data: { failed: true } } : event
      const projected = trace.project(recorded)
      if (options.blackbox instanceof BlackboxTape.Replay) {
        try { options.blackbox.expectTrace(projected.session, projected.kind, projected.data) }
        catch (error) { recordingFailure = error }
      } else {
        recordings.push(options.blackbox.trace(projected).catch((error: unknown) => { recordingFailure = error }))
      }
    }
    options.onEvent?.(event)
    if (event.kind === "approval.requested") {
      const approval = event.data as { request_id: string; input_hash: string; policy_revision: string }
      void client
        .approve(event.session_id, {
          request_id: approval.request_id,
          input_hash: approval.input_hash,
          policy_revision: approval.policy_revision,
          decision: options.approve ?? "deny",
        })
        .catch(() => undefined)
    }
    if (event.kind === "question.requested") failure = new EngineError("question_unsupported", "engine requested a question; headless runs cannot answer")
    if (event.kind === "provider.failed") failure = new EngineError("provider_failed", "the provider turn failed")
    if (event.kind === "run.finished") finished?.()
  })

  try {
    await client.subscribe(session, 0)
    await client.admit({ session_id: session, input_id: inputId, prompt: options.prompt })
    const timeout = new Promise<never>((_, reject) =>
      timeoutTimer = setTimeout(() => reject(new EngineError("engine_timeout", "engine run timed out")), options.timeoutMs ?? 120_000),
    )
    await Promise.race([done, timeout])
    await Promise.all(recordings)
    if (recordingFailure) throw recordingFailure
    if (failure) throw failure
    const history = (await client.history(session, true)) as Array<{ role: string; content: unknown }>
    return { session, text: assistantText(history), events }
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    await client.close()
  }
}

function assistantText(history: Array<{ role: string; content: unknown }>) {
  return history
    .filter((message) => message.role === "assistant")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("\n")
}
