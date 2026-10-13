import path from "path"
import { ConfigV1 } from "@miao/core/v1/config/config"
import { Global } from "@miao/core/global"
import { ConfigParse } from "@/config/parse"
import { ConfigVariable } from "@/config/variable"

/**
 * Read only the global config files, merging later names over earlier ones —
 * the same order the app-layer Config service used. Callers that need a
 * single field (autoupdate, server port, …) can read this without booting any
 * service graph.
 */
export async function readGlobalConfig(): Promise<ConfigV1.Info> {
  let result: ConfigV1.Info = {}
  for (const name of ["config.json", "opencode.json", "opencode.jsonc", "miao.json", "miao.jsonc"]) {
    const file = path.join(Global.Path.config, name)
    const text = await Bun.file(file)
      .text()
      .catch(() => undefined)
    if (!text) continue
    const expanded = await ConfigVariable.substitute({ text, type: "path", path: file })
    result = { ...result, ...ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(expanded, file), file) }
  }
  return result
}
