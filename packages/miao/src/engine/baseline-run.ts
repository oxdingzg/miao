import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import type { Schema } from "effect"
import { BlackboxTape } from "@miao/core/blackbox/tape"
import { assessBaselineArtifacts, baselineContract, baselineTask, initializeBaselineWorkspace } from "./baseline"
import type { BaselineSample } from "./baseline-report"
import type { EngineEvent, EngineProgress } from "./client"
import { runEnginePrompt } from "./run"

/**
 * Executes one frozen baseline task against one engine and produces a report
 * sample bound to its evidence. Every attempt, receipt, profile fingerprint,
 * and phase timestamp comes from durable engine events or the TypeScript
 * blackbox bundle; nothing is inferred from the agent's own claims.
 */

export interface BaselineAttempt {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  cost: number | null
}

export interface BaselinePhase {
  phase: string
  /** Absolute epoch milliseconds from the durable clock or the runner's observation. */
  atMs: number
  clock: "recorded" | "observed"
}

export interface BaselineEvidence {
  engine: "rust" | "typescript"
  revision: string
  task: string
  repetition: number
  terminal: "completed" | "failed" | "interrupted" | null
  error: string | null
  receipts: string[]
  attempts: BaselineAttempt[]
  phases: BaselinePhase[]
  profile: BaselineSample["profile"] | null
  profileReceipts: number
  /** Loop classification: continuation and stop reasons observed in the run. */
  loops: { continuations: string[]; stopped: string[] }
  toolCalls: number
  textHash: string
  binarySha256: string | null
  startedAtMs: number
  admissionMs: number | null
  elapsedMs: number
}

export interface BaselineRun {
  sample: BaselineSample | null
  rejection: string | null
  evidence: BaselineEvidence
  assessment: Awaited<ReturnType<typeof assessBaselineArtifacts>>
  answer: string
}

export interface BaselineRustInput {
  revision: string
  binary: string
  /** New directory owned by this run; the workspace is created inside it. */
  root: string
  task: string
  repetition: number
  model: string
  provider?: string
  credentialDatabase?: string
  credentialID?: string
  credentialIntegration?: string
  policyFile?: string
  /** Provider base URL override; the subscription default applies otherwise. */
  endpoint?: string
  /** Evaluation ablation control; `false` disables stale-edit recovery. */
  editRecovery?: boolean
  /** Evaluation ablation control; `false` disables LSP warm-up and post-edit diagnostics. */
  lspDiagnostics?: boolean
  /** Absolute path to an LSP host config used by the measured run. */
  lspConfigFile?: string
  /**
   * Drift experiment control: after the model reads one of these workspace
   * paths, the runner rewrites it with the given content before the model's
   * next turn, so a stale edit is exercised without changing the oracle.
   */
  drifts?: Record<string, string>
  timeoutMs?: number
  env?: Record<string, string | undefined>
  binarySha256?: string
}

