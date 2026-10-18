import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

/**
 * Two windows on one workspace share one native runtime: the second window
 * starts, places new Sessions on the engine instead of failing on the store
 * lease, reads the first window's Session, and keeps working after the first
 * window exits.
 */
test.skipIf(!binary)(
  "two windows share a native runtime and survive the first window exiting",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("", { status: 500 })
      },
    })
    const env = {
      ...process.env,
      MIAO_DB: path.join(tmp.path, "product.db"),
      MIAO_ENGINE_BIN: binary,
      MIAO_ENGINE_PROVIDER: "openai-chat",
      MIAO_ENGINE_MODEL: "fixture",
      MIAO_ENGINE_ENDPOINT: new URL("fixture", provider.url).toString(),
      MIAO_ENGINE_STORAGE: path.join(tmp.path, "native"),
      OPENAI_API_KEY: "fixture-only",
      MIAO_PURE: "1",
      MIAO_SERVER_PASSWORD: "",
      MIAO_SERVER_USERNAME: "",
      MIAO_TEST_HOME: tmp.path,
      MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
      XDG_DATA_HOME: path.join(tmp.path, "data"),
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
    }
    const headers = { "content-type": "application/json", "x-opencode-directory": directory }
    const windows: { url: string; child: ReturnType<typeof Bun.spawn> }[] = []
    const start = async () => {
      const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: path.join(import.meta.dir, "../.."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let output = ""
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`server startup timeout: ${output}`)), 20_000)
        })
        const result = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer))
        if (result.done) throw new Error(`server exited: ${output}`)
        output += decoder.decode(result.value)
        const match = output.match(/miao server listening on (http:\/\/\S+)/)
        if (match) {
          reader.releaseLock()
          const window = { url: match[1], child }
          windows.push(window)
          return window
        }
      }
    }
    const create = async (url: string, session: string) => {
      const response = await fetch(`${url}/api/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: session, location: { directory } }),
      })
      expect(response.status).toBe(200)
      const info = await (await fetch(`${url}/api/session/${session}`, { headers })).json()
      expect(info.data.execution.engine).toBe("rust")
    }
    const kill = async (window: { child: ReturnType<typeof Bun.spawn> }) => {
      window.child.kill("SIGTERM")
      await window.child.exited
    }
    try {
      const first = await start()
      await create(first.url, "ses_window_a")
      const second = await start()
      // Shared storage: the second window must not fail with a store lease.
      await create(second.url, "ses_window_b")
      // Both windows read the same engine-owned Session.
      const seen = await fetch(`${second.url}/api/session/ses_window_a`, { headers })
      expect(seen.status).toBe(200)
      expect((await seen.json()).data.execution.engine).toBe("rust")
      expect((await fetch(`${second.url}/api/session/ses_window_a/context`, { headers })).status).toBe(200)
      // The runtime outlives the window that first opened it.
      await kill(first)
      await create(second.url, "ses_window_c")
      expect((await fetch(`${second.url}/api/session/ses_window_a`, { headers })).status).toBe(200)
    } finally {
      for (const window of windows) {
        window.child.kill("SIGTERM")
        await window.child.exited.catch(() => {})
      }
      provider.stop(true)
    }
  },
  60_000,
)
