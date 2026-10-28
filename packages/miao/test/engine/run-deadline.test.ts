import { expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { runEnginePrompt } from "@/engine/run"
import { tmpdir } from "../fixture/fixture"

for (const stalled of ["initialize", "select_model", "subscribe", "admit"]) {
  test.skipIf(process.platform === "win32")(
    `the headless deadline includes a stalled ${stalled} request`,
    async () => {
      await using tmp = await tmpdir()
      const binary = path.join(tmp.path, "engine")
      const requests = path.join(tmp.path, "requests")
      // A tiny POSIX wire peer avoids charging a second Bun runtime's cold startup
      // to the shared deadline under test.
      await Bun.write(
        binary,
        `#!/bin/sh
while IFS= read -r request; do
  id="\${request#*\\\"id\\\":}"
  id="\${id%%,*}"
  for method in initialize select_model subscribe admit; do
    case "$request" in
      *\\\"method\\\":\\\"$method\\\"*)
        printf '%s\\n' "$method" >> ${JSON.stringify(requests)}
        if [ "$method" = ${JSON.stringify(stalled)} ]; then continue 2; fi
        ;;
    esac
  done
  printf '{"id":%s,"result":{"accepted":true}}\\n' "$id"
done
`,
      )
      await chmod(binary, 0o755)
      const started = performance.now()
      await expect(
        runEnginePrompt({
          binary,
          db: path.join(tmp.path, "engine.db"),
          workspace: tmp.path,
          model: "fixture",
          modelRoute: { route_id: "fixture", protocol: "openai-chat", model: "fixture" },
          prompt: "offline deadline fixture",
          timeoutMs: 3000,
          requestTimeoutMs: 8000,
        }),
      ).rejects.toMatchObject({ code: "engine_timeout" })
      expect(performance.now() - started).toBeLessThan(6000)
      expect((await Bun.file(requests).text()).trim().split("\n").at(-1)).toBe(stalled)
    },
    15_000,
  )
}
