// Independent oracle: execute the real TS selector, then check native selection
// against its UTF-8 asset hashes. Never duplicate TS dispatch rules in the test.
import { Persona } from "../../../../packages/core/src/system-context/persona"
import path from "node:path"

const inputs = [
  {},
  { providerID: "fixture", modelID: "custom" },
  { modelID: "gpt-4.1" },
  { modelID: "o1" },
  { modelID: "o3" },
  { modelID: "gpt-5" },
  { modelID: "gpt-6.1-sol" },
  { modelID: "gpt-5-codex" },
  { modelID: "gemini-3.8-flash-medium" },
  { modelID: "claude-sonnet" },
  { modelID: "trinity-large" },
  { modelID: "kimi-k2" },
  { providerID: "kimi-for-coding", modelID: "custom" },
  { providerID: "moonshotai", apiID: "custom" },
  { providerID: "moonshotai-cn", apiID: "custom" },
  { modelID: "muse-spark" },
  { modelID: "muse-glimmer" },
  { modelID: "GEMINI-3-FLASH" },
  { modelID: "logical-alias", apiID: "gemini-3-flash" },
  { modelID: "gemini-3-flash", apiID: "gpt-4.1" },
  { modelID: "codex" },
]
const text = JSON.stringify(inputs.map((input) => ({ ...input, sha256: new Bun.CryptoHasher("sha256").update(Persona.system(input)).digest("hex") })), null, 2) + "\n"
const file = Bun.file(path.join(import.meta.dir, "personas.json"))
if (process.argv.includes("--check")) {
  if (!await file.exists() || await file.text() !== text) throw new Error("Native persona corpus differs from the live TS harness; regenerate it")
  console.log(`persona reference verified: ${inputs.length} cases`)
} else await Bun.write(file, text)
