import fs from "fs"
import os from "os"
import path from "path"
import { afterAll } from "bun:test"

// Point every global directory at a per-run temp root before src/global.ts is
// imported: xdg-basedir reads these at import time, and without them tests
// create and append to the user's real ~/.local/share/miao, ~/.config/miao, etc.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miao-core-test-"))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

process.env.XDG_DATA_HOME = path.join(dir, "share")
process.env.XDG_CACHE_HOME = path.join(dir, "cache")
process.env.XDG_CONFIG_HOME = path.join(dir, "config")
process.env.XDG_STATE_HOME = path.join(dir, "state")
process.env.MIAO_TEST_HOME = path.join(dir, "home")
fs.mkdirSync(process.env.MIAO_TEST_HOME, { recursive: true })

process.env.MIAO_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
process.env.MIAO_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models.json")
process.env.MIAO_DISABLE_MODELS_FETCH = "true"
