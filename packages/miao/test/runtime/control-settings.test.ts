import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ControlHub } from "@miao/remote-control/hub"
import { RuntimeControlAgent } from "../../src/runtime/control-agent"

async function connected(manager: NonNullable<Awaited<ReturnType<typeof RuntimeControlAgent.start>>>) {
  const until = Date.now() + 5000
  while (!manager.administration.status().connected && Date.now() < until) await Bun.sleep(10)
  expect(manager.administration.status().connected).toBe(true)
}

test("owner configuration connects and switches only relay transport, preserving the host identity across restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "miao-control-settings-"))
  const storage = path.join(directory, "sessions.db")
  const filename = path.join(storage + ".remote-control", "control.json")
  const tokens = new Map<string, string>()
  const hubs: ReturnType<typeof ControlHub.listen>[] = []
  const previous = process.env.MIAO_REMOTE_CONTROL_CONFIG
  delete process.env.MIAO_REMOTE_CONTROL_CONFIG
  const managers: NonNullable<Awaited<ReturnType<typeof RuntimeControlAgent.start>>>[] = []
  try {
    const manager = await RuntimeControlAgent.start({
      storage,
      url: "http://127.0.0.1:1",
      credential: "local-only",
      runtimeID: crypto.randomUUID(),
      allowLoopbackHTTP: true,
    })
    expect(manager).toBeDefined()
    managers.push(manager!)
    const before = manager!.administration.status()
    expect(before.enabled).toBe(false)
    expect(before.hostID).toBeDefined()
    const token = crypto.randomUUID() + crypto.randomUUID()
    tokens.set(before.hostID!, token)
    const first = ControlHub.listen({ port: 0, hosts: tokens })
    const second = ControlHub.listen({ port: 0, hosts: tokens })
    hubs.push(first, second)
    const configure = manager!.administration.configure!
    await configure({ hubURL: `http://127.0.0.1:${first.port}`, hostToken: token })
    await connected(manager!)
    expect(manager!.administration.status()).toMatchObject({
      hostID: before.hostID,
      runtimeID: before.runtimeID,
      hostPublicKey: before.hostPublicKey,
    })
    // Windows stat exposes synthetic Unix mode bits, not the file's ACL.
    if (process.platform !== "win32") {
      expect((await stat(filename)).mode & 0o777).toBe(0o600)
      expect((await stat(path.dirname(filename))).mode & 0o777).toBe(0o700)
    }
    const saved = await readFile(filename, "utf8")
    await expect(configure({ hubURL: "https://user:secret@example.invalid/path", hostToken: token })).rejects.toThrow()
    await expect(configure({ hubURL: "https://example.invalid", hostToken: "bad\r\nheader" })).rejects.toThrow()
    expect(await readFile(filename, "utf8")).toBe(saved)
    expect(manager!.administration.status().connected).toBe(true)
    await configure({ hubURL: `http://127.0.0.1:${second.port}`, hostToken: token })
    await connected(manager!)
    expect(manager!.administration.status().hubURL).toBe(`http://127.0.0.1:${second.port}`)
    const until = Date.now() + 3000
    while (first.connectedHosts().length && Date.now() < until) await Bun.sleep(10)
    expect(first.connectedHosts()).toHaveLength(0)
    expect(second.connectedHosts()).toHaveLength(1)
    expect(JSON.stringify(manager!.administration.status())).not.toContain(token)
    await manager!.stop()
    const restored = await RuntimeControlAgent.start({
      storage,
      url: "http://127.0.0.1:1",
      credential: "new-local-only",
      runtimeID: crypto.randomUUID(),
    })
    managers.push(restored!)
    await connected(restored!)
    expect(restored!.administration.status()).toMatchObject({
      hostID: before.hostID,
      hostPublicKey: before.hostPublicKey,
    })
    expect(restored!.administration.status().runtimeID).not.toBe(before.runtimeID)
  } finally {
    await Promise.all(managers.map((manager) => manager.stop()))
    await Promise.all(hubs.map((hub) => hub.stop()))
    if (previous === undefined) delete process.env.MIAO_REMOTE_CONTROL_CONFIG
    else process.env.MIAO_REMOTE_CONTROL_CONFIG = previous
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

test("production owner configuration rejects plaintext and unsafe existing targets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "miao-control-private-"))
  const storage = path.join(directory, "sessions.db")
  const filename = path.join(storage + ".remote-control", "control.json")
  const previous = process.env.MIAO_REMOTE_CONTROL_CONFIG
  delete process.env.MIAO_REMOTE_CONTROL_CONFIG
  const manager = await RuntimeControlAgent.start({
    storage,
    url: "http://127.0.0.1:1",
    credential: "local-only",
    runtimeID: crypto.randomUUID(),
  })
  try {
    const token = crypto.randomUUID() + crypto.randomUUID()
    await expect(
      manager!.administration.configure!({ hubURL: "http://127.0.0.1:4600", hostToken: token }),
    ).rejects.toThrow()
    const target = path.join(directory, "unrelated.json")
    await writeFile(target, "unrelated owner data", { mode: 0o600 })
    await symlink(target, filename)
    await expect(
      manager!.administration.configure!({ hubURL: "https://example.invalid", hostToken: token }),
    ).rejects.toThrow()
    expect(await readFile(target, "utf8")).toBe("unrelated owner data")
    expect(manager!.administration.status().enabled).toBe(false)
  } finally {
    await manager?.stop()
    if (previous === undefined) delete process.env.MIAO_REMOTE_CONTROL_CONFIG
    else process.env.MIAO_REMOTE_CONTROL_CONFIG = previous
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)
