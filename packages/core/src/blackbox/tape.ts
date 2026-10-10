export * as BlackboxTape from "./tape"

import { mkdir, open, rename } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"

export const Frame = Schema.Struct({ elapsedMs: Schema.Number, value: Schema.Json })
export const Interaction = Schema.Struct({
  lane: Schema.String,
  ordinal: Schema.Number,
  request: Schema.Json,
  frames: Schema.Array(Frame),
  outcome: Schema.Literals(["complete", "error", "cancelled", "incomplete"]),
  endElapsedMs: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.Json),
})
export type Interaction = typeof Interaction.Type
export const Trace = Schema.Struct({
  session: Schema.String,
  kind: Schema.String,
  data: Schema.Json,
  recordedAtMs: Schema.NullOr(Schema.Number),
})
export type Trace = typeof Trace.Type
export const Bundle = Schema.Struct({
  format: Schema.Literal("miao-blackbox"),
  version: Schema.Literal(1),
  metadata: Schema.Record(Schema.String, Schema.Json),
  interactions: Schema.Array(Interaction),
  trace: Schema.Array(Trace),
})
export type Bundle = typeof Bundle.Type
export const Envelope = Schema.Struct({ bundle: Bundle, sha256: Schema.String })

/** Object key order is irrelevant; arrays and every scalar remain significant. */
export function canonical(value: Schema.Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value)
}

export function json(value: unknown): Schema.Json {
  return Schema.decodeUnknownSync(Schema.Json)(value)
}

export function digest(bundle: Bundle) {
  return new Bun.CryptoHasher("sha256").update(canonical(json(bundle))).digest("hex")
}

export async function load(file: string): Promise<Bundle> {
  const envelope = Schema.decodeUnknownSync(Envelope)(await Bun.file(file).json())
  if (digest(envelope.bundle) !== envelope.sha256) throw new Error("Blackbox integrity check failed")
  const ordinals = new Map<string, number>()
  for (const interaction of envelope.bundle.interactions) {
    const ordinal = ordinals.get(interaction.lane) ?? 0
    if (interaction.ordinal !== ordinal) throw new Error("Blackbox lane order is invalid")
    ordinals.set(interaction.lane, ordinal + 1)
    if (
      interaction.frames.some(
        (frame, index) =>
          !Number.isFinite(frame.elapsedMs) ||
          frame.elapsedMs < 0 ||
          (index > 0 && frame.elapsedMs < interaction.frames[index - 1].elapsedMs),
      )
    )
      throw new Error("Blackbox frame timing is invalid")
  }
  if (
    envelope.bundle.interactions.some(
      (item) =>
        item.endElapsedMs !== undefined &&
        (!Number.isFinite(item.endElapsedMs) ||
          item.endElapsedMs < 0 ||
          item.endElapsedMs < (item.frames.at(-1)?.elapsedMs ?? 0)),
    )
  )
    throw new Error("Blackbox terminal timing is invalid")
  return envelope.bundle
}

type MutableInteraction = {
  lane: string
  ordinal: number
  request: Schema.Json
  frames: Array<{ elapsedMs: number; value: Schema.Json }>
  outcome: Interaction["outcome"]
  endElapsedMs?: number
  error?: Schema.Json
}

/** Each boundary is saved before executing its side effect. A crash leaves an
 * explicit incomplete interaction, which replay refuses to treat as success. */
export class Recorder {
  readonly bundle: {
    format: "miao-blackbox"
    version: 1
    metadata: Record<string, Schema.Json>
    interactions: MutableInteraction[]
    trace: Trace[]
  }
  #writes = Promise.resolve()

  constructor(
    readonly file: string,
    metadata: Record<string, Schema.Json>,
  ) {
    this.bundle = { format: "miao-blackbox", version: 1, metadata, interactions: [], trace: [] }
  }

  async begin(lane: string, request: Schema.Json) {
    const interaction: MutableInteraction = {
      lane,
      ordinal: this.bundle.interactions.filter((item) => item.lane === lane).length,
      request: clone(request),
      frames: [],
      outcome: "incomplete",
    }
    this.bundle.interactions.push(interaction)
    await this.save()
    const started = performance.now()
    return {
      frame: async (value: Schema.Json) => {
        if (interaction.outcome !== "incomplete") throw new Error("Blackbox interaction already settled")
        interaction.frames.push({ elapsedMs: performance.now() - started, value: clone(value) })
        await this.save()
      },
      finish: async (outcome: "complete" | "error" | "cancelled", error?: Schema.Json) => {
        if (interaction.outcome !== "incomplete") throw new Error("Blackbox interaction already settled")
        interaction.outcome = outcome
        interaction.endElapsedMs = performance.now() - started
        if (error !== undefined) interaction.error = json(error)
        await this.save()
      },
    }
  }

