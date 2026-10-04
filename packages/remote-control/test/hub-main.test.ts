import { test, expect } from "bun:test"
import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test.skipIf(process.platform === "win32")(
  "Hub executable boots private account storage, restarts without migration and rejects public credentials",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "miao-hub-main-"))
    const filename = path.join(directory, "config.json")
    const database = path.join(directory, "hub.db")
    const config = {
      mode: "account",
      database: "hub.db",
      baseURL: "https://relay.example.invalid",
      secret: "test-auth-secret-000000000000000000000000000",
      migrate: true,
      bootstrap: { name: "Owner", email: "owner@example.invalid", password: "fixture-password-0001" },
    }
    async function launch(migrate: boolean) {
      await Bun.write(filename, JSON.stringify({ ...config, migrate }))
      await chmod(filename, 0o600)
      const child = Bun.spawn([process.execPath, process.env.MIAO_HUB_TEST_ENTRY ?? "src/hub-main.ts"], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, MIAO_HUB_CONFIG: filename, MIAO_HUB_PORT: "0", MIAO_HUB_HOST: "127.0.0.1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const state = { output: "", port: 0 }
      const output = (async () => {
        const reader = child.stdout.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) return
          state.output += decoder.decode(chunk.value, { stream: true })
          const port = /Remote Control Hub listening on [^\n]+:(\d+)/.exec(state.output)
          if (port) state.port = Number(port[1])
        }
      })()
      const errors = new Response(child.stderr).text()
      const stop = async () => {
        child.kill()
        await child.exited
        await output
        await errors
      }
      const deadline = Date.now() + 10_000
      while (!state.port && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20)
      if (!state.port) {
        await stop()
        throw new Error("Private Hub executable did not become ready")
      }
      return { url: `http://127.0.0.1:${state.port}`, stop }
    }
    try {
      const first = await launch(true)
      try {
        expect((await fetch(first.url + "/health")).status).toBe(200)
        expect((await stat(database)).mode & 0o077).toBe(0)
      } finally {
        await first.stop()
      }
      const second = await launch(false)
      try {
        const login = await fetch(second.url + "/api/auth/sign-in/email", {
          method: "POST",
          headers: { origin: config.baseURL, "content-type": "application/json" },
          body: JSON.stringify({ email: config.bootstrap.email, password: config.bootstrap.password }),
        })
        expect(login.status).toBe(200)
        expect(login.headers.get("set-auth-token")).toBeTruthy()
      } finally {
        await second.stop()
      }
      await chmod(filename, 0o644)
      const rejected = Bun.spawn([process.execPath, process.env.MIAO_HUB_TEST_ENTRY ?? "src/hub-main.ts"], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, MIAO_HUB_CONFIG: filename, MIAO_HUB_PORT: "0" },
        stdout: "ignore",
        stderr: "pipe",
      })
      const rejectedErrors = new Response(rejected.stderr).text()
      expect(await rejected.exited).not.toBe(0)
      expect(await rejectedErrors).toContain("owner-only regular file")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000,
)
