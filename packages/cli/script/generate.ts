const sources = process.env.MIAO_MODELS_URL ? [process.env.MIAO_MODELS_URL] : ["https://mtty.dev/models"]

const loadCatalog = async () => {
  if (process.env.MIAO_MODELS_JSON) return Bun.file(process.env.MIAO_MODELS_JSON).text()
  for (const source of sources) {
    try {
      const response = await fetch(`${source}/api.json`)
      if (response.ok) return await response.text()
      console.warn(`Model catalog ${source} answered ${response.status}`)
    } catch (error) {
      console.warn(`Model catalog ${source} failed: ${error}`)
    }
  }
  throw new Error(`No model catalog source available (tried ${sources.join(", ")})`)
}

export const modelsData = await loadCatalog()

console.log("Loaded model catalog snapshot")
