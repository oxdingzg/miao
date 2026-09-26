import path from "path"

process.env.MIAO_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
process.env.MIAO_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.MIAO_DISABLE_MODELS_FETCH = "true"
