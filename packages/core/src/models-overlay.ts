import type { ModelsDev } from "./models-dev"

export * as ModelsOverlay from "./models-overlay"

/**
 * Catalog entries miao maintains itself, merged over the fetched models.dev
 * snapshot (and over any `MIAO_MODELS_PATH`). This is the fallback for
 * providers that models.dev does not list yet, so a provider can ship without
 * waiting on an upstream catalog change.
 *
 * `commandcode` is backed by the CLI subscription endpoint rather than the
 * documented Provider API, so it has no `npm` and stays `native`: the V2
 * session runner routes it through `CommandCode.route`. Its model list is
 * discovered at runtime (see `plugin/provider/commandcode.ts`); only the
 * provider identity and credential environment names live here.
 */
export const providers: Record<string, ModelsDev.Provider> = {
  commandcode: {
    id: "commandcode",
    name: "Command Code",
    env: ["CMD_API_KEY", "COMMAND_CODE_API_KEY"],
    api: "https://api.commandcode.ai",
    models: {},
  },
}

/** Merge the overlay over a catalog, letting overlay provider fields win. */
export const merge = (catalog: Record<string, ModelsDev.Provider>): Record<string, ModelsDev.Provider> => {
  const result = { ...catalog }
  for (const [id, provider] of Object.entries(providers)) {
    const existing = result[id]
    result[id] = {
      ...existing,
      ...provider,
      models: { ...existing?.models, ...provider.models },
    }
  }
  return result
}
