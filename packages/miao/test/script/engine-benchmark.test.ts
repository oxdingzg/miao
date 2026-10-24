import { expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

// PWD is a Unix shell contract; the fixture is a directly executable Bun script.
test.skipIf(process.platform === "win32")(
  "benchmark children resolve their task workspace instead of inherited PWD",
  async () => {
    await using tmp = await tmpdir()
    const log = path.join(tmp.path, "invocations.jsonl")
    const binary = path.join(tmp.path, "fixture-cli")
    await Bun.write(
      binary,
      `#!${process.execPath}
import { appendFileSync, realpathSync } from "node:fs"
appendFileSync(process.env.BENCH_INVOCATIONS, JSON.stringify({cwd:realpathSync(process.cwd()),pwd:realpathSync(process.env.PWD),storage:process.env.MIAO_ENGINE_STORAGE})+"\\n")
console.log(JSON.stringify({type:"text",part:{text:"I cannot change the guarded files."}}))
`,
    )
    await chmod(binary, 0o755)
    const child = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dir, "../../../../script/engine-benchmark.ts"),
        "--binary",
        binary,
        "--tasks",
        "impossible",
        "--engines",
        "ts,rust",
        "--repeat",
        "1",
        "--storage",
        path.join(tmp.path, "storage"),
      ],
      {
        cwd: tmp.path,
        env: { ...process.env, PWD: tmp.path, MIAO_ENGINE_STORAGE: "must-not-reach-ts", BENCH_INVOCATIONS: log },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
    expect(stdout).toContain("Failed attempts (every gate failure, with its reason):\n- none")
    const calls = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            cwd: string
            pwd: string
            storage?: string
          },
      )
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.pwd).toBe(call.cwd)
      expect(call.pwd).not.toBe(tmp.path)
    }
    expect(calls[0].storage).toBeUndefined()
    expect(calls[1].storage).toBe(path.join(tmp.path, "storage"))
  },
  20_000,
)
