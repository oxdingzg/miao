import { BlackboxTape } from "@miao/core/blackbox/tape"
import { BlackboxCompare } from "@miao/core/blackbox/compare"
import { providerProxy } from "./provider"

const [command, ...args] = Bun.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const required = (name: string) => {
  const value = option(name)
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`)
  return value
}

async function main() {
  if (command === "compare") {
    const report = BlackboxCompare.compare(
      await BlackboxTape.load(required("--expected")),
      await BlackboxTape.load(required("--actual")),
      {
        recordedTime: args.includes("--recorded-time"),
      },
    )
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.equal ? 0 : 1
    return
  }
  if (command === "inspect") {
    const bundle = await BlackboxTape.load(required("--bundle"))
    console.log(
      JSON.stringify(
        {
          format: bundle.format,
          version: bundle.version,
          metadata: bundle.metadata,
          interactions: bundle.interactions.map((item) => ({
            lane: item.lane,
            ordinal: item.ordinal,
            outcome: item.outcome,
            frames: item.frames.length,
          })),
          traceEvents: bundle.trace.length,
        },
        null,
        2,
      ),
    )
    return
  }
  if (command === "record-engine" || command === "replay-engine") {
    const { runEnginePrompt } = await import("../engine/run")
    const file = required("--bundle")
    const binary = required("--binary")
    const workspace = required("--workspace")
    const db = required("--db")
    if (await Bun.file(db).exists()) throw new Error("Blackbox engine runs require a fresh isolated database")
    const replay = command === "replay-engine" ? new BlackboxTape.Replay(await BlackboxTape.load(file)) : undefined
    const prompt = option("--prompt") ?? replay?.bundle.metadata.prompt
    const model = option("--model") ?? replay?.bundle.metadata.model
    const provider = option("--provider") ?? replay?.bundle.metadata.provider ?? "openai-chat"
    if (typeof prompt !== "string" || typeof model !== "string" || typeof provider !== "string")
      throw new Error("Provide --prompt and --model when recording")
    const recorder = replay
      ? undefined
      : new BlackboxTape.Recorder(file, {
          engine: "rust",
          prompt,
          model,
          provider,
          binarySha256: new Bun.CryptoHasher("sha256").update(await Bun.file(binary).arrayBuffer()).digest("hex"),
          fixture: workspace,
        })
    const proxy = replay
      ? await providerProxy({ replay, timing: args.includes("--timing") })
      : await providerProxy({ recorder: recorder!, upstream: required("--upstream") })
    try {
      const result = await runEnginePrompt({
        binary,
        workspace,
        db,
        model,
        provider,
        prompt,
        endpoint: new URL("/chat/completions", proxy.server.url).toString(),
        blackbox: replay ?? recorder,
        ...(replay ? { env: { OPENAI_API_KEY: "blackbox-offline" } } : {}),
      })
      replay?.assertConsumed()
      if (proxy.failures.length) throw proxy.failures[0]
      console.log(JSON.stringify({ type: "blackbox.engine.finished", text: result.text, events: result.events.length }))
    } finally {
      await proxy.server.stop(true)
    }
    return
  }
  if (command === "record" || command === "replay") {
    const port = Number(option("--port") ?? 0)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port")
    const replay =
      command === "replay" ? new BlackboxTape.Replay(await BlackboxTape.load(required("--bundle"))) : undefined
    const recorder =
      command === "record"
        ? new BlackboxTape.Recorder(required("--bundle"), {
            engine: option("--engine") ?? "unspecified",
            protocol: "http",
            createdAt: new Date().toISOString(),
          })
        : undefined
    if (recorder) await recorder.save()
    const proxy = replay
      ? await providerProxy({ replay, port, timing: args.includes("--timing") })
      : await providerProxy({ recorder: recorder!, port, upstream: required("--upstream") })
    console.log(JSON.stringify({ type: "blackbox.ready", url: proxy.url, mode: command }))
    let stopping = false
    const stop = async () => {
      if (stopping) return
      stopping = true
      await proxy.server.stop(true)
      if (recorder) await recorder.save()
      try {
        replay?.assertConsumed()
        if (proxy.failures.length) throw proxy.failures[0]
        console.log(JSON.stringify({ type: "blackbox.finished", status: "complete" }))
      } catch (error) {
        report(error)
      }
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    return
  }
  console.log(
    "Usage: bun src/blackbox/cli.ts record --bundle FILE --upstream URL [--engine ts|rust] [--port N]\n       bun src/blackbox/cli.ts replay --bundle FILE [--port N] [--timing]\n       bun src/blackbox/cli.ts record-engine --bundle FILE --binary BIN --workspace DIR --db NEW_DB --upstream URL --model MODEL --prompt TEXT\n       bun src/blackbox/cli.ts replay-engine --bundle FILE --binary BIN --workspace DIR --db NEW_DB [--timing]\n       bun src/blackbox/cli.ts compare --expected FILE --actual FILE [--recorded-time]\n       bun src/blackbox/cli.ts inspect --bundle FILE",
  )
  process.exitCode = command ? 2 : 0
}

function report(error: unknown) {
  console.error(
    JSON.stringify(
      {
        type: "blackbox.failed",
        message: error instanceof Error ? error.message : "Blackbox failed",
        ...(error instanceof BlackboxTape.Mismatch
          ? {
              lane: error.lane,
              ordinal: error.ordinal,
              difference: BlackboxCompare.difference(error.expected, error.actual),
            }
          : {}),
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
}

await main().catch(report)