export interface BaselineTsInput {
  revision: string
  /** New directory owned by this run; the workspace is created inside it. */
  root: string
  task: string
  repetition: number
  model: string
  /** Absolute path to packages/miao/src/index.ts. */
  entry: string
  bun?: string
  /** Stable credential store copied into the run's shared store (read-only). */
  credentialDatabase?: string
  /** Drift experiment control; see BaselineRustInput.drifts. */
  drifts?: Record<string, string>
  timeoutMs?: number
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const fingerprint = (value: unknown) => digest(BlackboxTape.canonical(BlackboxTape.json(value)))

export async function runBaselineRust(input: BaselineRustInput): Promise<BaselineRun> {
  const task = baselineTask(input.task)
  const workspace = path.join(input.root, "workspace")
  await mkdir(input.root, { recursive: true })
  await initializeBaselineWorkspace(workspace, task.id)
  const startedAtMs = Date.now()
  const events: EngineEvent[] = []
  const progress: Array<{ item: EngineProgress; atMs: number }> = []
  const observed = new Map<number, number>()
  const session = `ses_${randomUUID()}`
  const drifts = new Map(Object.entries(input.drifts ?? {}))
  const drifted = new Set<string>()
  const readCalls = new Map<string, string>()
  const callProviders = new Map<string, string>()
  // The drift lands the moment the model's read of that path settles, so the
  // following edit carries a stale fingerprint against changed content.
  const applyDrift = (event: EngineEvent) => {
    if (drifts.size === 0) return
    const data = BlackboxTape.json(event.data)
    if (event.kind === "message.committed") {
      if (!BlackboxTape.isObject(data) || data.role !== "assistant" || !Array.isArray(data.content)) return
      for (const block of data.content) {
        if (!BlackboxTape.isObject(block) || block.type !== "tool_use" || block.name !== "read_file") continue
        const request = BlackboxTape.isObject(block.input) ? block.input : {}
        if (typeof block.id === "string" && typeof request.path === "string" && drifts.has(request.path))
          readCalls.set(block.id, request.path)
      }
      return
    }
    if (event.kind === "tool.dispatched") {
      if (BlackboxTape.isObject(data) && typeof data.call_id === "string" && typeof data.provider_id === "string")
        callProviders.set(data.call_id, data.provider_id)
      return
    }
    if (event.kind !== "tool.completed") return
    const callId = BlackboxTape.isObject(data) && typeof data.call_id === "string" ? data.call_id : undefined
    const target = callId ? readCalls.get(callProviders.get(callId) ?? "") : undefined
    if (!target || drifted.has(target)) return
    drifted.add(target)
    writeFileSync(path.join(workspace, target), drifts.get(target)!)
  }
  // The interrupted-turn fixture needs a provider stream that breaks mid-body:
  // a host cancel never records provider.interrupted, while a truncated stream
  // does, and the engine must continue without re-running the settled tool.
  const proxy =
    task.id === "stream-interruption"
      ? await startInterruptionProxy(input.endpoint ?? "https://chatgpt.com/backend-api/codex/responses")
      : undefined
  let error: string | null = null
  // Each follow-up is admitted on the same Session after the previous run
  // settles, so history accumulates the way a long interactive Session does.
  for (const prompt of [task.prompt, ...(task.followups ?? [])]) {
    const failure = await runEnginePrompt({
      binary: input.binary,
      db: path.join(input.root, "engine.db"),
      workspace,
      model: input.model,
      provider: input.provider,
      credentialDatabase: input.credentialDatabase,
      credentialID: input.credentialID,
      credentialIntegration: input.credentialIntegration,
      policyFile: input.policyFile ?? (await writeBaselinePolicy(input.root)),
      endpoint: proxy?.endpoint ?? input.endpoint,
      editRecovery: input.editRecovery,
      env: input.env,
      session,
      prompt,
      approve: "deny",
      timeoutMs: input.timeoutMs ?? 300_000,
      onEvent: (event) => {
        observed.set(event.seq, Date.now())
        events.push(event)
        applyDrift(event)
      },
      onProgress: (item) => progress.push({ item, atMs: Date.now() }),
    }).then(
      () => null,
      (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
    )
    if (failure) {
      error = failure
      break
    }
  }
  proxy?.stop()
  const assessment = await assessBaselineArtifacts(workspace, task.id)
  const verifiedAtMs = Date.now()
  return finishBaselineRun({
    engine: "rust",
    revision: input.revision,
    binarySha256: input.binarySha256,
    task: task.id,
    repetition: input.repetition,
    startedAtMs,
    verifiedAtMs,
    error: [error, providerFailureDetail(events)].filter(Boolean).join(": ") || null,
    assessment,
    answer: committedText(events),
    terminal: terminalFromEvents(events),
    attempts: events.flatMap(usageAttempt),
    receipts: engineReceipts(events),
    loops: engineLoops(events),
    profile: engineProfile(events),
    phases: enginePhases(events, progress, observed, verifiedAtMs),
    toolCalls: events.filter((event) => event.kind === "tool.completed").length,
    admissionMs: admittedAt(events, observed),
    requiredReceipts: task.requiredReceipts,
    answerContains: task.answerContains,
  })
}

export async function runBaselineTs(input: BaselineTsInput): Promise<BaselineRun> {
  const task = baselineTask(input.task)
  const workspace = path.join(input.root, "workspace")
  await mkdir(input.root, { recursive: true })
  await initializeBaselineWorkspace(workspace, task.id)
  const blackbox = path.join(input.root, "blackbox")
  // The source runtime keeps its sessions in the local channel database under
  // the data directory, so redirecting XDG_DATA_HOME isolates every run. The
  // product reads inherited credentials from `<data>/miao.db` read-only, so a
  // minimal copy of the stable credential table makes the shared store work
  // without writing the product database.
  const data = path.join(input.root, "data")
  await mkdir(path.join(data, "miao"), { recursive: true })
  if (input.credentialDatabase) await seedSharedCredentials(input.credentialDatabase, path.join(data, "miao", "miao.db"))
  const startedAtMs = Date.now()
  const parts: Array<Record<string, Schema.Json>> = []
  const drifts = new Map(Object.entries(input.drifts ?? {}))
  const drifted = new Set<string>()
  let session: string | undefined
  let interrupted = false
  let exit = 0
  let stderrText = ""
  const timeoutMs = input.timeoutMs ?? 300_000
  // Each follow-up continues the same Session in the same workspace, so the
  // run accumulates history instead of starting over.
  for (const prompt of [task.prompt, ...(task.followups ?? [])]) {
    const args = [input.bun ?? "bun", input.entry, "run", prompt, "--format", "json", "-m", input.model]
    if (session) args.push("--session", session)
    const child = Bun.spawn(args, {
      cwd: workspace,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // miao run resolves its project root from PWD before cwd, so the
        // inherited value would otherwise point the whole run at the caller.
        PWD: workspace,
        XDG_DATA_HOME: data,
        MIAO_CONFIG_CONTENT: tsConfig(),
        MIAO_CONFIG_DIR: path.join(input.root, "config"),
        MIAO_DISABLE_PROJECT_CONFIG: "1",
        MIAO_BLACKBOX_RECORD: blackbox,
        NO_COLOR: "1",
      },
    },
  )
    const stdout = readJsonLines(child.stdout, (message) => {
      if (typeof message.sessionID === "string") session = message.sessionID
      if (message.type === "tool_use" || message.type === "text" || message.type === "step_start") parts.push(message)
      if (drifts.size > 0 && message.type === "tool_use") {
        const part = message.part
        const state = BlackboxTape.isObject(part) && BlackboxTape.isObject(part.state) ? part.state : undefined
        const request = state && BlackboxTape.isObject(state.input) ? state.input : undefined
        const tracked = request && typeof request.path === "string" ? request.path : undefined
        if (
          BlackboxTape.isObject(part) &&
          part.tool === "read" &&
          state?.status === "completed" &&
          tracked &&
          drifts.has(tracked) &&
          !drifted.has(tracked)
        ) {
          drifted.add(tracked)
          writeFileSync(path.join(workspace, tracked), drifts.get(tracked)!)
        }
      }
      if (task.id === "stream-interruption" && !interrupted && actionTool(message)) {
        interrupted = true
        child.kill("SIGINT")
      }
    })
    const stderr = new Response(child.stderr).text()
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    exit = await child.exited
    clearTimeout(timer)
    await stdout
    stderrText = await stderr
    if (exit !== 0) break
  }
  const exitAtMs = Date.now()
  const assessment = await assessBaselineArtifacts(workspace, task.id)
  const verifiedAtMs = Date.now()
  const bundle = session
    ? await BlackboxTape.load(path.join(blackbox, `${session}.json`)).catch(() => undefined)
    : undefined
  const interactions = bundle?.interactions ?? []
  const terminal = interrupted && exit === 130 ? "interrupted" : exit === 0 ? "completed" : "failed"
  return finishBaselineRun({
    engine: "typescript",
    revision: input.revision,
    binarySha256: undefined,
    task: task.id,
    repetition: input.repetition,
    startedAtMs,
    verifiedAtMs,
    error: exit === 0 ? null : stderrText.trim().slice(-400) || `exit ${exit}`,
    assessment,
    answer: parts
      .filter((part) => part.type === "text")
      .flatMap((part) => {
        const value = part.part
        return BlackboxTape.isObject(value) && typeof value.text === "string" ? [value.text] : []
      })
      .join("\n"),
    terminal,
    attempts: interactions.filter((item) => item.lane === "llm").map(interactionAttempt),
    receipts: [
      ...(tsPermissionDenied(parts, stderrText) ? ["permission.denied"] : []),
      ...(parts.some(tsToolError) ? ["tool.error"] : []),
      ...(interactions.some((item) => item.lane === "llm" && item.outcome === "cancelled")
        ? ["provider.interrupted"]
        : []),
    ],
    loops: { continuations: [], stopped: [] },
    profile: tsProfile(interactions),
    phases: tsPhases(parts, exitAtMs, verifiedAtMs),
    toolCalls: interactions.filter((item) => item.lane === "tool").length,
    admissionMs: null,
    requiredReceipts: task.requiredReceipts,
    answerContains: task.answerContains,
  })
}

interface FinishedBaselineRun {
  engine: "rust" | "typescript"
  revision: string
  task: string
  repetition: number
  startedAtMs: number
  verifiedAtMs: number
  error: string | null
  assessment: BaselineRun["assessment"]
  answer: string
  terminal: BaselineEvidence["terminal"]
  attempts: BaselineAttempt[]
  receipts: string[]
  profile: ReturnType<typeof engineProfile>
  phases: BaselinePhase[]
  toolCalls: number
  admissionMs: number | null
  requiredReceipts: string[]
  answerContains: string[]
  loops: { continuations: string[]; stopped: string[] }
  binarySha256?: string
}

function finishBaselineRun(input: FinishedBaselineRun): BaselineRun {
  const profile = input.profile
  const evidence: BaselineEvidence = {
    engine: input.engine,
    revision: input.revision,
    task: input.task,
    repetition: input.repetition,
    terminal: input.terminal,
    error: input.error,
    receipts: input.receipts,
    attempts: input.attempts,
    phases: input.phases,
    profile: profile?.profile ?? null,
    profileReceipts: profile?.receipts ?? 0,
    loops: input.loops,
    toolCalls: input.toolCalls,
    textHash: digest(input.answer),
    binarySha256: input.binarySha256 ?? null,
    startedAtMs: input.startedAtMs,
    admissionMs: input.admissionMs,
    elapsedMs: input.verifiedAtMs - input.startedAtMs,
  }
  const rejection = rejectionReason(input, evidence)
  if (rejection)
    return { sample: null, rejection, evidence, assessment: input.assessment, answer: input.answer }
  const outcome = baselineOutcome(input, evidence)
  const sample: BaselineSample = {
    task: input.task,
    engine: input.engine,
    repetition: input.repetition,
    suiteHash: baselineContract().suiteHash,
    taskHash: contractTaskHash(input.task),
    profile: evidence.profile!,
    revision: input.revision,
    artifactHash: fingerprint({
      artifactPass: input.assessment.artifactPass,
      unexpected: input.assessment.unexpected,
      immutable: input.assessment.immutable,
      expected: input.assessment.expected,
      check: input.assessment.check,
    }),
    receiptHash: fingerprint(evidence),
    outcome,
    elapsedMs: evidence.elapsedMs,
    attempts: evidence.attempts.map((attempt) => ({
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      cost: attempt.cost,
    })),
  }
  return { sample, rejection: null, evidence, assessment: input.assessment, answer: input.answer }
}

function rejectionReason(input: FinishedBaselineRun, evidence: BaselineEvidence) {
  if (evidence.revision.length !== 40) return "missing 40-hex source revision"
  if (!evidence.profile) return "missing effective profile fingerprint from provider receipts"
  if (evidence.terminal === null) return `no terminal outcome: ${input.error ?? "unknown"}`
  if (evidence.attempts.length === 0) return "no provider attempt usage was recorded"
  return null
}

function baselineOutcome(input: FinishedBaselineRun, evidence: BaselineEvidence): BaselineSample["outcome"] {
  // Every frozen task ends completed; the interrupted-turn task proves the
  // interruption through its provider.interrupted receipt and its artifact.
  const expected = "completed"
  const receipts = new Set(evidence.receipts)
  const passed =
    evidence.terminal === expected &&
    input.assessment.artifactPass &&
    input.answerContains.every((fragment) => input.answer.includes(fragment)) &&
    input.requiredReceipts.every((name) => receipts.has(name))
  return passed ? "passed" : "failed"
}

function contractTaskHash(task: string) {
  const entry = baselineContract().tasks.find((item) => item.id === task)
  if (!entry) throw new Error(`Unknown baseline task: ${task}`)
  return entry.taskHash
}

/// The engine records a bounded provider error body on the durable result; keep
/// it on the evidence so a failed live run stays diagnosable after the fact.
function providerFailureDetail(events: EngineEvent[]) {
  const messages = events.flatMap((event) => {
    if (event.kind !== "provider.failed") return []
    const data = BlackboxTape.json(event.data)
    return BlackboxTape.isObject(data) && typeof data.message === "string" ? [data.message] : []
  })
  const bodies = events.flatMap((event) => {
    if (event.kind !== "provider.request.result") return []
    const data = BlackboxTape.json(event.data)
    return BlackboxTape.isObject(data) && typeof data.response_body === "string" && data.response_body
      ? [data.response_body]
      : []
  })
  return [...messages.slice(-1), ...bodies.slice(-1)].join(": ").slice(0, 600) || null
}

function terminalFromEvents(events: EngineEvent[]): BaselineEvidence["terminal"] {
  const finished = events.findLast((event) => event.kind === "run.finished")
  const data = finished ? BlackboxTape.json(finished.data) : undefined
  const reason = BlackboxTape.isObject(data) ? data.reason : undefined
  return reason === "completed" || reason === "failed" || reason === "interrupted" ? reason : null
}

function admittedAt(events: EngineEvent[], observed: Map<number, number>) {
  const admitted = events.find((event) => event.kind === "input.admitted")
  if (!admitted) return null
  return admitted.recorded_at_ms ?? observed.get(admitted.seq) ?? null
}

function committedText(events: EngineEvent[]) {
  return events
    .filter((event) => event.kind === "message.committed")
    .flatMap((event) => {
      const data = BlackboxTape.json(event.data)
      if (!BlackboxTape.isObject(data) || data.role !== "assistant" || !Array.isArray(data.content)) return []
      return data.content.flatMap((block) =>
        BlackboxTape.isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
      )
    })
    .join("\n")
}

function usageAttempt(event: EngineEvent): BaselineAttempt[] {
  if (event.kind !== "usage") return []
  const data = BlackboxTape.json(event.data)
  if (!BlackboxTape.isObject(data) || !BlackboxTape.isObject(data.usage)) return []
  const usage = data.usage
  return [
    {
      inputTokens: numberOrNull(usage.inputTokens),
      outputTokens: numberOrNull(usage.outputTokens),
      cacheReadTokens: numberOrNull(usage.cacheReadInputTokens),
      cacheWriteTokens: numberOrNull(usage.cacheWriteInputTokens),
      reasoningTokens: numberOrNull(usage.reasoningTokens),
      cost: null,
    },
  ]
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

/// Loop classification counts: how many provider turns were continued or
/// stopped for a classified reason (empty completion, no progress, budget).
function engineLoops(events: EngineEvent[]) {
  const reason = (event: EngineEvent) => {
    const data = BlackboxTape.json(event.data)
    return BlackboxTape.isObject(data) && typeof data.reason === "string" ? data.reason : "unknown";
  };
  return {
    continuations: events
      .filter((event) => event.kind === "loop.continuation")
      .map(reason),
    stopped: events.filter((event) => event.kind === "loop.stopped").map(reason),
  };
}

function engineReceipts(events: EngineEvent[]) {
  return [
    ...(events.some((event) => event.kind === "permission_denied") ? ["permission.denied"] : []),
    ...(events.some((event) => event.kind === "tool.completed" && toolFailed(event.data)) ? ["tool.error"] : []),
    ...(events.some((event) => event.kind === "provider.interrupted") ? ["provider.interrupted"] : []),
  ]
}

function toolFailed(value: unknown) {
  const data = BlackboxTape.json(value)
  if (!BlackboxTape.isObject(data)) return false
  if (data.is_error === true) return true
  return BlackboxTape.isObject(data.result) && typeof data.result.error === "string"
}

function engineProfile(events: EngineEvent[]) {
  const profiles = events.flatMap((event) => {
    if (event.kind !== "provider.request") return []
    const data = BlackboxTape.json(event.data)
    return BlackboxTape.isObject(data) && BlackboxTape.isObject(data.profile) ? [data.profile] : []
  })
  if (profiles.length === 0) return null
  const normalized = profiles.map(normalizeProfile)
  if (normalized.some((item) => item === null)) return null
  const first = normalized[0]!
  if (!normalized.every((item) => sameProfile(item!, first))) return null
  return { profile: first, receipts: profiles.length }
}

function normalizeProfile(value: Schema.Json | undefined): BaselineSample["profile"] | null {
  if (!BlackboxTape.isObject(value)) return null
  const { model, modelParametersHash, agentManifestHash, permissionHash, toolSurfaceHash } = value
  const hashes = [modelParametersHash, agentManifestHash, permissionHash, toolSurfaceHash]
  if (typeof model !== "string" || !model) return null
  if (!hashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) return null
  return {
    model,
    modelParametersHash: modelParametersHash as string,
    agentManifestHash: agentManifestHash as string,
    permissionHash: permissionHash as string,
    toolSurfaceHash: toolSurfaceHash as string,
  }
}

function sameProfile(left: BaselineSample["profile"], right: BaselineSample["profile"]) {
  return (
    left.model === right.model &&
    left.modelParametersHash === right.modelParametersHash &&
    left.agentManifestHash === right.agentManifestHash &&
    left.permissionHash === right.permissionHash &&
    left.toolSurfaceHash === right.toolSurfaceHash
  )
}

const PHASE_KINDS = new Set([
  "input.admitted",
  "input.promoted",
  "run.started",
  "provider.request",
  "provider.request.result",
  "approval.requested",
  "approval.resolved",
  "tool.dispatched",
  "tool.completed",
  "run.usage",
  "run.finished",
  "stop",
  "provider.interrupted",
])

function enginePhases(
  events: EngineEvent[],
  progress: Array<{ item: EngineProgress; atMs: number }>,
  observed: Map<number, number>,
  verifiedAtMs: number,
): BaselinePhase[] {
  const durable = events
    .filter((event) => PHASE_KINDS.has(event.kind))
    .map((event) => ({
      phase: event.kind,
      atMs: event.recorded_at_ms ?? observed.get(event.seq) ?? Date.now(),
      clock: event.recorded_at_ms === null || event.recorded_at_ms === undefined ? ("observed" as const) : ("recorded" as const),
    }))
  const firstDelta = progress.find((entry) => entry.item.kind === "provider.delta")
  const firstProviderError = progress.find((entry) => entry.item.kind === "runtime.error")
  return [
    ...durable,
    ...(firstDelta ? [{ phase: "first-output", atMs: firstDelta.atMs, clock: "observed" as const }] : []),
    ...(firstProviderError
      ? [{ phase: "runtime.error", atMs: firstProviderError.atMs, clock: "observed" as const }]
      : []),
    { phase: "verified", atMs: verifiedAtMs, clock: "observed" },
  ]
}

/**
 * Raw TCP passthrough in front of the provider. The first request is forwarded
 * untouched; the second one (the turn after the action tool settled) is cut by
 * a FIN as soon as a response item completes, so the engine's HTTP client sees
 * a real body transport error with a partial reply and records
 * provider.interrupted before continuing. Later requests, including the
 * continuation retry, pass through untouched.
 */
export async function startInterruptionProxy(target: string) {
  const url = new URL(target)
  const secure = url.protocol === "https:"
  const port = Number(url.port || (secure ? 443 : 80))
  interface Connection {
    upstream?: Bun.Socket
    ready: boolean
    pending: Buffer[]
    head: Buffer
    headDone: boolean
    armed: boolean
    cut: boolean
    scan: string
  }
  const connections = new Map<Bun.Socket, Connection>()
  // The engine may issue the turns on separate keep-alive connections, so the
  // request ordinal is global to the proxy rather than per connection.
  let requests = 0
  // Exactly one response is ever cut: arming every later connection would break
  // the engine's own continuation request and exhaust its recovery budget.
  let cutDone = false

  const flush = (state: Connection) => {
    if (!state.ready || !state.upstream) return
    for (const buffered of state.pending) state.head = Buffer.concat([state.head, buffered])
    state.pending = []
    forwardHead(state)
  }

  // Bytes stay in Buffers end to end: the head is the only text that changes
  // (the engine dials 127.0.0.1, so its request line and Host must point at the
  // real provider), and a string round-trip would corrupt a non-ASCII body.
  const forwardHead = (state: Connection) => {
    if (!state.upstream || state.headDone) return
    const end = state.head.indexOf("\r\n\r\n")
    if (end < 0) return
    const raw = state.head
    state.head = Buffer.alloc(0)
    const head = raw
      .subarray(0, end)
      .toString("latin1")
      .replace(/^(POST|GET|PUT|DELETE|PATCH) \S+ HTTP\/1\.1/, `$1 ${url.pathname}${url.search} HTTP/1.1`)
      .replace(/\r\nHost: [^\r\n]*/i, `\r\nHost: ${url.host}`)
    state.headDone = true
    state.upstream.write(Buffer.concat([Buffer.from(head, "latin1"), raw.subarray(end)]))
    const heads = head.match(/POST \/\S* HTTP\/1\.1/g)
    if (!heads) return
    requests += heads.length
    if (requests === 2 && !cutDone) state.armed = true
  }

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(client) {
        const state: Connection = {
          ready: false,
          pending: [],
          head: Buffer.alloc(0),
          headDone: false,
          armed: false,
          cut: false,
          scan: "",
        }
        connections.set(client, state)
        await Bun.connect({
          hostname: url.hostname,
          port,
          tls: secure,
          socket: {
            open(upstream) {
              // A TLS write before this callback is dropped by Bun, so the
              // upstream handle is published and the buffer flushed here.
              state.upstream = upstream
              state.ready = true
              flush(state)
            },
            data(source, data) {
              if (!state.armed || state.cut) {
                client.write(data)
                return
              }
              state.scan = (state.scan + Buffer.from(data).toString("latin1")).slice(-16384)
              client.write(data)
              // The continuation contract needs every parsed item finalized and
              // a non-empty partial reply; the first completed output item is
              // the only window that guarantees both, so cut right after it.
              if (!state.scan.includes('"type":"response.output_item.done"')) return
              state.cut = true
              cutDone = true
              client.end()
              source.end()
            },
            close() {
              client.end()
            },
            error() {
              client.end()
            },
          },
        })
      },
      data(client, data) {
        const state = connections.get(client)
        if (!state) return
        if (!state.ready || !state.upstream) {
          state.pending.push(Buffer.from(data))
          return
        }
        if (state.headDone) {
          state.upstream.write(data)
          return
        }
        state.head = Buffer.concat([state.head, Buffer.from(data)])
        forwardHead(state)
      },
      close(client) {
        const state = connections.get(client)
        connections.delete(client)
        state?.upstream?.end()
      },
      error(client) {
        const state = connections.get(client)
        connections.delete(client)
        state?.upstream?.end()
      },
    },
  })
  return { endpoint: `http://127.0.0.1:${server.port}/responses`, stop: () => server.stop(true) }
}

