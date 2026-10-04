import { expect, test } from "bun:test"
import { RuntimeDiscovery } from "@miao/core/runtime/discovery"
import { RuntimeOwnership } from "@miao/core/runtime/ownership"
import { InstallationVersion } from "@miao/core/installation/version"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("Runtime owns storage, hosts IM controls, authenticates clients, and persists sessions across restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-host-test-"))
  const database = path.join(directory, "sessions.db")
  const project = path.join(directory, "project")
  await mkdir(project)
  const environment = {
    ...process.env,
    MIAO_DB: database,
    MIAO_PURE: "1",
    MIAO_CONFIG_CONTENT: JSON.stringify({ formatter: false, lsp: false, remote: { projects: {} } }),
    MIAO_TEST_HOME: path.join(directory, "home"),
    MIAO_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_STATE_HOME: path.join(directory, "state"),
  }
  const children: ReturnType<typeof Bun.spawn>[] = []
  const start = () => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "runtime"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    })
    children.push(child)
    return child
  }
  const ready = async (child: ReturnType<typeof start>) => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text())
      const record = await RuntimeDiscovery.read(database)
      if (record) {
        const verified = await RuntimeDiscovery.attest(record, {
          version: InstallationVersion,
          storageID: createHash("sha256")
            .update(await RuntimeOwnership.canonicalStorage(database))
            .digest("hex"),
        }).catch(() => undefined)
        if (verified) return verified
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("Runtime readiness timed out")
  }
  try {
    const first = start()
    const record = await ready(first)
    const status = Bun.spawn([process.execPath, "run", "src/index.ts", "remote", "status"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await status.exited).toBe(0)
    expect(await new Response(status.stdout).text()).toContain(record.url)
    const headers = { authorization: `Basic ${Buffer.from(`miao:${record.credential}`).toString("base64")}` }
    expect((await fetch(new URL("/api/health", record.url))).status).toBe(401)
    expect((await fetch(new URL("/api/remote", record.url), { headers })).status).toBe(200)
    const created = await fetch(new URL("/api/session", record.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ location: { directory: project } }),
    })
    expect(created.status).toBe(200)
    const session = ((await created.json()) as { data: { id: string } }).data
    const second = start()
    expect(await second.exited).not.toBe(0)
    expect(await new Response(second.stderr).text()).toContain("already has a running Runtime")
    const execution = await fetch(new URL(`/api/session/${session.id}/execution`, record.url), { headers })
    expect(await execution.json()).toEqual({ type: "idle" })
    expect((await fetch(new URL("/api/runtime/stop", record.url), { method: "POST" })).status).toBe(401)
    expect((await fetch(new URL("/api/runtime/stop", record.url), { method: "POST", headers })).status).toBe(204)
    expect(await first.exited).toBe(0)
    expect(await RuntimeDiscovery.read(database)).toBeUndefined()
    const next = await ready(start())
    expect(next.runtimeID).not.toBe(record.runtimeID)
    expect(next.credential).not.toBe(record.credential)
    const resumed = await fetch(new URL(`/api/session/${session.id}`, next.url), {
      headers: { authorization: `Basic ${Buffer.from(`miao:${next.credential}`).toString("base64")}` },
    })
    expect(resumed.status).toBe(200)
  } finally {
    children.forEach((child) => {
      if (child.exitCode === null) child.kill("SIGTERM")
    })
    await Promise.all(children.map((child) => child.exited))
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
