export * as WorkerConfig from "./worker-config"

import path from "node:path"
import { Effect } from "effect"
import { FSUtil } from "@miao/core/fs-util"
import { InstallationExecutable } from "@miao/core/installation/executable"

declare const MIAO_PACKAGED: boolean | undefined

/** A private, scoped launch manifest for the optional extension worker. */
export const prepare = Effect.fn("Engine.workerConfig")(function* () {
  const fs = yield* FSUtil.Service
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "miao-engine-worker-" })
  const file = path.join(directory, "config.json")
  const source =
    typeof MIAO_PACKAGED !== "undefined" && MIAO_PACKAGED ? [] : [path.resolve(import.meta.dir, "../index.ts")]
  yield* fs.writeFileString(
    file,
    JSON.stringify({ argv: [InstallationExecutable.executable, ...source, "__worker-host"] }),
  )
  return file
})
