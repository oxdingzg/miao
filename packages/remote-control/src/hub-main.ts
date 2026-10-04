import { ControlHub } from "./hub"
import { Option, Schema } from "effect"

const Config = Schema.Struct({
  hosts: Schema.Record(Schema.String, Schema.String),
  origins: Schema.optional(Schema.Array(Schema.String)),
})
const filename = process.env.MIAO_HUB_CONFIG
if (!filename) throw new Error("MIAO_HUB_CONFIG must name a private Hub configuration file")
const config = Schema.decodeUnknownOption(Config)(await Bun.file(filename).json())
if (Option.isNone(config)) throw new Error("Invalid Hub configuration")
const server = ControlHub.listen({
  hosts: new Map(Object.entries(config.value.hosts)),
  origins: new Set(config.value.origins ?? []),
  hostname: process.env.MIAO_HUB_HOST ?? "127.0.0.1",
  port: Number(process.env.MIAO_HUB_PORT ?? "4600"),
})
console.log(`Remote Control Hub listening on ${server.hostname}:${server.port}`)
process.once("SIGTERM", () => server.stop())
process.once("SIGINT", () => server.stop())