async function seedSharedCredentials(source: string, target: string) {
  const origin = new Database(source, { readonly: true })
  const rows = origin
    .query<
      {
        id: string
        integration_id: string
        label: string
        value: string
        connector_id: string | null
        method_id: string | null
        active: number | null
        time_created: number
        time_updated: number
      },
      []
    >(
      "SELECT id,integration_id,label,value,connector_id,method_id,active,time_created,time_updated FROM credential WHERE integration_id IS NOT NULL",
    )
    .all()
  origin.close()
  const shared = new Database(target, { create: true })
  shared.run(`CREATE TABLE credential (
    id text primary key,
    integration_id text,
    label text not null,
    value text not null,
    connector_id text,
    method_id text,
    active integer,
    time_created integer not null,
    time_updated integer not null
  )`)
  const insert = shared.prepare(
    "INSERT INTO credential (id,integration_id,label,value,connector_id,method_id,active,time_created,time_updated) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
  )
  for (const row of rows)
    insert.run(
      row.id,
      row.integration_id,
      row.label,
      row.value,
      row.connector_id,
      row.method_id,
      row.active,
      row.time_created,
      row.time_updated,
    )
  shared.close()
  await chmod(target, 0o600)
}

function tsConfig() {
  return JSON.stringify({
    // evaluate() lets the last matching rule decide, so the deny comes last.
    permissions: [
      { action: "*", resource: "**", effect: "allow" },
      { action: "*", resource: "protected/**", effect: "deny" },
    ],
  })
}

