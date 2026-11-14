import type { ModelsCatalog } from "./models-catalog"

export * as ModelsOverlay from "./models-overlay"

/**
 * Catalog entries miao maintains itself, merged over the fetched the catalog
 * snapshot (and over any `MIAO_MODELS_PATH`). This is the fallback for
 * providers that the catalog does not list yet, so a provider can ship without
 * waiting on an upstream catalog change.
 *
 * `commandcode` is backed by the CLI subscription endpoint rather than the
 * documented Provider API, so it has no `npm` and stays `native`: the V2
 * session runner routes it through `CommandCode.route`. Its model list is
 * discovered at runtime (see `plugin/provider/commandcode.ts`); only the
 * provider identity and credential environment names live here.
 */
export const providers: Record<string, ProviderPatch> = {
  commandcode: {
    id: "commandcode",
    name: "Command Code",
    env: ["CMD_API_KEY", "COMMAND_CODE_API_KEY"],
    api: "https://api.commandcode.ai",
    models: {},
  },
  /**
   * The coding-plan gateway bills through subscription quota, and the upstream
   * catalog records that as zero cost on every model. Zero is the marginal
   * price, not the value of the tokens, so usage display and native-engine
   * pricing both read $0.00 and comparisons like the engine cost benchmark
   * lose their cost column. Patch the two models the plan officially supports
   * (per bigmodel.cn/glm-coding) with their standard-API reference rates,
   * mirrored from this catalog's own `zhipuai` entries so both providers stay
   * consistent (source: https://open.bigmodel.cn/pricing).
   */
  "zhipuai-coding-plan": {
    id: "zhipuai-coding-plan",
    models: {
      "glm-5.3": {
        cost: { input: 1.19516, output: 4.18306, cache_read: 0.29879, cache_write: 0 },
      },
      "glm-5.3-flash": {
        cost: { input: 0.11952, output: 0.41831, cache_read: 0.03436, cache_write: 0 },
      },
    },
  },
}

/**
 * Overlay providers may carry partial model patches (for example a cost-only
 * correction), so overlay models merge field-wise over the catalog entry
 * instead of replacing it.
 */
type ModelPatch = Partial<Omit<ModelsCatalog.Model, "id">>
type ProviderPatch = Partial<Omit<ModelsCatalog.Provider, "id" | "models">> & {
  id: ModelsCatalog.Provider["id"]
  models: Record<string, ModelPatch>
}

/** Merge the overlay over a catalog, letting overlay provider fields win. */
export const merge = (catalog: Record<string, ModelsCatalog.Provider>): Record<string, ModelsCatalog.Provider> => {
  const result = { ...catalog }
  for (const [id, provider] of Object.entries(providers)) {
    const existing = result[id]
    result[id] = {
      ...existing,
      ...provider,
      models: {
        ...existing?.models,
        ...Object.fromEntries(
          Object.entries(provider.models).map(([modelID, model]) => [
            modelID,
            { ...existing?.models[modelID], ...model },
          ]),
        ),
      },
    }
  }
  return result
}
