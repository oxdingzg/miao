import { randomUUID } from "crypto"
import { EngineClient, EngineError, type EngineEvent, type EngineOptions, type EngineProgress } from "./client"
import { BlackboxTape } from "@miao/core/blackbox/tape"
import { EngineTrace } from "../blackbox/engine-trace"
import { EngineTools } from "../blackbox/engine-tools"

/**
 * Headless driver for one engine prompt. It subscribes before admitting so no
 * committed event is missed, resolves approvals with a fixed decision (the PoC
 * has no interactive approval UI), waits for promotion plus `run.finished`, and
 * projects only the admitted input's bounded committed assistant text. A question request is unsupported
 * here and fails the run instead of hanging on the engine's timeout.
 */

export interface EngineRunOptions extends EngineOptions {
  prompt: string
  session?: string
  inputId?: string
  approve?: "allow" | "deny"
  timeoutMs?: number
  onEvent?: (event: EngineEvent) => void
  onProgress?: (progress: EngineProgress) => void
  blackbox?: BlackboxTape.Recorder | BlackboxTape.Replay
}

export interface EngineRunResult {
  session: string
  text: string
  events: EngineEvent[]
  admittedSeq: number
  terminal: {
    reason: "completed" | "failed" | "interrupted"
    runId: string | null
  }
}

export async function runEnginePrompt(options: EngineRunOptions): Promise<EngineRunResult> {
  if (options.blackbox instanceof BlackboxTape.Replay && !options.toolReplayFile)
    throw new EngineError("tool_replay_required", "Engine replay requires an explicit native tool tape")
  const session = options.session ?? `ses_${randomUUID()}`
  const inputId = options.inputId ?? `in_${randomUUID()}`
  const client = EngineClient.start(options)
  const events: EngineEvent[] = []
  const recordings: Promise<void>[] = []
  const trace = new EngineTrace()
  const toolTape = options.blackbox ? new EngineTools(options.blackbox) : undefined
  let recordingFailure: unknown
  let finished: (() => void) | undefined
  const done = new Promise<void>((resolve) => (finished = resolve))
  let failure: Error | undefined
  let admittedSeq: number | undefined
  let completed: { after: number; until: number } | undefined
  let terminalOutcome: EngineRunResult["terminal"] | undefined
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined

  const settle = () => {
    const sequence = admittedSeq
    if (sequence === undefined) return
    const scoped = events.filter((event) => event.seq > sequence)
    const promoted = scoped.find((event) => {
      if (event.kind !== "input.promoted") return false
      const data = BlackboxTape.json(event.data)
      return BlackboxTape.isObject(data) && data.input_id === inputId
    })
    if (!promoted) return
    const terminal = scoped.find((event) => event.seq > promoted.seq && event.kind === "run.finished")
    if (!terminal) return
    const terminalData = BlackboxTape.json(terminal.data)
    // A normal drain records its lifecycle stop after run.finished. Waiting
    // for that durable boundary keeps record and replay independent of pipe
    // chunking. Startup recovery has no executing drain or lifecycle stop.
    if (
      BlackboxTape.isObject(terminalData) &&
      terminalData.recovered !== true &&
      !scoped.some((event) => {
        if (event.seq <= terminal.seq || (event.kind !== "stop" && event.kind !== "stop_failure")) return false
        const data = BlackboxTape.json(event.data)
        return BlackboxTape.isObject(data) && data.run_id === terminalData.run_id
      })
    )
      return
    completed = { after: promoted.seq, until: terminal.seq }
    const outcome = scoped.filter((event) => event.seq > promoted.seq && event.seq <= terminal.seq)
    const data = BlackboxTape.json(terminal.data)
    const reason = BlackboxTape.isObject(data) ? data.reason : undefined
    const runId = BlackboxTape.isObject(data) && typeof data.run_id === "string" ? data.run_id : null
    if (reason === "completed" || reason === "failed" || reason === "interrupted")
      terminalOutcome = { reason, runId }
    if (reason === "failed")
      failure =
        outcome.findLast((event) => event.kind === "provider.started" || event.kind === "provider.failed")?.kind ===
        "provider.failed"
          ? new EngineError("provider_failed", "the provider turn failed")
          : new EngineError("engine_run_failed", "the engine run failed")
    if (reason === "interrupted") failure = new EngineError("engine_interrupted", "the engine run was interrupted")
    if (reason !== "completed" && reason !== "failed" && reason !== "interrupted")
      failure = new EngineError("engine_outcome_missing", "the engine run has no authoritative terminal outcome")
    if (outcome.some((event) => event.kind === "question.requested"))
      failure = new EngineError("question_unsupported", "engine requested a question; headless runs cannot answer")
    finished?.()
  }

  client.onEvent((event) => {
    events.push(event)
    if (options.blackbox) {
      const projected = trace.project(event)
      if (options.blackbox instanceof BlackboxTape.Replay) {
        try {
          options.blackbox.expectTrace(projected.session, projected.kind, projected.data)
        } catch (error) {
          recordingFailure = error
        }
      } else {
        recordings.push(
          options.blackbox.trace(projected).catch((error: unknown) => {
            recordingFailure = error
          }),
        )
      }
    }
    if (toolTape)
      recordings.push(
        toolTape.observe(event).catch((error: unknown) => {
          recordingFailure = error
        }),
      )
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
    settle()
  })

  if (options.onProgress) client.onProgress(options.onProgress)

  try {
    await client.subscribe(session, 0)
    const admission = BlackboxTape.json(
      await client.admit({ session_id: session, input_id: inputId, prompt: options.prompt }),
    )
    if (
      !BlackboxTape.isObject(admission) ||
      typeof admission.admitted_seq !== "number" ||
      !Number.isSafeInteger(admission.admitted_seq) ||
      admission.admitted_seq < 0
    )
      throw new EngineError("engine_admission_invalid", "the engine admission has no valid sequence")
    admittedSeq = admission.admitted_seq
    settle()
    const timeout = new Promise<never>(
      (_, reject) =>
        (timeoutTimer = setTimeout(
          () => reject(new EngineError("engine_timeout", "engine run timed out")),
          options.timeoutMs ?? 120_000,
        )),
    )
    await Promise.race([done, timeout])
    await Promise.all(recordings)
    if (recordingFailure) throw recordingFailure
    if (failure) throw failure
    if (!completed) throw new EngineError("engine_outcome_missing", "the admitted input has no completed output range")
    if (!terminalOutcome) throw new EngineError("engine_outcome_missing", "the engine run has no authoritative terminal outcome")
    return {
      session,
      text: assistantText(events, completed),
      events,
      admittedSeq: admittedSeq ?? 0,
      terminal: terminalOutcome,
    }
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    await client.close()
  }
}

function assistantText(events: EngineEvent[], range: { after: number; until: number }) {
  return events
    .filter((event) => event.seq > range.after && event.seq < range.until && event.kind === "message.committed")
    .flatMap((event) => {
      const data = BlackboxTape.json(event.data)
      if (!BlackboxTape.isObject(data) || data.role !== "assistant" || !Array.isArray(data.content)) return []
      return data.content.flatMap((block) =>
        BlackboxTape.isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
      )
    })
    .join("\n")
}
