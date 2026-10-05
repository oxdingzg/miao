import { ControlHub } from "./hub"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { constants } from "node:fs"
import { lstat, mkdir, open } from "node:fs/promises"
import path from "node:path"

const Legacy = Schema.Struct({
  hosts: Schema.Record(Schema.String, Schema.String),
  origins: Schema.optional(Schema.Array(Schema.String)),
})
const Account = Schema.Struct({
  mode: Schema.Literal("account"),
  database: Schema.String,
  baseURL: Schema.String,
  secret: Schema.String,
  webDirectory: Schema.optional(Schema.String),
  pushRegistrations: Schema.optional(Schema.Boolean),
  pushProvider: Schema.optional(
    Schema.Struct({
      teamID: Schema.String,
      keyID: Schema.String,
      privateKey: Schema.String,
      topic: Schema.String,
      environment: Schema.Literals(["sandbox", "production"]),
    }),
  ),
  migrate: Schema.optional(Schema.Boolean),
  bootstrap: Schema.optional(Schema.Struct({ email: Schema.String, password: Schema.String, name: Schema.String })),
})
const filename = process.env.MIAO_HUB_CONFIG
if (!filename) throw new Error("MIAO_HUB_CONFIG must name a private Hub configuration file")
if (process.platform === "win32") throw new Error("Hub deployment requires Unix private-file permissions")
const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
const config = await (async () => {
  try {
    const metadata = await file.stat()
    if (
      !metadata.isFile() ||
      metadata.size > 64 * 1024 ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.uid !== process.getuid!()
    )
      throw new Error("Hub configuration must be an owner-only regular file")
    const raw = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(await file.readFile("utf8"))
    if (typeof raw === "object" && raw !== null && "mode" in raw) return Schema.decodeUnknownSync(Account)(raw)
    return Schema.decodeUnknownSync(Legacy)(raw)
  } finally {
    await file.close()
  }
})()
const port = Number(process.env.MIAO_HUB_PORT ?? "4600")
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid Hub listening port")
const options = { hostname: process.env.MIAO_HUB_HOST ?? "127.0.0.1", port }
const database =
  "mode" in config ? await privateDatabase(path.resolve(path.dirname(filename), config.database)) : undefined
const server = await (async () => {
  if (!("mode" in config))
    return ControlHub.listen({
      ...options,
      hosts: new Map(Object.entries(config.hosts)),
      origins: new Set(config.origins ?? []),
    })
  const { HubService } = await import("./hub-service")
  return HubService.listen({
    ...config,
    ...options,
    database: database!,
    webDirectory: config.webDirectory ? path.resolve(path.dirname(filename), config.webDirectory) : undefined,
  }).catch((error: unknown) => {
    database!.close()
    throw error
  })
})()
console.log(`Remote Control Hub listening on ${server.hostname}:${server.port}`)
const shutdown = { started: false }
async function stop() {
  if (shutdown.started) return
  shutdown.started = true
  try {
    await server.stop()
  } finally {
    database?.close()
  }
}
process.once("SIGTERM", stop)
process.once("SIGINT", stop)

async function privateDatabase(filename: string) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const directory = await lstat(path.dirname(filename))
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077) !== 0 ||
    directory.uid !== process.getuid!()
  )
    throw new Error("Hub database directory must be owner-only")
  const existing = await lstat(filename).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!existing)
    await (
      await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    ).close()
  const metadata = existing ?? (await lstat(filename))
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.uid !== process.getuid!()
  )
    throw new Error("Hub database must be an owner-only regular file")
  return new Database(filename)
}
