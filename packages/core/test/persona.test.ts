import { expect, test } from "bun:test"
import { Persona } from "@miao/core/system-context/persona"
import ANTHROPIC from "@miao/core/system-context/persona/anthropic.txt"
import ASTRA from "@miao/core/system-context/persona/gpt-astra.txt"
import BEAST from "@miao/core/system-context/persona/beast.txt"
import CODEX from "@miao/core/system-context/persona/codex.txt"
import DEFAULT from "@miao/core/system-context/persona/default.txt"
import GEMINI from "@miao/core/system-context/persona/gemini.txt"
import GPT from "@miao/core/system-context/persona/gpt.txt"
import KIMI from "@miao/core/system-context/persona/kimi.txt"
import META from "@miao/core/system-context/persona/meta.txt"
import TRINITY from "@miao/core/system-context/persona/trinity.txt"

test("the wire model id selects the family persona", () => {
  expect(Persona.system({ apiID: "claude-opus-5" })).toBe(ANTHROPIC)
  expect(Persona.system({ apiID: "gemini-3-pro" })).toBe(GEMINI)
  expect(Persona.system({ apiID: "gpt-5.2" })).toBe(GPT)
  expect(Persona.system({ apiID: "trinity-large" })).toBe(TRINITY)
})

test("the gpt families stay ordered: beast, astra and codex before the general gpt text", () => {
  expect(Persona.system({ apiID: "gpt-4o" })).toBe(BEAST)
  expect(Persona.system({ apiID: "o3-mini" })).toBe(BEAST)
  expect(Persona.system({ apiID: "gpt-6" })).toBe(ASTRA)
  expect(Persona.system({ apiID: "gpt-5.2-codex" })).toBe(CODEX)
})

test("a Kimi family provider selects the Kimi persona whatever the model id is", () => {
  for (const providerID of ["kimi-for-coding", "moonshotai", "moonshotai-cn"])
    expect(Persona.system({ providerID, apiID: "k3" })).toBe(KIMI)
})

test("the configured model id selects the family when the wire id does not name it", () => {
  expect(Persona.system({ modelID: "claude-sonnet-5.5", apiID: "ep-20260101" })).toBe(ANTHROPIC)
})

test("the Muse persona is named for the model in use", () => {
  const glimmer = Persona.system({ apiID: "meta/muse-glimmer-30b" })
  expect(glimmer).toContain("Muse Glimmer")
  expect(glimmer).not.toContain("{{MODEL_NAME}}")
  expect(Persona.system({ apiID: "muse-spark-1.2" })).toContain("Muse Spark")
  expect(Persona.system({ apiID: "muse-spark-1.2" })).not.toContain("{{MODEL_NAME}}")
})

test("a model outside the tuned families keeps the default persona", () => {
  // A gateway exposes its own model id, and DeepSeek has no family text, so the
  // general one applies.
  expect(
    Persona.system({
      providerID: "tencent-token-plan",
      modelID: "deepseek/deepseek-flash",
      apiID: "deepseek/deepseek-flash",
    }),
  ).toBe(DEFAULT)
  expect(Persona.system({})).toBe(DEFAULT)
})
