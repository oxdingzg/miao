import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { EngineClient } from "../../src/engine/client"
import { nativeEngineOptions } from "../../src/engine/native-engine"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "trusted product Context manifests reach the engine without granting sibling access",
  async () => {
    await using tmp = await tmpdir()
    const workspace = path.join(tmp.path, "workspace")
    await mkdir(path.join(workspace, "skills", "fixture"), { recursive: true })
    const instruction = path.join(tmp.path, "operator.md")
    const reference = path.join(tmp.path, "reference.txt")
    const sibling = path.join(tmp.path, "sibling.txt")
    await Bun.write(instruction, "HOST_INSTRUCTION_MARKER: keep the fixture intact.\n")
    await Bun.write(reference, "AUTHORIZED_REFERENCE_MARKER\n")
    await Bun.write(sibling, "SIBLING_MUST_NOT_BE_READ\n")
    await Bun.write(
      path.join(workspace, "skills", "fixture", "SKILL.md"),
      "---\nname: fixture-skill\ndescription: Fixture discovery marker\n---\nBody loaded only on demand.\n",
    )
    const context = path.join(tmp.path, "context.json")
    const skills = path.join(tmp.path, "skills.json")
    const references = path.join(tmp.path, "references.json")
    const policy = path.join(tmp.path, "policy.json")
    await Bun.write(context, JSON.stringify([{ label: "operator", path: instruction }]))
    await Bun.write(skills, JSON.stringify([{ path: "skills" }]))
    await Bun.write(
      references,
      JSON.stringify([
        { path: instruction, description: "Operator instruction file" },
        { path: reference, description: "Exact-file fixture reference" },
      ]),
    )
    await Bun.write(
      policy,
      JSON.stringify({ mode: "workspace", rules: [{ tool: "read_file", path: "**", decision: "allow" }] }),
    )
    const requests: string[] = []
    const provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        requests.push(JSON.stringify(await request.json()))
        const file = requests.length === 1 ? reference : sibling
        const delta =
          requests.length < 3
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${requests.length}`,
                    type: "function",
                    function: { name: "read_file", arguments: JSON.stringify({ path: file }) },
                  },
                ],
              }
            : { content: "Context fixture completed" }
        return new Response(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: requests.length < 3 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const options = nativeEngineOptions({
      MIAO_ENGINE_BIN: binary,
      MIAO_ENGINE_MODEL: "fixture",
      MIAO_ENGINE_PROVIDER: "openai-chat",
      MIAO_ENGINE_ENDPOINT: new URL("chat/completions", provider.url).toString(),
      MIAO_ENGINE_CONTEXT_CONFIG: context,
      MIAO_ENGINE_SKILLS_CONFIG: skills,
      MIAO_ENGINE_REFERENCES_CONFIG: references,
    })
    if (!options) throw new Error("Native fixture must be configured")
    const client = EngineClient.start({
      ...options,
      db: path.join(tmp.path, "engine.db"),
      workspace,
      policyFile: policy,
      env: { OPENAI_API_KEY: "fixture-only" },
    })
    const events: { kind: string; data: unknown }[] = []
    const finished = Promise.withResolvers<void>()
    client.onEvent((event) => {
      events.push(event)
      if (event.kind === "run.finished") finished.resolve()
    })
    try {
      await client.request("initialize", { session_id: "context-fixture", title: "Context fixture" })
      await client.subscribe("context-fixture")
      await client.admit({
        session_id: "context-fixture",
        input_id: "input",
        prompt: "Inspect the declared references",
      })
      await Promise.race([
        finished.promise,
        Bun.sleep(15000).then(() => {
          throw new Error("Context fixture timed out")
        }),
      ])
      expect(requests).toHaveLength(3)
      expect(requests[0]).toContain("HOST_INSTRUCTION_MARKER")
      expect(requests[0]).toContain("fixture-skill")
      expect(requests[0]).toContain("Exact-file fixture reference")
      expect(requests[1]).toContain("AUTHORIZED_REFERENCE_MARKER")
      expect(requests.join("\n")).not.toContain("SIBLING_MUST_NOT_BE_READ")
      const completed = events.filter((event) => event.kind === "tool.completed")
      expect(completed).toHaveLength(2)
      expect(JSON.stringify(completed)).toContain("AUTHORIZED_REFERENCE_MARKER")
    } finally {
      await client.close()
      provider.stop(true)
    }
  },
  30000,
)
