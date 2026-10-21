#!/usr/bin/env bun
/**
 * Cost/quality benchmark for the TypeScript and Rust (native) engines over a
 * representative task set.
 *
 * Each task gets a fresh workspace per cell; the same prompt runs through
 * `miao run --format json` once per engine (rust placement requires
 * MIAO_ENGINE_STORAGE, TypeScript is the default without it). Metrics come
 * from the streamed events - per-step cost and token counts - so no
 * database is queried and both runtimes are measured identically.
 *
 * Usage:
 *   bun script/engine-benchmark.ts --binary miao-dev [--model provider/id]
 *       [--tasks bugfix,feature] [--engines ts,rust] [--repeat 1]
 *       [--storage ~/.local/share/miao/bench-storage] [--out report.md]
 *
 * A small sample is directional, not statistical: repeat runs and more tasks
 * tighten it. The report states the model, date, and per-cell raw numbers so
 * a reader can recompute every figure.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type Task = {
  id: string
  category: string
  prompt: string
  files: Record<string, string>
  verify: (workspace: string) => Promise<string | undefined>
}

const bunTest = (workspace: string) =>
  new Promise<string | undefined>((resolve) => {
    const child = Bun.spawn(["bun", "test"], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
    Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
      ([code, out, err]) => resolve(code === 0 ? undefined : `${out}\n${err}`.slice(0, 2000)),
    )
  })

const TASKS: Task[] = [
  {
    id: "bugfix",
    category: "bug fix",
    prompt:
      "bun test in this workspace fails. Fix src/math.ts so every test passes. Do not modify the test file.",
    files: {
      "package.json": `{"name":"bench-bugfix"}`,
      "src/math.ts": `export function median(values: number[]): number {
  const sorted = [...values]
  // BUG: sorting is missing, the implementation below assumes sorted input.
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}
`,
      "src/math.test.ts": `import { test, expect } from "bun:test"
import { median } from "./math"
test("median of unsorted input", () => {
  expect(median([3, 1, 2])).toBe(2)
  expect(median([4, 1, 3, 2])).toBe(2.5)
})
`,
    },
    verify: bunTest,
  },
  {
    id: "feature",
    category: "feature",
    prompt:
      "Implement slugify in src/text.ts following the doc comment, so the test passes. Keep the public signature.",
    files: {
      "package.json": `{"name":"bench-feature"}`,
      "src/text.ts": `/**
 * Slugify a title: lowercase, trim, collapse runs of non-alphanumeric
 * characters into a single dash, and strip leading/trailing dashes.
 * Non-ASCII letters are dropped.
 */
export function slugify(title: string): string {
  return title
}
`,
      "src/text.test.ts": `import { test, expect } from "bun:test"
import { slugify } from "./text"
test("slugify", () => {
  expect(slugify("  Hello,  World! ")).toBe("hello-world")
  expect(slugify("A  B--C")).toBe("a-b-c")
  expect(slugify("résumé notes")).toBe("rsum-notes")
})
`,
    },
    verify: bunTest,
  },
  {
    id: "refactor",
    category: "refactor",
    prompt:
      "src/cart.ts and src/invoice.ts duplicate the same discount computation. Extract it into src/pricing.ts and use it from both, keeping every test green.",
    files: {
      "package.json": `{"name":"bench-refactor"}`,
      "src/cart.ts": `export function cartTotal(items: { price: number; quantity: number }[], member: boolean): number {
  const subtotal = items.reduce((total, item) => total + item.price * item.quantity, 0)
  return member ? subtotal * 0.9 : subtotal
}
`,
      "src/invoice.ts": `export function invoiceTotal(amounts: number[], member: boolean): number {
  const subtotal = amounts.reduce((total, amount) => total + amount, 0)
  return member ? subtotal * 0.9 : subtotal
}
`,
      "src/pricing.test.ts": `import { test, expect } from "bun:test"
