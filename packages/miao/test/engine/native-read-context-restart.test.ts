import { expect, test } from "bun:test"
import path from "node:path"
import { rm } from "node:fs/promises"
import { EngineClient, engineArgs, engineEnvironment } from "../../src/engine/client"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "nested read instructions survive SIGKILL and refresh on an explicit continuation",
  async () => {
    await using tmp = await tmpdir()
    const workspace = path.join(tmp.path, "workspace")
    const target = path.join(workspace, "src", "marker.txt")
    const instruction = path.join(workspace, "src", "AGENTS.md")
    await Bun.write(target, "DURABLE_READ_RESULT\n")
    await Bun.write(instruction, "NESTED_RULE_BEFORE_CRASH\n")
    const policy = path.join(tmp.path, "policy.json")
    await Bun.write(
      policy,
      JSON.stringify({ mode: "workspace", rules: [{ tool: "read_file", path: "**", decision: "allow" }] }),
    )
    const bodies: string[] = []
    const pending = Promise.withResolvers<void>()
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        bodies.push(JSON.stringify(await request.json()))
        // Receiving turn two proves the read settlement and its instruction
        // selection committed. Leave provider work unfinished when SIGKILL lands.
        if (bodies.length === 2) {
          pending.resolve()
          return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
        }
        const first = bodies.length === 1
        const delta = first
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "read-before-crash",
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: "src/marker.txt" }) },
                },
              ],
            }
          : { role: "assistant", content: "explicit continuation completed" }
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const options = {
      binary: binary!,
      db: path.join(tmp.path, "engine.db"),
      workspace,
      policyFile: policy,
      model: "fixture",
      provider: "openai-chat",
      endpoint: new URL("chat/completions", provider.url).toString(),
      env: { OPENAI_API_KEY: "fixture-only" },
    }
    const session = "ses_read_restart"
    const child = Bun.spawn([options.binary, ...engineArgs(options)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: engineEnvironment(options.env),
    })
    const output = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const deadline = setTimeout(() => child.kill(9), 15_000)
    try {
      child.stdin.write(
        JSON.stringify({
          id: 1,
          method: "admit",
          params: {
            input: { session_id: session, input_id: "first", prompt: "Read the marker", delivery: "steer" },
            resume: true,
          },
        }) + "\n",
      )
      await Promise.race([
        pending.promise,
        child.exited.then(async () => {
          throw new Error(`engine exited before pending provider turn: ${await stderr} ${await output}`)
        }),
      ])
      expect(bodies).toHaveLength(2)
      expect(bodies[0]).not.toContain("NESTED_RULE_BEFORE_CRASH")
      expect(bodies[1]).toContain("NESTED_RULE_BEFORE_CRASH")
      expect(bodies[1]).toContain("DURABLE_READ_RESULT")
      child.kill(9)
      await child.exited
      expect(child.signalCode).toBe("SIGKILL")
      await rm(target)
      await Bun.write(instruction, "NESTED_RULE_AFTER_CRASH\n")
      const client = EngineClient.start(options)
      const finished = Promise.withResolvers<void>()
      const runs = new Set<string>()
      client.onEvent((event) => {
        if (event.session_id !== session || typeof event.data !== "object" || event.data === null) return
        if (!("run_id" in event.data) || typeof event.data.run_id !== "string") return
        if (event.kind === "run.started") runs.add(event.data.run_id)
        if (event.kind === "run.finished" && runs.has(event.data.run_id)) finished.resolve()
      })
      try {
        const snapshot = (await client.request("snapshot", { session_id: session })) as { cursor: number }
        expect(snapshot.cursor).toBeGreaterThan(0)
        // Opening/read-only access is not authority to retry unfinished provider work.
        expect(bodies).toHaveLength(2)
        // Replayed completion of the interrupted run is not this continuation.
        await client.subscribe(session, snapshot.cursor)
        await client.admit({ session_id: session, input_id: "second", prompt: "Continue explicitly" })
        await Promise.race([
          finished.promise,
          Bun.sleep(15_000).then(() => {
            throw new Error(`explicit continuation timed out: ${client.stderrText}`)
          }),
        ])
        expect(bodies).toHaveLength(3)
        expect(bodies[2]).toContain("NESTED_RULE_AFTER_CRASH")
        expect(bodies[2]).not.toContain("NESTED_RULE_BEFORE_CRASH")
        expect(bodies[2]).toContain("DURABLE_READ_RESULT")
        expect(bodies[2]).toContain("Continue explicitly")
        const events = (await client.request("events", { session_id: session, after: 0 })) as {
          kind: string
          data: unknown
        }[]
        expect(events.filter((event) => event.kind === "tool.completed")).toHaveLength(1)
        expect(JSON.stringify(events)).toContain("explicit continuation completed")
        expect(await Bun.file(target).exists()).toBe(false)
      } finally {
        await client.close()
      }
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null) child.kill(9)
      await child.exited
      await output
      await stderr
      await provider.stop(true)
    }
  },
  40_000,
)