/**
 * The baseline permission contract: workspace writes and processes are allowed,
 * anything touching `protected/**` is denied. Symmetric with the TypeScript
 * ruleset, and written outside the workspace so it cannot count as an artifact.
 */
async function writeBaselinePolicy(root: string) {
  const file = path.join(root, "policy.json")
  await Bun.write(
    file,
    JSON.stringify(
      {
        mode: "workspace",
        allow_process: true,
        allow_background: true,
        allow_subagents: true,
        process_network: true,
        rules: [
          { tool: "*", path: "protected/**", decision: "deny" },
          { tool: "*", path: "**", decision: "allow" },
        ],
      },
      null,
      2,
    ) + "\n",
  )
  return file
}

async function readJsonLines(
  stream: ReadableStream<Uint8Array>,
  handle: (message: Record<string, Schema.Json>) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf("\n")
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) {
        const message = BlackboxTape.json(JSON.parse(line))
        if (BlackboxTape.isObject(message)) handle(message)
      }
      index = buffer.indexOf("\n")
    }
  }
}

function actionTool(message: Record<string, Schema.Json>) {
  if (message.type !== "tool_use") return false
  const part = message.part
  if (!BlackboxTape.isObject(part) || part.tool !== "bash" || !BlackboxTape.isObject(part.state)) return false
  if (part.state.status !== "completed" && part.state.status !== "error") return false
  return JSON.stringify(part.state.input ?? null).includes("action.ts")
}

