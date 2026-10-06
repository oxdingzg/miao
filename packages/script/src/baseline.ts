import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

export function parseTurn(line: string) {
  const fields: Record<string, string> = {}
  for (const match of line.matchAll(/(?:^|\s)([\w.]+)=("(?:[^"\\]|\\.)*"|[^\s]+)/g)) {
    fields[match[1]!] = match[2]!.startsWith('"') ? JSON.parse(match[2]!) : match[2]!
  }
  return fields.message === "session.turn" ? fields : undefined
}

type Turn = NonNullable<ReturnType<typeof parseTurn>>

const metrics = [
  "local.preRequestMs",
  "ttftMs",
  "turnMs",
  "local.sessionMs",
  "local.agentMs",
  "local.epochMs",
  "local.resolveMs",
  "local.smallMs",
  "local.historyMs",
  "local.toolsMs",
  "local.requestBuildMs",
  "local.compactMs",
  "local.startSnapshotMs",
  "local.endSnapshotMs",
  "local.filesMs",
  "cacheHitRatio",
] as const

function number(turn: Turn, key: string) {
  if (turn[key] === undefined || turn[key] === "") return undefined
  const value = Number(turn[key])
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

export function distribution(values: number[]) {
  if (values.length === 0) return undefined
  const sorted = values.toSorted((a, b) => a - b)
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!
  return {
    n: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentile(0.5),
    p90: percentile(0.9),
    p99: percentile(0.99),
    max: sorted.at(-1)!,
  }
}

export function summarize(turns: Turn[]) {
  const present = (key: string) =>
    turns.flatMap((turn) => {
      const value = number(turn, key)
      return value === undefined ? [] : [value]
    })
  const total = (key: string) => {
    const values = present(key)
    return { n: values.length, total: values.reduce((sum, value) => sum + value, 0) }
  }
  const boolean = (key: string) => ({
    yes: turns.filter((turn) => turn[key] === "true").length,
    no: turns.filter((turn) => turn[key] === "false").length,
  })
  return {
    turns: turns.length,
    sessions: new Set(turns.map((turn) => turn.sessionID).filter(Boolean)).size,
    metrics: Object.fromEntries(metrics.map((key) => [key, distribution(present(key))])),
    snapshotTotalMs: distribution(
      turns.flatMap((turn) => {
        const values = ["local.startSnapshotMs", "local.endSnapshotMs", "local.filesMs"].map((key) => number(turn, key))
        return values.every((value) => value !== undefined) ? [values.reduce((sum, value) => sum + value, 0)] : []
      }),
    ),
    warm: boolean("warm"),
    cacheMiss: boolean("cacheMiss"),
    tokens: Object.fromEntries(
      ["input", "output", "reasoning", "cache.read", "cache.write"].map((key) => [key, total(`tokens.${key}`)]),
    ),
  }
}

export function report(turns: Turn[]) {
  const groups = new Map<string, Turn[]>()
  for (const turn of turns) {
    const key = JSON.stringify([turn.model ?? "unknown", turn.warm ?? "unknown", turn.cacheMissCause ?? "unknown"])
    const group = groups.get(key) ?? []
    group.push(turn)
    groups.set(key, group)
  }
  return {
    overall: summarize(turns),
    groups: [...groups]
      .map(([key, values]) => ({
        model: JSON.parse(key)[0] as string,
        warmState: JSON.parse(key)[1] as string,
        cause: JSON.parse(key)[2] as string,
        ...summarize(values),
      }))
      .toSorted((a, b) => b.turns - a.turns),
  }
}

export function markdown(result: ReturnType<typeof report>) {
  const format = (value: number | undefined) => (value === undefined ? "缺测" : value.toFixed(value <= 1 ? 4 : 2))
  const metricRows = Object.entries(result.overall.metrics).map(
    ([key, value]) =>
      `| ${key} | ${value?.n ?? 0} | ${format(value?.mean)} | ${format(value?.p50)} | ${format(value?.p90)} | ${format(value?.p99)} | ${format(value?.max)} |`,
  )
  return [
    "# miao 日志基线",
    "",
    `已完成 provider step：${result.overall.turns}；Session：${result.overall.sessions}。`,
    "",
    "## 指标分布",
    "",
    "时间单位 ms；cacheHitRatio 为 0–1。分位数使用 nearest-rank；n 为该指标有效样本数。",
    "",
    "| 指标 | n | mean | p50 | p90 | p99 | max |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...metricRows,
    `| snapshotTotalMs（前+后+diff） | ${result.overall.snapshotTotalMs?.n ?? 0} | ${format(result.overall.snapshotTotalMs?.mean)} | ${format(result.overall.snapshotTotalMs?.p50)} | ${format(result.overall.snapshotTotalMs?.p90)} | ${format(result.overall.snapshotTotalMs?.p99)} | ${format(result.overall.snapshotTotalMs?.max)} |`,
    "",
    "## 按模型 / warm / cache 原因分层",
    "",
    "| 模型 | warm | cache 原因 | steps | preRequest p50/p90 | 首事件 p50/p90 | turn p50/p90 | cache ratio mean |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...result.groups.map((group) => {
      const pair = (key: string) => `${format(group.metrics[key]?.p50)} / ${format(group.metrics[key]?.p90)}`
      return `| ${group.model.replaceAll("|", "\\|")} | ${group.warmState} | ${group.cause} | ${group.turns} | ${pair("local.preRequestMs")} | ${pair("ttftMs")} | ${pair("turnMs")} | ${format(group.metrics.cacheHitRatio?.mean)} |`
    }),
    "",
    "## Token 总量（provider 上报，缺测不补零）",
    "",
    "| 字段 | n | 总量 |",
    "| --- | ---: | ---: |",
    ...Object.entries(result.overall.tokens).map(([key, value]) => `| ${key} | ${value.n} | ${value.total} |`),
    "",
    "## 解读边界",
    "",
    "- preRequestMs 是请求发出前的本地等待；resolveMs 可能含集成/鉴权等待，并非纯 CPU 时间。",
    "- ttftMs 是请求到首个流事件，不等于首个可见文字；turnMs 含本地准备、流处理和工具执行，不是纯 provider 时间。",
    "- startSnapshotMs 在请求前；endSnapshotMs/filesMs 在 step 结束后。snapshotTotalMs 按每行相加后再取分位数，不能叠加各项 p50。",
    "- cacheHitRatio 是逐 step 比例，mean 是非加权平均；token 字段语义随 provider 而异，不推算账单或统一 prompt token 总量。",
    "- 仅 session.turn 完成记录进入统计；失败/中断、启动与 UI 首帧、工具定义 token 占比、任务正确率/验收耗时均缺测。",
    "- 不同版本、机器、模型和任务混合日志只适合探索；受控 A/B 应按 run/model/Session/时间范围筛选，使用相同任务和验收标准。",
    "",
  ].join("\n")
}

