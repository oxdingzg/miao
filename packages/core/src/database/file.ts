export * as DatabaseFile from "./file"

import { isAbsolute, join } from "path"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { InstallationChannel } from "../installation/version"

// Kept apart from `./database` so callers that only report the database location,
// such as the TUI monitor, do not load drizzle and every migration.
export function path() {
  if (Flag.MIAO_DB) {
    if (Flag.MIAO_DB === ":memory:" || isAbsolute(Flag.MIAO_DB)) return Flag.MIAO_DB
    return join(Global.Path.data, Flag.MIAO_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.MIAO_DISABLE_CHANNEL_DB === "1" ||
    process.env.MIAO_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "miao.db")
  return join(Global.Path.data, `miao-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}