function tsToolError(message: Record<string, Schema.Json>) {
  if (message.type !== "tool_use") return false
  const part = message.part
  return BlackboxTape.isObject(part) && BlackboxTape.isObject(part.state) && part.state.status === "error"
}

function tsPermissionDenied(parts: Array<Record<string, Schema.Json>>, stderr: string) {
  const denied = (value: unknown) => {
    if (typeof value !== "string") return false
    return /permission denied|denied by|rejected by the user|denied/i.test(value)
  }
  return parts.some((message) => {
    const part = message.part
    if (!BlackboxTape.isObject(part) || !BlackboxTape.isObject(part.state)) return false
    return denied(part.state.error)
  }) || denied(stderr)
}

function interactionAttempt(interaction: BlackboxTape.Interaction): BaselineAttempt {
  const usage = interaction.frames
    .flatMap((frame) => {
      if (!BlackboxTape.isObject(frame.value)) return []
      const record = frame.value
      if (record.type !== "finish" && record.type !== "step-finish") return []
      return BlackboxTape.isObject(record.usage) ? [record.usage] : []
    })
    .at(-1)
  if (!usage)
    return {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      cost: null,
    }
  return {
    inputTokens: numberOrNull(usage.inputTokens),
    outputTokens: numberOrNull(usage.outputTokens),
    cacheReadTokens: numberOrNull(usage.cacheReadInputTokens),
    cacheWriteTokens: numberOrNull(usage.cacheWriteInputTokens),
    reasoningTokens: numberOrNull(usage.reasoningTokens),
    cost: null,
  }
}

