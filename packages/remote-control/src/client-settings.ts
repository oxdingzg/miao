export * as ControlClientSettings from "./client-settings"

import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { Option, Schema } from "effect"

const Settings = Schema.Struct({ defaultHubURL: Schema.optional(Schema.String) })
export type Settings = typeof Settings.Type

/** Operator defaults contain no credentials and stay outside the checkout. */
export async function read(filename: string, environmentHub?: string): Promise<Settings> {
  if (environmentHub) return { defaultHubURL: origin(environmentHub) }
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!file) return {}
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 16384 ||
        (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())))
      throw new Error("Remote Control client settings must be an owner-only regular file")
    const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Settings)), {
      onExcessProperty: "error",
    })(await file.readFile("utf8"))
    if (Option.isNone(decoded)) throw new Error("Invalid Remote Control client settings")
    return decoded.value.defaultHubURL ? { defaultHubURL: origin(decoded.value.defaultHubURL) } : {}
  } finally {
    await file.close()
  }
}

function origin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Default Hub must be a root HTTPS URL")
  return url.origin
}
