import { expect, test } from "bun:test"
import path from "node:path"
import { engineArgs } from "@/engine/client"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let line = ""
  const decoder = new TextDecoder()
  while (!line.endsWith("\n")) {
    const { done, value } = await reader.read()
    if (done) break
    line += decoder.decode(value, { stream: true })
    const newline = line.indexOf("\n")
    if (newline >= 0) {
      reader.releaseLock()
      return line.slice(0, newline)
    }
  }
  reader.releaseLock()
  return line
}

test.skipIf(!binary)(
  "an idle stdio engine reclaims itself after its last client request",
  async () => {
    await using tmp = await tmpdir()
    const args = engineArgs({
      binary: binary!,
      db: path.join(tmp.path, "native.db"),
      workspace: tmp.path,
      model: "fixture",
      provider: "openai-chat",
    })
    const child = Bun.spawn([binary!, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENAI_API_KEY: "fixture-only", MIAO_ENGINE_STDIO_IDLE_SECS: "2" },
    })
    void Bun.readableStreamToText(child.stderr)
    child.stdin.write(JSON.stringify({ id: 1, method: "sessions" }) + "\n")
    const reply = JSON.parse(await readLine(child.stdout))
    expect(reply).toMatchObject({ id: 1, result: [] })
    // No Shutdown and no client close(): the engine must exit on its own once
    // the idle window passes without another client request.
    const exited = Promise.race([
      child.exited.then((code) => code),
      Bun.sleep(15_000).then(() => {
        throw new Error("engine did not reclaim itself within 15s")
      }),
    ])
    expect(await exited).toBe(0)
  },
  20_000,
)