  async trace(event: Trace) {
    this.bundle.trace.push(Schema.decodeUnknownSync(Trace)({ ...event, data: clone(event.data) }))
    await this.save()
  }

  save(): Promise<void> {
    // Snapshot before queueing so writers cannot serialize a later mutation.
    const bundle = Schema.decodeUnknownSync(Bundle)(this.bundle)
    const data = JSON.stringify({ bundle, sha256: digest(bundle) })
    const write = this.#writes.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${crypto.randomUUID()}.tmp`
      const handle = await open(temporary, "wx", 0o600)
      try {
        await handle.writeFile(data)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, this.file)
    })
    this.#writes = write
    return write
  }
}

export class Mismatch extends Error {
  constructor(
    readonly lane: string,
    readonly ordinal: number,
    readonly expected: Schema.Json | undefined,
    readonly actual: Schema.Json,
  ) {
    super(`Blackbox request mismatch at ${lane}[${ordinal}]`)
  }
}

/** One replay cursor per causal lane. No fallback to live IO, no searching ahead. */
export class Replay {
  #positions = new Map<string, number>()
  #traces = new Map<string, number>()
  #failure: Error | undefined
  constructor(readonly bundle: Bundle) {}

  take(lane: string, request: Schema.Json): Interaction {
    if (this.#failure) throw this.#failure
    const ordinal = this.#positions.get(lane) ?? 0
    const recorded = this.bundle.interactions.filter((item) => item.lane === lane)[ordinal]
    if (!recorded || canonical(recorded.request) !== canonical(request)) {
      this.#failure = new Mismatch(lane, ordinal, recorded?.request, request)
      throw this.#failure
    }
    if (recorded.outcome === "incomplete") {
      this.#failure = new Error(`Incomplete blackbox interaction at ${lane}[${ordinal}]`)
      throw this.#failure
    }
    this.#positions.set(lane, ordinal + 1)
    return recorded
  }

  assertConsumed() {
    if (this.#failure) throw this.#failure
    const missing = this.bundle.interactions.find((item) => item.ordinal >= (this.#positions.get(item.lane) ?? 0))
    if (missing) throw new Error(`Unconsumed blackbox interaction at ${missing.lane}[${missing.ordinal}]`)
    const trace = this.bundle.trace.find(
      (item) =>
        this.bundle.trace.filter((event) => event.session === item.session).indexOf(item) >=
        (this.#traces.get(item.session) ?? 0),
    )
    if (trace) throw new Error(`Unconsumed blackbox trace for ${trace.session}`)
  }

  expectTrace(session: string, kind: string, data: Schema.Json) {
    if (this.#failure) throw this.#failure
    const ordinal = this.#traces.get(session) ?? 0
    const expected = this.bundle.trace.filter((event) => event.session === session)[ordinal]
    const actual = { kind, data }
    if (!expected || canonical({ kind: expected.kind, data: expected.data }) !== canonical(actual)) {
      this.#failure = new Mismatch(
        `trace:${session}`,
        ordinal,
        expected ? { kind: expected.kind, data: expected.data } : undefined,
        actual,
      )
      throw this.#failure
    }
    this.#traces.set(session, ordinal + 1)
  }

  /** Generic tool/approval boundary. The live callback is never invoked. */
  async call(lane: string, request: Schema.Json): Promise<Schema.Json> {
    const recorded = this.take(lane, request)
    if (recorded.outcome !== "complete") throw new Error(`Recorded ${recorded.outcome} at ${lane}[${recorded.ordinal}]`)
    if (recorded.frames.length !== 1) throw new Error("Blackbox call must contain exactly one result")
    return recorded.frames[0].value
  }
}

export async function recordCall(
  recorder: Recorder,
  lane: string,
  request: Schema.Json,
  run: () => Promise<Schema.Json>,
) {
  const ticket = await recorder.begin(lane, request)
  const value = await run().catch(async (error: unknown) => {
    await ticket.finish("error", { message: "Boundary execution failed" })
    throw error
  })
  await ticket.frame(value)
  await ticket.finish("complete")
  return value
}

export function isObject(value: Schema.Json | undefined): value is Record<string, Schema.Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function clone(value: Schema.Json) {
  return json(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(canonical(value)))
}
