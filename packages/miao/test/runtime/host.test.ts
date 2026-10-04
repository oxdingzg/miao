import { expect, test } from "bun:test"
import { RuntimeDiscovery } from "@miao/core/runtime/discovery"
import { RuntimeOwnership } from "@miao/core/runtime/ownership"
import { InstallationVersion } from "@miao/core/installation/version"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DeviceGrants } from "@miao/remote-control/grants"
import { SecureChannel } from "@miao/remote-control/secure-channel"
import { ControlHub } from "@miao/remote-control/hub"

test("Runtime owns storage, hosts IM controls, authenticates clients, and persists sessions across restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-host-test-"))
  const database = path.join(directory, "sessions.db")
  const project = path.join(directory, "project")
  await mkdir(project)
  const sessionID = "ses_remote_runtime_test"
  const grants = await DeviceGrants.load(path.join(directory, "devices.json"))
  const device = await SecureChannel.createIdentity()
  const grant = await grants.approve({
    publicKey: device.publicKey,
    label: "test phone",
    permissions: ["read", "prompt"],
    projectIDs: [],
    sessionIDs: [sessionID],
    expiresAt: Date.now() + 120_000,
  })
  const hostToken = "runtime-test-credential-0000000000000000000000000000"
  const hub = ControlHub.listen({ hosts: new Map([[grants.hostID, hostToken]]), port: 0 })
  const configuration = path.join(directory, "control.json")
  await Bun.write(
    configuration,
    JSON.stringify({
      hubURL: `http://127.0.0.1:${hub.port}`,
      hostToken,
      grantFile: "devices.json",
      allowLoopbackHTTP: true,
    }),
  )
  await chmod(configuration, 0o600)
  const environment = {
    ...process.env,
    MIAO_DB: database,
    MIAO_REMOTE_CONTROL_CONFIG: configuration,
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
  const sockets: WebSocket[] = []
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
      body: JSON.stringify({ id: sessionID, location: { directory: project } }),
    })
    expect(created.status).toBe(200)
    const session = ((await created.json()) as { data: { id: string } }).data
    // Use the actual encrypted Hub -> Runtime Agent -> local API path.
    const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/v1/client?hostID=${grants.hostID}`)
    sockets.push(socket)
    const messages: string[] = []
    socket.addEventListener("message", (event) => messages.push(String(event.data)))
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error("Remote test socket failed")), { once: true })
    })
    const receive = async () => {
      const deadline = Date.now() + 10_000
      while (!messages.length && Date.now() < deadline) await Bun.sleep(10)
      if (!messages.length) throw new Error("Runtime Agent response timed out")
      return messages.shift()!
    }
    const handshake = await SecureChannel.startClient(device, { hostID: grants.hostID, runtimeID: record.runtimeID })
    socket.send(Buffer.from(JSON.stringify(handshake.hello)).toString("base64url"))
    const channel = (
      await handshake.finish(
        JSON.parse(Buffer.from(await receive(), "base64url").toString()),
        grants.identity.publicKey,
      )
    ).channel
    const call = async (method: string, payload: unknown, operationID?: string) => {
      socket.send(
        await channel.seal(
          new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              requestID: crypto.randomUUID(),
              hostID: grants.hostID,
              runtimeID: record.runtimeID,
              grantID: grant.id,
              grantVersion: grant.version,
              method,
              sessionID,
              operationID,
              payload,
            }),
          ),
        ),
      )
      return JSON.parse(new TextDecoder().decode(await channel.open(await receive()))) as {
        type: string
        data?: unknown
        code?: string
      }
    }
    expect(await call("session.get", {})).toMatchObject({ type: "result", data: { id: sessionID } })
    const operationID = crypto.randomUUID()
    const accepted = await call("session.prompt", { text: "remote test input", delivery: "queue" }, operationID)
    expect(accepted).toMatchObject({ type: "result", data: { status: "accepted", sessionID } })
    expect((await call("session.prompt", { text: "remote test input", delivery: "queue" }, operationID)).data).toEqual(
      accepted.data,
    )
    expect(await call("session.prompt", { text: "conflicting input", delivery: "queue" }, operationID)).toMatchObject({
      type: "error",
      code: "conflict",
    })
    expect(await call("operation.get", { operationID })).toMatchObject({
      type: "result",
      data: { status: "accepted", result: accepted.data },
    })
    expect(await call("capabilities", {})).toMatchObject({
      type: "result",
      data: { operationReceipts: true, history: "paged" },
    })
    expect(await call("session.history", { after: 0, limit: 100 })).toMatchObject({
      type: "result",
      data: { hasMore: false },
    })
    expect(await call("session.history", { limit: 101 })).toMatchObject({ type: "error", code: "invalid_request" })
    expect(await call("session.pending", {})).toMatchObject({
      type: "result",
      data: { permissions: [], questions: [] },
    })
    const second = start()
    expect(await second.exited).not.toBe(0)
    expect(await new Response(second.stderr).text()).toContain("already has a running Runtime")
    const execution = await fetch(new URL(`/api/session/${session.id}/execution`, record.url), { headers })
    expect(execution.status).toBe(200)
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
    sockets.forEach((socket) => socket.close())
    children.forEach((child) => {
      if (child.exitCode === null) child.kill("SIGTERM")
    })
    await Promise.all(children.map((child) => child.exited))
    hub.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
