import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { RuntimeDiscovery } from "@miao/core/runtime/discovery"
import { RuntimeOwnership } from "@miao/core/runtime/ownership"
import { InstallationVersion } from "@miao/core/installation/version"
import { ControlHub } from "@miao/remote-control/hub"
import { DeviceGrants } from "@miao/remote-control/grants"
import { SecureChannel } from "@miao/remote-control/secure-channel"

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

test("selection RPCs persist agent/model choices and reconcile exact retries without duplicate events", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "miao-selection-"))
  const database = path.join(directory, "sessions.db")
  const project = path.join(directory, "project")
  const sessionID = "ses_selection_" + crypto.randomUUID().replaceAll("-", "")
  const grants = await DeviceGrants.load(path.join(directory, "devices.json"))
  const device = await SecureChannel.createIdentity()
  const grant = await grants.approve({
    publicKey: device.publicKey,
    label: "Selection fixture",
    permissions: ["read", "session.selection"],
    projectIDs: [],
    sessionIDs: [sessionID],
    expiresAt: Date.now() + 120000,
  })
  const hostID = grants.hostID
  const hostKey = grants.identity.publicKey
  const token = crypto.randomUUID() + crypto.randomUUID()
  const hub = ControlHub.listen({ port: 0, hosts: new Map([[hostID, token]]) })
  let runtime: ReturnType<typeof Bun.spawn> | undefined
  let socket: WebSocket | undefined
  let stdout: Promise<string> | undefined
  let stderr: Promise<string> | undefined
  try {
    const configuration = path.join(directory, "control.json")
    await Bun.write(
      configuration,
      JSON.stringify({
        hubURL: `http://127.0.0.1:${hub.port}`,
        hostToken: token,
        grantFile: "devices.json",
        allowLoopbackHTTP: true,
      }),
    )
    await chmod(configuration, 0o600)
    await grants.close()
    await mkdir(project)
    expect(await Bun.spawn(["git", "init", "--quiet", project]).exited).toBe(0)
    const started = Bun.spawn([process.execPath, "run", "src/index.ts", "runtime"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
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
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    runtime = started
    stdout = new Response(started.stdout).text()
    stderr = new Response(started.stderr).text()
    const storageID = createHash("sha256")
      .update(await RuntimeOwnership.canonicalStorage(database))
      .digest("hex")
    let owner: RuntimeDiscovery.Record | undefined
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (runtime.exitCode !== null) throw new Error("Fixture Runtime exited before readiness")
      const candidate = await RuntimeDiscovery.read(database)
      if (candidate)
        owner = await RuntimeDiscovery.attest(candidate, { version: InstallationVersion, storageID }).catch(
          () => undefined,
        )
      if (owner) break
      await Bun.sleep(100)
    }
    if (!owner) throw new Error("Fixture Runtime readiness timed out")
    const record = owner
    const local = async (route: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(new URL(route, record.url), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`miao:${record.credential}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error("Fixture owner API failed")
      const text = await response.text()
      return text ? JSON.parse(text) : undefined
    }
    await local("/api/session", { id: sessionID, location: { directory: project } })
    const connectedDeadline = Date.now() + 10000
    while (!hub.connectedHosts().length && Date.now() < connectedDeadline) await Bun.sleep(20)
    expect(hub.connectedHosts()).toHaveLength(1)
    socket = new WebSocket(`ws://127.0.0.1:${hub.port}/v1/client?hostID=${hostID}`)
    const ws = socket
    const frames: string[] = []
    let waiting: ((value: string) => void) | undefined
    ws.addEventListener("message", (event) => {
      if (waiting) {
        const resolve = waiting
        waiting = undefined
        resolve(String(event.data))
      } else frames.push(String(event.data))
    })
    const receive = () =>
      frames.length
        ? Promise.resolve(frames.shift()!)
        : new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
              waiting = undefined
              reject(new Error("Selection fixture response timed out"))
            }, 15000)
            waiting = (value) => {
              clearTimeout(timer)
              resolve(value)
            }
          })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Selection fixture connection timed out")), 10000)
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer)
          reject(new Error("Selection fixture connection failed"))
        },
        { once: true },
      )
    })
    const target = { hostID, runtimeID: record.runtimeID }
    const handshake = await SecureChannel.startClient(device, target)
    ws.send(Buffer.from(JSON.stringify(handshake.hello)).toString("base64url"))
    const accepted = await handshake.finish(JSON.parse(Buffer.from(await receive(), "base64url").toString()), hostKey)
    const request = async (method: string, operationID: string, payload: unknown) => {
      ws.send(
        await accepted.channel.seal(
          new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              requestID: crypto.randomUUID(),
              ...target,
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
      const value: unknown = JSON.parse(new TextDecoder().decode(await accepted.channel.open(await receive())))
      if (!object(value)) throw new Error("Invalid selection fixture response")
      return value
    }
    const agentOperation = crypto.randomUUID()
    const modelOperation = crypto.randomUUID()
    for (let index = 0; index < 2; index++) {
      expect(await request("session.switchAgent", agentOperation, { agent: "plan" })).toMatchObject({
        type: "result",
        data: { status: "completed" },
      })
      expect(
        await request("session.switchModel", modelOperation, {
          model: { providerID: "fixture", id: "model", variant: "reasoning" },
        }),
      ).toMatchObject({ type: "result", data: { status: "completed" } })
    }
    expect(
      await request("session.switchModel", modelOperation, { model: { providerID: "fixture", id: "different" } }),
    ).toMatchObject({ type: "error", code: "conflict" })
    expect(
      await request("session.switchModel", crypto.randomUUID(), {
        model: { providerID: "fixture", id: "model", headers: { authorization: "fixture" } },
      }),
    ).toMatchObject({ type: "error", code: "invalid_request" })
    const info = await local(`/api/session/${sessionID}`)
    expect(info).toMatchObject({
      data: { agent: "plan", model: { providerID: "fixture", id: "model", variant: "reasoning" } },
    })
    const history = await local(`/api/session/${sessionID}/history?after=0&limit=100`)
    if (!object(history) || !Array.isArray(history.data)) throw new Error("Fixture history missing")
    expect(
      history.data.filter((event: unknown) => object(event) && event.type === "session.next.agent.switched"),
    ).toHaveLength(1)
    expect(
      history.data.filter((event: unknown) => object(event) && event.type === "session.next.model.switched"),
    ).toHaveLength(1)
  } finally {
    socket?.close()
    if (runtime) {
      runtime.kill()
      const timer = setTimeout(() => runtime?.kill("SIGKILL"), 10000)
      await runtime.exited
      clearTimeout(timer)
    }
    await Promise.all([stdout, stderr])
    await grants.close()
    await hub.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 90000)