if (import.meta.main) {
  const args = parseArgs({
    options: {
      log: { type: "string", multiple: true },
      model: { type: "string" },
      session: { type: "string" },
      run: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  })
  if (args.values.help) {
    console.log(
      "bun packages/script/src/baseline.ts [--log PATH ...] [--model ID] [--session ID] [--run ID] [--since ISO] [--until ISO] [--json]",
    )
    process.exit(0)
  }
  const since = args.values.since === undefined ? -Infinity : Date.parse(args.values.since)
  const until = args.values.until === undefined ? Infinity : Date.parse(args.values.until)
  if (Number.isNaN(since) || Number.isNaN(until) || since > until) throw new Error("Invalid --since/--until range")
  const files = [
    ...new Set(
      args.values.log ?? [
        path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share"), "miao/log/miao.log"),
      ],
    ),
  ]
  const turns: Turn[] = []
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of lines) {
      const turn = parseTurn(line)
      if (!turn) continue
      if (args.values.model && turn.model !== args.values.model) continue
      if (args.values.session && turn.sessionID !== args.values.session) continue
      if (args.values.run && turn.run !== args.values.run) continue
      const timestamp = Date.parse(turn.timestamp ?? "")
      if (!Number.isFinite(timestamp) || timestamp < since || timestamp > until) continue
      turns.push(turn)
    }
  }
  if (turns.length === 0) throw new Error("No completed session.turn records matched the filters")
  console.log(args.values.json ? JSON.stringify(report(turns), null, 2) : markdown(report(turns)))
}