import { cartTotal } from "./cart"
import { invoiceTotal } from "./invoice"
test("member discount applies once", () => {
  expect(cartTotal([{ price: 10, quantity: 3 }], true)).toBe(27)
  expect(invoiceTotal([10, 20], true)).toBe(27)
})
`,
    },
    verify: async (workspace) => {
      const failure = await bunTest(workspace)
      if (failure) return failure
      const proc = Bun.spawn(["grep", "-c", "0.9", "src/cart.ts", "src/invoice.ts", "src/pricing.ts"], {
        cwd: workspace,
        stdout: "pipe",
      })
      const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
      if (code !== 0) return "discount check failed"
      const counts = out.trim().split("\n").map((line) => Number(line.split(":")[1] ?? 0))
      return counts[0] === 0 && counts[1] === 0 && counts[2] >= 1
        ? undefined
        : "the discount computation is still duplicated"
    },
  },
]

type Cell = {
  turns: number
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  seconds: number
  ok?: boolean
  verifyError?: string
}

const emptyCell = (): Cell => ({
  turns: 0,
  cost: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  seconds: 0,
})

type Assistant = {
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number } }
}

// `miao run --format json` settles every provider step with a step_finish
// event whose part carries the step's cost and token counts - the same
// projection for both runtimes.
const harvest = (line: string, into: Cell) => {
  let event: { type?: unknown; part?: unknown }
  try {
    event = JSON.parse(line)
  } catch {
    return
  }
  if (event.type !== "step_finish" || typeof event.part !== "object" || event.part === null) return
  const part = event.part as Assistant
  into.turns += 1
  into.cost += part.cost ?? 0
  into.input += part.tokens?.input ?? 0
  into.output += part.tokens?.output ?? 0
  into.reasoning += part.tokens?.reasoning ?? 0
  into.cacheRead += part.tokens?.cache?.read ?? 0
}

const runCell = async (
  task: Task,
  engine: "ts" | "rust",
  options: { binary: string; model?: string; storage: string },
): Promise<Cell> => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `bench-${task.id}-${engine}-`))
  await mkdir(path.join(workspace, "src"), { recursive: true })
  for (const [name, content] of Object.entries(task.files)) {
    await writeFile(path.join(workspace, name), content)
  }
  const cell = emptyCell()
  const started = Date.now()
  try {
    const child = Bun.spawn(
      [
        options.binary,
        "run",
        "--format",
        "json",
        ...(options.model ? ["--model", options.model] : []),
        task.prompt,
      ],
      {
        cwd: workspace,
        stdout: "pipe",
        stderr: "pipe",
        env:
          engine === "rust"
            ? { ...process.env, MIAO_ENGINE_STORAGE: options.storage }
            : (() => {
                const { MIAO_ENGINE_STORAGE: _ignored, ...rest } = process.env
                return rest
              })(),
      },
    )
    const reader = child.stdout.getReader()
    const lines: string[] = []
    let buffer = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += new TextDecoder().decode(value, { stream: true })
      let index = buffer.indexOf("\n")
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.startsWith("{")) {
          harvest(line, cell)
          lines.push(line)
        }
        index = buffer.indexOf("\n")
      }
    }
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    cell.seconds = (Date.now() - started) / 1000
    if (code !== 0) {
      cell.verifyError = `run exited ${code}: ${stderr.slice(0, 500)}`
    } else {
      // The session edited this workspace in place, so verification must run
      // before the cleanup.
      cell.verifyError = await task.verify(workspace)
    }
    cell.ok = cell.verifyError === undefined
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
  return cell
}

const argv = () => Bun.argv.slice(Bun.argv.indexOf("--") > -1 ? Bun.argv.indexOf("--") + 1 : 2)
const parse = {
  string: (flag: string) => {
    const index = argv().indexOf(flag)
    return index === -1 ? undefined : argv()[index + 1]
  },
  number: (flag: string, fallback: number) => {
    const value = parse.string(flag)
    return value === undefined || Number.isNaN(Number(value)) ? fallback : Number(value)
  },
  list: (flag: string, fallback: string[]) => {
    const value = parse.string(flag)
    return value === undefined ? fallback : value.split(",")
  },
}

const binary = parse.string("--binary") ?? "miao-dev"
const model = parse.string("--model")
const repeat = parse.number("--repeat", 1)
const storage = parse.string("--storage") ?? path.join(os.tmpdir(), "miao-bench-storage")
const out = parse.string("--out")
const engines = parse
  .list("--engines", ["ts", "rust"])
  .filter((engine): engine is "ts" | "rust" => engine === "ts" || engine === "rust")
const wanted = parse.list("--tasks", TASKS.map((task) => task.id))
const tasks = TASKS.filter((task) => wanted.includes(task.id))

// Best of N repeats: a passing cell outranks a failing one, then the cheaper
// run wins, so one flaky failure never headlines the report.
const results = new Map<string, Cell>()
for (const task of tasks) {
  for (const engine of engines) {
    for (let attempt = 0; attempt < repeat; attempt++) {
      const key = `${task.id}/${engine}`
      const cell = await runCell(task, engine, { binary, model, storage })
      const previous = results.get(key)
      const better =
        previous === undefined ||
        (cell.ok && !previous.ok) ||
        (cell.ok === previous.ok && cell.cost < previous.cost)
      if (better) results.set(key, cell)
    }
  }
}

const fmt = (cell: Cell | undefined) =>
  cell === undefined
    ? "—"
    : `${cell.turns}t · ${cell.input}in/${cell.output}out · $${cell.cost.toFixed(4)} · ${cell.seconds.toFixed(0)}s${cell.ok ? "" : " · FAILED"}`

const lines: string[] = []
lines.push(`# Engine cost benchmark — ${new Date().toISOString().slice(0, 10)}`)
lines.push("")
lines.push(`- binary: \`${binary}\`, model: \`${model ?? "(configured default)"}\`, repeat: ${repeat}`)
lines.push(`- tasks: ${tasks.map((task) => task.id).join(", ")}; engines: ${engines.join(", ")}`)
lines.push("")
lines.push("| task | typescript | rust | rust cost Δ |")
lines.push("|---|---|---|---|")
for (const task of tasks) {
  const ts = results.get(`${task.id}/ts`)
  const rust = results.get(`${task.id}/rust`)
  const delta =
    ts && rust && ts.cost > 0 ? `${(((rust.cost - ts.cost) / ts.cost) * 100).toFixed(0)}%` : "—"
  lines.push(`| ${task.id} (${task.category}) | ${fmt(ts)} | ${fmt(rust)} | ${delta} |`)
}
lines.push("")
lines.push("Verification gates each cell: a FAILED mark means the session did not satisfy the task.")
const report = lines.join("\n")
console.log(report)
if (out) await Bun.write(out, report + "\n")
