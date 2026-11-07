/**
 * Starts the HTTP server the desktop sidecar embeds (`src/node.ts`), without
 * the product CLI that used to wrap it. Integration tests spawn this to drive
 * the same server over real HTTP, and it is a convenient local entry point;
 * `miao` itself is the Rust binary, which serves on its own.
 *
 * The handshake line is part of the contract those tests read:
 * `miao server listening on http://<host>:<port>`.
 */
import { Effect } from "effect"
import { Flag } from "@miao/core/flag/flag"
import { Global } from "@miao/core/global"
import { applyEngineOptIn } from "./engine/native-engine"
import { Server } from "./server/server"

const args = process.argv.slice(2)

function value(name: string) {
  const inline = args.find((argument) => argument.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

const engine = value("engine")
if (engine) applyEngineOptIn(engine, Global.Path.data)

if (!Flag.MIAO_SERVER_PASSWORD) {
  console.log("Warning: MIAO_SERVER_PASSWORD is not set; server is unsecured.")
}

const server = await Server.listen({
  hostname: value("hostname") ?? "127.0.0.1",
  port: Number(value("port") ?? 0),
})
console.log(`miao server listening on http://${server.hostname}:${server.port}`)

const stop = () => void server.stop(true)
process.once("SIGINT", stop)
process.once("SIGTERM", stop)

// The server's layers live inside the runtime that started them, so the entry
// has to stay parked in it rather than in a bare promise the event loop drops.
await Effect.runPromise(Effect.never)
