import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip

real(
  "inspect lists failed HTTP attempts and successful recovery without manufacturing effective policy",
  async () => {
    await using tmp = await tmpdir()
    let requests = 0
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        requests++
        if (requests < 3) return new Response("capacity", { status: 503 })
        return new Response(
          [
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"RECOVERED"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const file = path.join(tmp.path, "bundle.json")
    const run = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, "src/blackbox/cli.ts", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, OPENAI_API_KEY: "fixture-only" },
      })
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { exit, stdout, stderr }
    }
    try {
      const captured = await run([
        "record-engine",
        "--bundle",
        file,
        "--binary",
        binary!,
        "--workspace",
        tmp.path,
        "--db",
        path.join(tmp.path, "record.db"),
        "--upstream",
        upstream.url.toString(),
        "--provider",
        "openai-chat",
        "--model",
        "wire-model",
        "--prompt",
        "recover",
      ])
      expect({ exit: captured.exit, stderr: captured.stderr }).toEqual({ exit: 0, stderr: "" })
      expect(requests).toBe(3)
      const inspected = await run(["inspect", "--bundle", file])
      expect({ exit: inspected.exit, stderr: inspected.stderr }).toEqual({ exit: 0, stderr: "" })
      const report = JSON.parse(inspected.stdout)
      expect(report.requestObservations.map((item: { ordinal: number }) => item.ordinal)).toEqual([0, 1, 2])
      expect(report.requestObservations.map((item: { httpStatus: number }) => item.httpStatus)).toEqual([503, 503, 200])
      expect(report.requestObservations.map((item: { model: string }) => item.model)).toEqual([
        "wire-model",
        "wire-model",
        "wire-model",
      ])
      expect(
        report.requestObservations.every(
          (item: { agentManifestHash: null; permissionHash: null }) =>
            item.agentManifestHash === null && item.permissionHash === null,
        ),
      ).toBe(true)
      expect(JSON.stringify(report.requestObservations)).not.toContain("recover")
      expect(inspected.stdout).not.toContain("fixture-only")
    } finally {
      upstream.stop(true)
    }
  },
  30000,
)
