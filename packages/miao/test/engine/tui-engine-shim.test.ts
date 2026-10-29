import { describe, expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { REQUIRED_PROTOCOL, REQUIRED_ROUTES_SCHEMA } from "@/engine/discovery"
import { tmpdir } from "../fixture/fixture"

const ENTRY = path.join(import.meta.dir, "../../src/index.ts")
const REPLY_BYTES = 2 * 1024 * 1024
const CAPABILITIES = JSON.stringify({
  catalog: 1,
  name: "miao-engine",
  protocol: REQUIRED_PROTOCOL,
  routes_schema: REQUIRED_ROUTES_SCHEMA,
  schema: REQUIRED_PROTOCOL,
  version: "0.0.0-test",
})

describe("engine shim", () => {
  test.skipIf(process.platform === "win32")(
    "delivers a reply larger than the reader's pipe buffer",
    async () => {
      await using tmp = await tmpdir()
      // A Session snapshot inlines its image attachments, so a reply can run to
      // megabytes. The shim is a byte relay on that path: every byte has to
      // arrive, or the TUI waits for a frame that never ends.
      const engine = path.join(tmp.path, "fake-engine")
      await Bun.write(
        engine,
        [
          "#!/bin/sh",
          `if [ "$1" = "--capabilities" ]; then`,
          `  printf '%s\\n' '${CAPABILITIES}'`,
          "  exit 0",
          "fi",
          `exec '${process.execPath}' -e 'process.stdout.write(JSON.stringify({id:1,result:"x".repeat(${REPLY_BYTES})})+"\\n")'`,
          "",
        ].join("\n"),
      )
      await chmod(engine, 0o755)
      const shim = Bun.spawn([process.execPath, ENTRY, "__engine-shim", "serve"], {
        env: { ...process.env, MIAO_ENGINE_BIN: engine },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      // Read behind a delay: a fast reader never lets the pipe fill, which is
      // what hid the truncation this test keeps out.
      const reply = shim.stdout.getReader()
      let relayed = ""
      for (;;) {
        const { done, value } = await reply.read()
        if (done) break
        relayed += new TextDecoder().decode(value)
        await Bun.sleep(2)
      }
      expect(await shim.exited).toBe(0)
      expect(JSON.parse(relayed)).toEqual({ id: 1, result: "x".repeat(REPLY_BYTES) })
    },
    30000,
  )
})
