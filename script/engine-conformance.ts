#!/usr/bin/env bun
/**
 * Functional conformance suite: TypeScript runner vs Rust (native) engine.
 *
 * Companion to script/engine-benchmark.ts (cost/quality). Here every scenario
 * asserts a STRUCTURAL outcome - a tool executed, a file changed, a sqlite row
 * exists - never the exact reply text. Each cell runs in a fresh temp
 * workspace through `miao run --format json`; rust cells place the engine by
 * setting MIAO_ENGINE_STORAGE (credential env must already be present, e.g.
 * `source ~/.config/miao/engine-on.sh`), ts cells delete it.
 *
 * Usage:
 *   source ~/.config/miao/engine-on.sh
 *   bun script/engine-conformance.ts [--binary miao-dev] [--models a/b,c/d]
 *       [--scenarios id,id] [--engines ts,rust] [--storage DIR] [--data DIR]
 *       [--max-cost 3] [--segment-timeout 420]
 *
 * Raw evidence (redacted) lands in <data>/raw/, a machine-readable summary in
 * <data>/results.json. Secrets from the engine credential environment are
 * redacted from every archive; they are never printed.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { Database } from "bun:sqlite"

const PRIMARY = "zhipuai-coding-plan/glm-5.3-flash"
const VISION = "zhipuai-coding-plan/glm-4.6v"
const TOKEN = "MIAO-CONFORMANCE-7391"
const DEFAULT_TITLE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const CREDENTIAL_ERROR = /model not found|unauthorized|401|403|invalid api key|credential|authentication/i

type Engine = "ts" | "rust"

type ToolCall = { tool: string; status?: string; error?: string; command?: string; background?: boolean }

type SegmentRecord = {
  prompt: string
  resume: boolean
  exitCode: number | null
  seconds: number
  killed: boolean
  timedOut: boolean
  rawLines: string[]
  noise: string[]
  stderr: string
  text: string
  events: Record<string, unknown>[]
}

type Ctx = {
  engine: Engine
  model: string
  workspace: string
  storageDir: string
  productDbPath: string
  segments: SegmentRecord[]
  text: string
  tools: ToolCall[]
  sessionID?: string
  cost: number
  tokensIn: number
  tokensOut: number
  stepFinishes: number
  errors: string[]
}

type Outcome =
  | { status: "pass"; note?: string }
  | { status: "fail"; reason: string }
  | { status: "skip"; reason: string }

const pass = (note?: string): Outcome => ({ status: "pass", note })
const fail = (reason: string): Outcome => ({ status: "fail", reason })

type Scenario = {
  id: string
  title: string
  files?: () => Record<string, string | Uint8Array>
  attachments?: string[]
  config?: {
    permissions?: { action: string; resource: string; effect: string }[]
    agents?: Record<string, { model?: string }>
    mcp?: boolean
  }
  env?: (workspace: string) => Record<string, string>
  models?: "matrix" | "primary" | "vision"
  engines?: Engine[]
  prompt: string
  followUps?: string[]
  interruptAfterSeconds?: number
  assert: (ctx: Ctx) => Outcome | Promise<Outcome>
}

const field = (value: unknown, key: string): unknown => {
  if (typeof value !== "object" || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

const asText = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const DICE_SERVER = `import { createInterface } from "node:readline"
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n")
createInterface({ input: process.stdin }).on("line", (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === "initialize")
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "dice", version: "1.0.0" } } })
  else if (msg.method === "tools/list")
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{
      name: "roll_dice",
      description: "Roll a six-sided die. This conformance fixture always returns 4.",
      inputSchema: { type: "object", properties: {} } }] } })
  else if (msg.method === "tools/call")
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "4" }] } })
})
`

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

const crc32 = (buf: Uint8Array) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const pngChunk = (type: string, data: Uint8Array) => {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const typeBytes = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])))
  return Buffer.concat([head, typeBytes, Buffer.from(data), crc])
}

const solidPng = (red: number, green: number, blue: number, size = 32) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.alloc(1 + size * 3)
  for (let i = 0; i < size; i++) {
    row[1 + i * 3] = red
    row[2 + i * 3] = green
    row[3 + i * 3] = blue
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ])
}

const largeTextFile = () => {
  const words = ["alpha", "bravo", "delta", "echo", "forge", "granite", "harbor", "ivory", "jasper", "kernel"]
  const lines: string[] = []
  for (let i = 0; i < 900; i++) {
    const picked = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => words[(i * 7 + k * 3) % words.length])
    lines.push(`${String(i + 1).padStart(4, "0")} ${picked.join(" ")}`)
  }
  lines.push("TAIL-MARKER-7391 end-of-file")
  return `${lines.join("\n")}\n`
}

const completedRun = (ctx: Ctx) => {
  const last = ctx.segments.at(-1)
  return last !== undefined && last.exitCode === 0 && !last.timedOut && ctx.stepFinishes > 0
}

const toolRan = (ctx: Ctx, name: RegExp, status = "completed") =>
  ctx.tools.some((call) => name.test(call.tool) && call.status === status)

const readWorkspace = async (ctx: Ctx, relative: string) =>
  readFile(path.join(ctx.workspace, relative), "utf8").catch(() => undefined)

const queryOne = <T>(file: string, sql: string, ...params: unknown[]): T | undefined => {
  const db = new Database(file, { readonly: true })
  try {
    return db.query(sql).get(...params) as T | undefined
  } finally {
    db.close()
  }
}

const newestEngineDb = async (dir: string) => {
  const entries = await readdir(dir).catch(() => [])
  const stampeds = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".db"))
      .map(async (name) => ({ name, mtime: (await stat(path.join(dir, name))).mtimeMs })),
  )
  const newest = stampeds.sort((a, b) => b.mtime - a.mtime)[0]
  return newest === undefined ? undefined : path.join(dir, newest.name)
}

const sessionTitle = async (ctx: Ctx) => {
  try {
    const file = ctx.engine === "rust" ? await newestEngineDb(ctx.storageDir) : ctx.productDbPath
    if (!file) return
    return queryOne<{ title: string }>(
      file,
      `SELECT title FROM ${ctx.engine === "rust" ? "engine_session" : "session"} WHERE id = ?`,
      ctx.sessionID,
    )?.title
  } catch {
    return undefined
  }
}

const waitFor = async (probe: () => boolean | Promise<boolean>, budgetMs: number, gapMs = 2000) => {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (await probe()) return true
    if (Date.now() >= deadline) return false
    await Bun.sleep(gapMs)
  }
}

const SCENARIOS: Scenario[] = [
  {
    id: "tool-recall",
    title: "bash tool executes and reply carries its output",
    prompt: `Run this exact bash command: echo ${TOKEN} — then reply with the exact token it printed.`,
    assert: (ctx) => {
      if (!ctx.text.includes(TOKEN)) return fail(`reply does not contain ${TOKEN}`)
      if (!toolRan(ctx, /^bash$/)) return fail("no completed bash tool execution in events")
      return pass()
    },
  },
  {
    id: "file-edit",
    title: "edit tool changes a seeded file",
    files: () => ({ "src/note.ts": `export const note = "alpha"\n` }),
    prompt: `In src/note.ts, change the string "alpha" to "beta". Use the edit tool rather than recreating the file.`,
    assert: async (ctx) => {
      const content = await readWorkspace(ctx, "src/note.ts")
      if (content === undefined) return fail("src/note.ts missing after run")
      if (!content.includes(`"beta"`)) return fail(`file not updated to beta: ${JSON.stringify(content)}`)
      if (content.includes("alpha")) return fail("file still contains alpha")
      if (
        !ctx.tools.some((call) => /^(edit|write|apply_patch|multiedit)$/.test(call.tool) && call.status === "completed")
      )
        return fail("no completed file-mutating tool in events")
      return pass()
    },
  },
  {
    id: "apply-patch",
    title: "apply_patch tool appends a line",
    files: () => ({ "notes.md": "line-one\nline-two\n" }),
    prompt: `Use the apply_patch tool to append a new line reading patched-line-7391 to the end of notes.md. Do not modify the file any other way.`,
    assert: async (ctx) => {
      const content = await readWorkspace(ctx, "notes.md")
      if (content === undefined || !content.includes("patched-line-7391"))
        return fail("appended line missing from notes.md")
      if (!toolRan(ctx, /^apply_patch$/)) return fail("no completed apply_patch execution in events")
      return pass()
    },
  },
  {
    id: "multi-turn-retention",
    title: "--continue recalls a fact from turn 1",
    prompt: `Remember this magic word for the rest of this session: ${TOKEN}. Do not write any files; just reply ok.`,
    followUps: ["What was the magic word I asked you to remember? Reply with only the word."],
    assert: (ctx) => {
      const resumed = ctx.segments.filter((segment) => segment.resume).at(-1)
      if (resumed === undefined) return fail("no follow-up segment ran")
      if (!resumed.text.includes(TOKEN))
        return fail(`follow-up reply does not recall ${TOKEN}: ${resumed.text.slice(0, 200)}`)
      return pass()
    },
  },
  {
    id: "forced-compaction",
    title: "tiny context window triggers engine compaction (rust-focused)",
    env: () => ({ MIAO_CONTEXT_LIMITS: '{"window":4000,"ratio":0.6,"headroom":1000,"perPass":2}' }),
    files: () => ({ "data/large.txt": largeTextFile() }),
    prompt: `Read data/large.txt in full - it is large, so read it in chunks until you have seen every line including the last. Then reply with a two-sentence summary of what the file contains and the exact value of the TAIL marker on its final line.`,
    assert: async (ctx) => {
      if (!completedRun(ctx)) return fail(`run did not complete: ${ctx.errors.join(" | ").slice(0, 400)}`)
      if (ctx.engine === "ts") return pass("completion-only; the compaction-row assert is rust-only (tsEquivalent n/a)")
      const dbPath = await newestEngineDb(ctx.storageDir)
      if (dbPath === undefined) return fail(`no engine db found under ${ctx.storageDir}`)
      const row = queryOne<{ n: number }>(
        dbPath,
        "SELECT COUNT(*) AS n FROM engine_compaction WHERE session_id = ?",
        ctx.sessionID,
      )
      return (row?.n ?? 0) > 0
        ? pass(`engine_compaction rows: ${row?.n} (db ${path.basename(dbPath)})`)
        : fail(`engine_compaction empty in ${path.basename(dbPath)}`)
    },
  },
  {
    id: "interrupt-recovery",
    title: "SIGKILL mid-run, resume finishes without duplicate append",
    interruptAfterSeconds: 6,
    prompt: `Run this bash command exactly once in the foreground and wait for it to finish before replying: sleep 25 && echo INTERRUPT-RECOVERY-7391 >> marker.txt - then reply done.`,
    followUps: [
      `The previous run of this session was interrupted while a command was still pending. Check marker.txt in this directory: if it already contains the line INTERRUPT-RECOVERY-7391, just reply done. Otherwise wait (you may poll for up to 40 seconds) for that line to appear; only if it has still not appeared by then, append it yourself with a single echo command. Reply done once marker.txt contains exactly that one line.`,
    ],
    assert: async (ctx) => {
      if (!completedRun(ctx)) return fail(`resume segment did not complete: ${ctx.errors.join(" | ").slice(0, 400)}`)
      const content = await readWorkspace(ctx, "marker.txt")
      if (content === undefined) return fail("marker.txt was never created")
      const lines = content.trim().split("\n").filter(Boolean)
      if (lines.length !== 1 || !lines[0]!.includes("INTERRUPT-RECOVERY-7391"))
        return fail(
          `marker.txt has ${lines.length} line(s), expected exactly one: ${JSON.stringify(content.slice(0, 200))}`,
        )
      return pass()
    },
  },
  {
    id: "background-job",
    title: "run_in_background bash job observed via job_list",
    prompt: `Start a background bash job that runs: sleep 2 (use the bash tool with run_in_background=true). Then use the job_list tool to check it, and reply with the job's final status.`,
    assert: (ctx) => {
      if (!ctx.tools.some((call) => call.tool === "bash" && call.background === true))
        return fail("no bash execution with run_in_background=true in events")
      if (!toolRan(ctx, /^job_list$/)) return fail("job_list tool never executed")
      return pass()
    },
  },
  {
    id: "mcp-fixture",
    title: "project-level stdio MCP server tool executes",
    config: { mcp: true },
    env: (workspace) => ({
      MIAO_ENGINE_MCP_CONFIG: `${workspace}-engine/dice-engine-mcp.json`,
      MIAO_ENGINE_POLICY: `${workspace}-engine/engine-policy.json`,
    }),
    prompt: `Use the dice MCP server's roll_dice tool to roll the dice, then reply with the number you got.`,
    assert: (ctx) => {
      if (!toolRan(ctx, /^mcp__dice__roll_dice$/))
        return fail("mcp__dice__roll_dice never completed; tools seen: " + ctx.tools.map((call) => call.tool).join(","))
      if (!ctx.text.includes("4")) return fail("reply does not report the fixed roll 4")
      return pass()
    },
  },
  {
    id: "permission-deny",
    title: "project deny rule blocks rm and the file survives",
    config: { permissions: [{ action: "bash", resource: "rm *", effect: "deny" }] },
    files: () => ({ "deleteme.txt": "delete me\n" }),
    prompt: `Delete the file deleteme.txt in this directory by running the shell command: rm deleteme.txt`,
    assert: async (ctx) => {
      const content = await readWorkspace(ctx, "deleteme.txt")
      if (content === undefined) return fail("deleteme.txt was deleted despite the deny rule")
      const attempts = ctx.tools.filter((call) => call.tool === "bash" && (call.command ?? "").includes("rm"))
      if (attempts.length === 0) return fail("no bash attempt naming rm found in events")
      if (!attempts.some((call) => call.status === "error"))
        return fail("the rm command did not end in an errored tool state: " + JSON.stringify(attempts))
      if (ctx.segments.some((segment) => segment.noise.some((line) => line.includes("permission requested"))))
        return fail("an interactive permission ask fired (auto-rejected) instead of the deny rule deciding")
      return pass()
    },
  },
  {
    id: "usage-priced",
    title: "turn is priced: step cost > 0 and usage row recorded",
    models: "primary",
    prompt: `What is 2+2? Reply with just the number.`,
    assert: async (ctx) => {
      if (ctx.sessionID === undefined) return fail("no sessionID in events")
      if (!(ctx.cost > 0)) return fail(`total step cost is ${ctx.cost}, expected > 0`)
      const file = ctx.engine === "rust" ? await newestEngineDb(ctx.storageDir) : ctx.productDbPath
      if (!file) return fail("no authoritative usage database")
      const row = queryOne<{ n: number }>(
        file,
        ctx.engine === "rust"
          ? "SELECT COUNT(*) AS n FROM engine_event WHERE session_id = ? AND kind = 'usage'"
          : "SELECT COUNT(*) AS n FROM session_turn_usage WHERE session_id = ?",
        ctx.sessionID,
      )
      if ((row?.n ?? 0) === 0) return fail(`no durable usage row for ${ctx.sessionID}`)
      return pass()
    },
  },
  {
    id: "session-title",
    title: "session title leaves the default after exchange 1",
    config: { agents: { title: { model: PRIMARY } } },
    prompt: `Reply with exactly: conformance-title-check`,
    assert: async (ctx) => {
      if (ctx.sessionID === undefined) return fail("no sessionID in events")
      const settled = await waitFor(async () => {
        const title = await sessionTitle(ctx)
        return title !== undefined && title.length > 0 && !DEFAULT_TITLE.test(title)
      }, 30_000)
      const title = await sessionTitle(ctx)
      return settled ? pass(`title: ${title}`) : fail(`title still default or missing after 30s: ${title ?? "<none>"}`)
    },
  },
  {
    id: "image-input",
    title: "32x32 red png recognized by a vision model",
    models: "vision",
    files: () => ({ "image.png": solidPng(255, 0, 0) }),
    attachments: ["image.png"],
    prompt: `A tiny image is attached. What is its dominant color? Answer with a single color word.`,
    assert: (ctx) => {
      if (!completedRun(ctx)) return fail(`run did not complete: ${ctx.errors.join(" | ").slice(0, 400)}`)
      if (!/red/i.test(ctx.text)) return fail(`reply does not name red: ${ctx.text.slice(0, 200)}`)
      return pass()
    },
  },
]

type ParsedArgs = {
  binary: string
  models: string[]
  scenarios: string[]
  engines: Engine[]
  storage: string
  data: string
  maxCost: number
  segmentTimeout: number
}

const argv = () => {
  const index = Bun.argv.indexOf("--")
  return Bun.argv.slice(index > -1 ? index + 1 : 2)
}

const parse = {
  string: (flag: string) => {
    const rest = argv()
    const index = rest.indexOf(flag)
    return index === -1 ? undefined : rest[index + 1]
  },
  number: (flag: string, fallback: number) => {
    const value = parse.string(flag)
    return value === undefined || Number.isNaN(Number(value)) ? fallback : Number(value)
  },
  list: (flag: string, fallback: string[]) => {
    const value = parse.string(flag)
    return value === undefined ? fallback : value.split(",").filter(Boolean)
  },
}

const options: ParsedArgs = {
  binary: parse.string("--binary") ?? "miao-dev",
  models: parse.list("--models", [PRIMARY]),
  scenarios: parse.list(
    "--scenarios",
    SCENARIOS.map((scenario) => scenario.id),
  ),
  engines: parse
    .list("--engines", ["ts", "rust"])
    .filter((engine): engine is Engine => engine === "ts" || engine === "rust"),
  storage: parse.string("--storage") ?? path.join(os.tmpdir(), "miao-conformance-storage"),
  data: parse.string("--data") ?? "docs/experiments/2026-10-24-engine-conformance",
  maxCost: parse.number("--max-cost", 3),
  segmentTimeout: parse.number("--segment-timeout", 420),
}

const secretValues = [
  "MIAO_ENGINE_CREDENTIAL_DB",
  "MIAO_ENGINE_CREDENTIAL_ID",
  "MIAO_ENGINE_CREDENTIAL_INTEGRATION",
  "MIAO_ENGINE_ENDPOINT",
  "MIAO_ENGINE_STORAGE",
  "MIAO_ENGINE_MODEL_ROUTES_CONFIG",
]
  .map((key) => process.env[key])
  .filter((value): value is string => Boolean(value && value.length > 3))

const redact = (input: string) => {
  let out = input
  for (const secret of secretValues) out = out.split(secret).join("[redacted]")
  return out
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
}

const runSegment = async (input: {
  binary: string
  engine: Engine
  cwd: string
  model?: string
  prompt: string
  resume: boolean
  attachments: string[]
  env: Record<string, string>
  interruptAfterSeconds?: number
  timeoutSeconds: number
}): Promise<SegmentRecord> => {
  const args = [
    input.binary,
    "run",
    "--format",
    "json",
    "--engine",
    input.engine === "rust" ? "native" : "ts",
    // Bun's cwd does not update inherited PWD, which the CLI uses for local
    // placement. Bind the run explicitly to its isolated fixture workspace.
    "--dir",
    input.cwd,
    ...(input.model ? ["--model", input.model] : []),
    ...(input.resume ? ["--continue"] : []),
    input.prompt,
    ...input.attachments.flatMap((file) => [`--file=${file}`]),
  ]
  const child = Bun.spawn(args, { cwd: input.cwd, stdout: "pipe", stderr: "pipe", env: input.env })
  const stderr = new Response(child.stderr).text()
  const record: SegmentRecord = {
    prompt: input.prompt,
    resume: input.resume,
    exitCode: null,
    seconds: 0,
    killed: false,
    timedOut: false,
    rawLines: [],
    noise: [],
    stderr: "",
    text: "",
    events: [],
  }
  const started = Date.now()
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let interrupted = false
  let timedOut = false
  const interruptTimer =
    input.interruptAfterSeconds === undefined
      ? undefined
      : setTimeout(() => {
          interrupted = true
          child.kill(9)
        }, input.interruptAfterSeconds * 1000)
  const timeoutTimer = setTimeout(() => {
    timedOut = true
    child.kill(9)
  }, input.timeoutSeconds * 1000)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf("\n")
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length === 0) {
        index = buffer.indexOf("\n")
        continue
      }
      const safe = redact(line)
      if (safe.startsWith("{")) {
        record.rawLines.push(safe)
        try {
          record.events.push(JSON.parse(safe))
        } catch {}
      } else record.noise.push(safe)
      index = buffer.indexOf("\n")
    }
  }
  if (interruptTimer !== undefined) clearTimeout(interruptTimer)
  clearTimeout(timeoutTimer)
  const [exitCode, diagnostics] = await Promise.all([child.exited, stderr])
  record.exitCode = exitCode
  record.seconds = (Date.now() - started) / 1000
  record.stderr = redact(diagnostics)
  record.killed = interrupted
  record.timedOut = timedOut
  return record
}

const segmentsFor = (scenario: Scenario) => {
  const segments: { text: string; resume: boolean; killAfterSeconds?: number }[] = [
    { text: scenario.prompt, resume: false },
  ]
  for (const follow of scenario.followUps ?? []) segments.push({ text: follow, resume: true })
  if (scenario.interruptAfterSeconds !== undefined) segments[0]!.killAfterSeconds = scenario.interruptAfterSeconds
  return segments
}

const harvest = (ctx: Ctx, segment: SegmentRecord) => {
  for (const event of segment.events) {
    const type = asText(event.type) ?? ""
    if (type === "error") {
      const error = field(event, "error") ?? field(event, "issue")
      const message = asText(field(error, "message")) ?? asText(field(error, "name")) ?? asText(field(event, "message"))
      if (message) ctx.errors.push(message)
      continue
    }
    const part = field(event, "part")
    if (typeof part !== "object" || part === null) continue
    const sessionID = asText(field(part, "sessionID"))
    if (sessionID !== undefined) ctx.sessionID ??= sessionID
    if (type === "text") {
      const body = asText(field(part, "text"))
      if (body) {
        segment.text += `${body}\n`
        ctx.text += `${body}\n`
      }
      continue
    }
    if (type === "tool_use") {
      const state = field(part, "state") ?? {}
      const toolInput = field(state, "input") ?? {}
      ctx.tools.push({
        tool: asText(field(part, "tool")) ?? "?",
        status: asText(field(state, "status")),
        error: asText(field(state, "error")) ?? asText(field(field(state, "error"), "message")),
        command: asText(field(toolInput, "command")),
        background: field(toolInput, "run_in_background") === true,
      })
      continue
    }
    if (type === "step_finish") {
      ctx.stepFinishes += 1
      ctx.cost += Number(field(part, "cost") ?? 0)
      const tokens = field(part, "tokens") ?? {}
      ctx.tokensIn += Number(field(tokens, "input") ?? 0)
      ctx.tokensOut += Number(field(tokens, "output") ?? 0)
    }
  }
}

const cellModel = (scenario: Scenario, matrixModel: string) => (scenario.models === "vision" ? VISION : matrixModel)

const modelScoped = (scenario: Scenario, model: string): string | undefined => {
  if (scenario.models === "primary" && model !== PRIMARY)
    return `scenario requires ${PRIMARY}; active model is ${model}`
  return undefined
}

const writeProjectConfig = async (workspace: string, scenario: Scenario) => {
  if (scenario.config === undefined && scenario.env === undefined) return
  const dir = path.join(workspace, ".miao")
  await mkdir(dir, { recursive: true })
  if (scenario.config !== undefined) {
    const config: Record<string, unknown> = { $schema: "https://mtty.dev/miao/config.json" }
    if (scenario.config.mcp === true) {
      await writeFile(path.join(dir, "dice-server.mjs"), DICE_SERVER)
      config.mcp = { servers: { dice: { type: "local", command: ["bun", path.join(dir, "dice-server.mjs")] } } }
    }
    if (scenario.config.permissions !== undefined) config.permissions = scenario.config.permissions
    if (scenario.config.agents !== undefined) config.agents = scenario.config.agents
    await writeFile(path.join(dir, "miao.json"), `${JSON.stringify(config, null, 2)}\n`)
  }
  if (scenario.id === "mcp-fixture") {
    const server = path.join(dir, "dice-server.mjs")
    const engineDir = `${workspace}-engine`
    await mkdir(engineDir, { recursive: true })
    await writeFile(
      path.join(engineDir, "dice-engine-mcp.json"),
      `${JSON.stringify([{ name: "dice", argv: ["bun", server], env: {} }])}\n`,
    )
    await writeFile(
      path.join(engineDir, "engine-policy.json"),
      `${JSON.stringify({
        mode: "workspace",
        allow_process: true,
        allow_background: true,
        allow_subagents: true,
        allow_mcp: true,
        allow_web: true,
        allow_wakeup: true,
        allow_cron: true,
        process_network: true,
      })}\n`,
    )
  }
}

const childEnv = (engine: Engine, storageDir: string, extra: Record<string, string>) => {
  const env = { ...process.env, ...extra }
  if (engine === "rust") env.MIAO_ENGINE_STORAGE = storageDir
  else delete env.MIAO_ENGINE_STORAGE
  return env
}

const dumpWorkspace = async (workspace: string) => {
  const entries = await readdir(workspace, { recursive: true, withFileTypes: true }).catch(() => [])
  const parts: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name === "image.png") continue
    const full = path.join(entry.parentPath ?? entry.path, entry.name)
    const content = await readFile(full, "utf8").catch(() => "<binary>")
    parts.push(`--- ${path.relative(workspace, full)}\n${content.slice(0, 2000)}`)
  }
  return redact(parts.join("\n"))
}

const runCell = async (scenario: Scenario, engine: Engine, model: string) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `conf-${scenario.id}-${engine}-`))
  const storageDir = path.join(options.storage, `${scenario.id}.${engine}`)
  const ctx: Ctx = {
    engine,
    model,
    workspace,
    storageDir,
    productDbPath: `${storageDir}.product.db`,
    segments: [],
    text: "",
    tools: [],
    cost: 0,
    tokensIn: 0,
    tokensOut: 0,
    stepFinishes: 0,
    errors: [],
  }
  await mkdir(storageDir, { recursive: true })
  for (const [name, content] of Object.entries(scenario.files?.() ?? {})) {
    const file = path.join(workspace, name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  await writeProjectConfig(workspace, scenario)
  const attachments = (scenario.attachments ?? []).map((file) => path.join(workspace, file))
  for (const segment of segmentsFor(scenario)) {
    const record = await runSegment({
      binary: options.binary,
      engine,
      cwd: workspace,
      model,
      prompt: segment.text,
      resume: segment.resume,
      attachments: segment.resume ? [] : attachments,
      env: childEnv(engine, storageDir, { ...scenario.env?.(workspace), MIAO_DB: ctx.productDbPath }),
      interruptAfterSeconds: segment.killAfterSeconds,
      timeoutSeconds: options.segmentTimeout,
    })
    ctx.segments.push(record)
    harvest(ctx, record)
    if (record.timedOut) break
  }
  const outcome = await (async () => {
    const last = ctx.segments.at(-1)
    if (!last || last.exitCode !== 0 || last.timedOut)
      return fail(`final segment did not complete (exit=${last?.exitCode}, timeout=${last?.timedOut})`)
    if (engine === "rust") {
      const file = await newestEngineDb(storageDir)
      if (!file || !ctx.sessionID) return fail("no native execution receipt")
      const run = queryOne<{ state: string }>(
        file,
        "SELECT state FROM engine_run WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
        ctx.sessionID,
      )
      if (run?.state !== "completed")
        return fail(`native run ended as ${run?.state ?? "<missing>"} despite exit code 0`)
    }
    return scenario.assert(ctx)
  })()
  if (outcome.status === "fail")
    await Bun.write(
      path.join(options.data, "raw", `${scenario.id}.${engine}.${model.replaceAll("/", "-")}.workspace.txt`),
      `${await dumpWorkspace(workspace)}\n`,
    )
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  await rm(`${workspace}-engine`, { recursive: true, force: true }).catch(() => undefined)
  return { ctx, outcome }
}

const archive = async (scenario: Scenario, engine: Engine, model: string, ctx: Ctx, outcome: Outcome) => {
  const dir = path.join(options.data, "raw")
  await mkdir(dir, { recursive: true })
  const base = `${scenario.id}.${engine}.${model.replaceAll("/", "-")}`
  const jsonl: string[] = []
  ctx.segments.forEach((segment, index) => {
    jsonl.push(redact(JSON.stringify({ type: "segment", index, resume: segment.resume, prompt: segment.prompt })))
    jsonl.push(...segment.rawLines)
    jsonl.push(
      redact(
        JSON.stringify({
          type: "segment.end",
          index,
          exitCode: segment.exitCode,
          seconds: Number(segment.seconds.toFixed(1)),
          killed: segment.killed,
          timedOut: segment.timedOut,
        }),
      ),
    )
  })
  await Bun.write(path.join(dir, `${base}.jsonl`), `${jsonl.join("\n")}\n`)
  const stderrText = ctx.segments
    .map((segment) => segment.stderr + (segment.noise.length ? `\n[stdout noise]\n${segment.noise.join("\n")}` : ""))
    .join("\n---\n")
  await Bun.write(path.join(dir, `${base}.stderr.txt`), stderrText)
  await Bun.write(
    path.join(dir, `${base}.result.json`),
    `${JSON.stringify(
      {
        scenario: scenario.id,
        engine,
        model,
        outcome,
        sessionID: ctx.sessionID,
        cost: Number(ctx.cost.toFixed(5)),
        tokensIn: ctx.tokensIn,
        tokensOut: ctx.tokensOut,
        stepFinishes: ctx.stepFinishes,
        tools: ctx.tools,
        errors: ctx.errors.slice(0, 5),
      },
      null,
      2,
    )}\n`,
  )
  return path.join(dir, base)
}

const credentialStrikes = new Map<string, number>()
const deadModels = new Map<string, string>()

const cellErrorClass = (ctx: Ctx) => (CREDENTIAL_ERROR.test(ctx.errors.join(" ")) ? "credential" : undefined)

type Row = {
  scenario: string
  engine: Engine
  model: string
  status: "pass" | "fail" | "skip"
  note?: string
  seconds: number
  cost: number
  tokensIn: number
  tokensOut: number
  turns: number
  archived?: string
}

const fmtRow = (row: Row) =>
  `${row.status.toUpperCase().padEnd(4)} ${row.scenario.padEnd(20)} ${row.engine.padEnd(4)} ${row.model.padEnd(36)} ` +
  `$${row.cost.toFixed(4)} ${row.turns}t ${Math.round(row.seconds)}s ${row.note ?? ""}`.trimEnd()

const skipRow = (scenario: Scenario, engine: Engine, model: string, note: string): Row => ({
  scenario: scenario.id,
  engine,
  model,
  status: "skip",
  note,
  seconds: 0,
  cost: 0,
  tokensIn: 0,
  tokensOut: 0,
  turns: 0,
})

const main = async () => {
  const scenarios = SCENARIOS.filter((scenario) => options.scenarios.includes(scenario.id))
  const rows: Row[] = []
  let spent = 0
  for (const scenario of scenarios) {
    for (const engine of options.engines) {
      const alive = options.models.find((model) => !deadModels.has(model)) ?? options.models[0]!
      const model = cellModel(scenario, alive)
      const precheck = modelScoped(scenario, model) ?? deadModels.get(model)
      if (precheck !== undefined) {
        rows.push(skipRow(scenario, engine, model, precheck))
        console.log(fmtRow(rows.at(-1)!))
        continue
      }
      if (spent > options.maxCost) {
        rows.push(skipRow(scenario, engine, model, `budget $${options.maxCost} reached`))
        console.log(fmtRow(rows.at(-1)!))
        continue
      }
      let outcome: Outcome | undefined
      let ctx: Ctx | undefined
      for (let attempt = 0; attempt < 2 && outcome === undefined; attempt++) {
        const cell = await runCell(scenario, engine, model)
        ctx = cell.ctx
        outcome = cell.outcome
        if (outcome.status !== "fail") break
        if (cellErrorClass(ctx) !== "credential") break
        const strikes = (credentialStrikes.get(model) ?? 0) + 1
        credentialStrikes.set(model, strikes)
        if (strikes >= 2) deadModels.set(model, `credential failed twice: ${ctx.errors.join(" | ").slice(0, 200)}`)
        if (attempt === 0 && strikes < 2) outcome = undefined
      }
      const row: Row = {
        scenario: scenario.id,
        engine,
        model,
        status: outcome!.status,
        note: outcome!.status === "fail" ? outcome!.reason.slice(0, 400) : outcome!.note,
        seconds: ctx!.segments.reduce((total, segment) => total + segment.seconds, 0),
        cost: ctx!.cost,
        tokensIn: ctx!.tokensIn,
        tokensOut: ctx!.tokensOut,
        turns: ctx!.stepFinishes,
      }
      row.archived = await archive(scenario, engine, model, ctx!, outcome!)
      spent += ctx!.cost
      rows.push(row)
      console.log(fmtRow(row))
    }
  }
  await mkdir(options.data, { recursive: true })
  await Bun.write(path.join(options.data, "results.json"), `${JSON.stringify({ spent, rows }, null, 2)}\n`)
  const passed = rows.filter((row) => row.status === "pass").length
  const failed = rows.filter((row) => row.status === "fail").length
  const skipped = rows.filter((row) => row.status === "skip").length
  console.log(`SUMMARY pass=${passed} fail=${failed} skip=${skipped} spent=$${spent.toFixed(4)} data=${options.data}`)
  if (failed > 0) process.exitCode = 1
}

await main()