function tsProfile(interactions: ReadonlyArray<BlackboxTape.Interaction>) {
  const requests = interactions
    .filter((interaction) => interaction.lane === "llm")
    .flatMap((interaction) => (BlackboxTape.isObject(interaction.request) ? [interaction.request] : []))
  if (requests.length === 0) return null
  const normalized = requests.map((request) => {
    if (!BlackboxTape.isObject(request.model) || typeof request.model.id !== "string") return null
    const execution = BlackboxTape.isObject(request.execution) ? request.execution : {}
    return normalizeProfile({
      model: request.model.id,
      modelParametersHash: fingerprint({
        protocol: "openai-responses",
        parameters: {
          generation: request.generation ?? null,
          providerOptions: request.providerOptions ?? null,
          responseFormat: request.responseFormat ?? null,
          cache: request.cache ?? null,
          toolChoice: request.toolChoice ?? null,
        },
      }),
      agentManifestHash: execution.agentManifestHash ?? null,
      permissionHash: execution.permissionHash ?? null,
      toolSurfaceHash: fingerprint({
        protocol: "openai-responses",
        present: "tools" in request,
        tools: request.tools ?? null,
      }),
    })
  })
  if (normalized.some((item) => item === null)) return null
  const first = normalized[0]!
  if (!normalized.every((item) => sameProfile(item!, first))) return null
  return { profile: first, receipts: requests.length }
}

function tsPhases(
  parts: Array<Record<string, Schema.Json>>,
  exitAtMs: number,
  verifiedAtMs: number,
): BaselinePhase[] {
  const observed = parts.flatMap((message) => {
    if (typeof message.timestamp !== "number") return []
    const part = message.part
    const phase =
      message.type === "step_start"
        ? "step-start"
        : BlackboxTape.isObject(part) && part.type === "tool"
          ? "tool-part"
          : "first-output"
    return [{ phase, atMs: message.timestamp, clock: "observed" as const }]
  })
  return [
    ...observed,
    { phase: "exit", atMs: exitAtMs, clock: "observed" },
    { phase: "verified", atMs: verifiedAtMs, clock: "observed" },
  ]
}