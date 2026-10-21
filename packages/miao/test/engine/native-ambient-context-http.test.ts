import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "product ambient sources automatically reach the native child and refresh before admission",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    const skillDirectory = path.join(tmp.path, "host-skills")
    await mkdir(directory)
    await mkdir(skillDirectory)
    const instruction = path.join(tmp.path, "operator.md")
    const reference = path.join(tmp.path, "reference.txt")
    const sibling = path.join(tmp.path, "sibling.txt")
    const deniedInstruction = path.join(tmp.path, "denied.md")
    const deniedSkill = path.join(skillDirectory, "denied.md")
    await Bun.write(instruction, "AUTOMATIC_INSTRUCTION_FIRST")
    await Bun.write(path.join(directory, "AGENTS.md"), "WORKSPACE_INSTRUCTION_EXACTLY_ONCE")
    await Bun.write(reference, "AUTOMATIC_REFERENCE_BODY")
    await Bun.write(sibling, "UNAUTHORIZED_SIBLING_BODY")
    await Bun.write(deniedInstruction, "DENIED_INSTRUCTION_MUST_STAY_HIDDEN")
    await Bun.write(
      deniedSkill,
      "---\nname: forbidden-metadata\ndescription: DENIED_SKILL_METADATA\n---\nDENIED_SKILL_BODY\n",
    )
    await Bun.write(
      path.join(skillDirectory, "fixture.md"),
      "---\nname: automatic-fixture\ndescription: Automatic skill metadata\n---\nSKILL_BODY_ONLY_ON_DEMAND\n",
    )
    const policy = path.join(tmp.path, "policy.json")
    await Bun.write(
      policy,
      JSON.stringify({
        mode: "workspace",
        rules: [
          { tool: "read_file", path: "@reference" + deniedInstruction, decision: "deny" },
          { tool: "read_file", path: "@reference" + deniedSkill, decision: "deny" },
          { tool: "read_file", path: "**", decision: "allow" },
        ],
      }),
    )
    const requests: string[] = []
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push(JSON.stringify(await request.json()))
        const file =
          requests.length === 1
            ? reference
            : requests.length === 2
              ? sibling
              : requests[0]?.match(/automatic-fixture:[^(]*\(([^)]+)\)/)?.[1]
        const delta =
          requests.length < 4
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `read-${requests.length}`,
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: file }),
                    },
                  },
                ],
              }
            : { content: "ambient-acceptance-complete" }
        return new Response(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: requests.length < 4 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        MIAO_DB: path.join(tmp.path, "miao.db"),
        MIAO_ENGINE_BIN: binary,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture",
        MIAO_ENGINE_ENDPOINT: new URL("chat/completions", provider.url).toString(),
        MIAO_ENGINE_POLICY: policy,
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
        MIAO_ENGINE_CONTEXT_CONFIG: "",
        MIAO_ENGINE_SKILLS_CONFIG: "",
        MIAO_ENGINE_REFERENCES_CONFIG: "",
        OPENAI_API_KEY: "fixture-only",
        MIAO_PURE: "1",
        MIAO_SERVER_PASSWORD: "fixture-password",
        MIAO_SERVER_USERNAME: "fixture",
        MIAO_TEST_HOME: path.join(tmp.path, "home"),
        MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        MIAO_CONFIG_CONTENT: JSON.stringify({
          instructions: [instruction, deniedInstruction],
          skills: [skillDirectory],
          references: {
            fixture: { path: reference, description: "Automatic reference metadata" },
            missing: { path: path.join(tmp.path, "missing-reference"), description: "Missing reference metadata" },
            hiddenFixture: { path: sibling, hidden: true },
          },
          formatter: false,
          lsp: false,
        }),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = new Response(child.stderr).text()
    const timer = setTimeout(() => child.kill(), 30000)
    try {
      let output = ""
      let url = ""
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      while (!url) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`ambient server exited: ${await stderr} ${output}`)
        output += decoder.decode(chunk.value)
        url = output.match(/miao server listening on (http:\/\/[^\s]+)/)?.[1] ?? ""
      }
      const headers = {
        "x-opencode-directory": directory,
        "content-type": "application/json",
        authorization: "Basic " + btoa("fixture:fixture-password"),
      }
      const sessionID = "ses_automatic_context"
      const create = await fetch(url + "/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: sessionID, location: { directory } }),
      })
      if (!create.ok) throw new Error(await create.text())
      expect(create.status).toBe(200)
      const prompt = async (id: string, expected: number) => {
        const admitted = await fetch(url + `/api/session/${sessionID}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id, prompt: { text: "inspect the configured reference" } }),
        })
        if (!admitted.ok) throw new Error(`prompt ${admitted.status}: ${await admitted.text()}`)
        const deadline = Date.now() + 15000
        while (Date.now() < deadline) {
          const response = await fetch(url + `/api/session/${sessionID}/status`, { headers })
          const status = await response.json()
          if (requests.length >= expected && status.data.type === "idle") return
          await Bun.sleep(30)
        }
        throw new Error(`ambient acceptance timed out after ${requests.length} provider requests`)
      }
      await prompt("msg_automatic_first", 4)
      expect(requests[0]).toContain("AUTOMATIC_INSTRUCTION_FIRST")
      expect(requests[0]).toContain("automatic-fixture")
      expect(requests[0]?.match(/WORKSPACE_INSTRUCTION_EXACTLY_ONCE/g)).toHaveLength(1)
      expect(requests[0]).toContain("Automatic reference metadata")
      // A declared but absent reference must not reach the child as a grant:
      // the engine rejects an unknown grant path and would exit before serving.
      expect(requests[0]).not.toContain("Missing reference metadata")
      expect(requests[0]).not.toContain("SKILL_BODY_ONLY_ON_DEMAND")
      expect(requests[0]).not.toContain("DENIED_INSTRUCTION_MUST_STAY_HIDDEN")
      expect(requests[0]).not.toContain("DENIED_SKILL_METADATA")
      expect(requests[1]).toContain("AUTOMATIC_REFERENCE_BODY")
      expect(requests[3]).toContain("SKILL_BODY_ONLY_ON_DEMAND")
      expect(requests.join("\n")).not.toContain("UNAUTHORIZED_SIBLING_BODY")
      await Bun.write(instruction, "AUTOMATIC_INSTRUCTION_UPDATED")
      await prompt("msg_automatic_second", 5)
      expect(requests[4]).toContain("AUTOMATIC_INSTRUCTION_UPDATED")
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      provider.stop(true)
    }
  },
  40000,
)
