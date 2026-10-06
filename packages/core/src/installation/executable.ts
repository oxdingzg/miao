export * as InstallationExecutable from "./executable"

import { existsSync, realpathSync } from "node:fs"
import path from "node:path"

declare const MIAO_BUILD_ID: string

// A build identity is independent of the public release version. Retained files
// let an old window launch its own sandbox runner after the launcher changes.
export const buildID = typeof MIAO_BUILD_ID === "string" ? MIAO_BUILD_ID : "local"
const current = realpathSync(process.execPath)
const directory = path.dirname(current)
const root = path.basename(path.dirname(directory)) === ".versions" ? path.dirname(path.dirname(directory)) : directory
const retained = path.join(root, ".versions", buildID, path.basename(current))
export const executable = buildID !== "local" && existsSync(retained) ? retained : current
export const launcher = path.join(root, path.basename(current))
