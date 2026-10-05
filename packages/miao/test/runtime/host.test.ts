import { expect, test } from "bun:test"
import { $ } from "bun"
import { Database } from "bun:sqlite"
import { OpenCode } from "@miao/client"
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
import { ControlPairing } from "@miao/remote-control/pairing"

test("Runtime owns storage, hosts Remote Control, authenticates clients, and persists sessions across restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-host-test-"))
  const database = path.join(directory, "sessions.db")
  const project = path.join(directory, "project")
  await mkdir(project)
  await $`git init --quiet ${project}`
  await $`git -C ${project} -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty --quiet -m fixture`
  const sessionID = "ses_remote_runtime_test"
  const grants = await DeviceGrants.load(path.join(directory, "devices.json"))
  const device = await SecureChannel.createIdentity()
  const grant = await grants.approve({
    publicKey: device.publicKey,
    label: "test phone",
    permissions: ["read", "prompt", "interrupt", "session.rename", "permission.reply", "question.reply"],
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
    MIAO_CONFIG_CONTENT: JSON.stringify({ formatter: false, lsp: false }),
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
  const access = async (input: Record<string, unknown> | string) => {
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "runtime", "access"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: environment,
      stdin: new Blob([typeof input === "string" ? input : JSON.stringify({ version: 1, ...input })]),
      stdout: "pipe",
      stderr: "pipe",
    })
    children.push(child)
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(output).not.toContain(hostToken)
    return JSON.parse(output)
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
  const connection = async (
    record: RuntimeDiscovery.Record,
    identity = device,
    invitation?: ControlPairing.Invitation,
  ) => {
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
    const handshake = await SecureChannel.startClient(identity, { hostID: grants.hostID, runtimeID: record.runtimeID })
    socket.send(
      Buffer.from(
        JSON.stringify(
          invitation
            ? {
                pairingID: invitation.pairingID,
                label: "new phone",
                hello: handshake.hello,
                proof: ControlPairing.proof(invitation, "new phone", handshake.hello),
              }
            : handshake.hello,
        ),
      ).toString("base64url"),
    )
    const channel = (
      await handshake.finish(
        JSON.parse(Buffer.from(await receive(), "base64url").toString()),
        invitation?.hostPublicKey ?? grants.identity.publicKey,
      )
    ).channel
    return { socket, receive, channel }
  }
  const connectRemote = async (record: RuntimeDiscovery.Record, approved: DeviceGrants.Grant) => {
    const transport = await connection(record)
    const call = async (
      method: string,
      payload: unknown,
      operationID?: string,
      projectID?: string,
      targetSessionID = sessionID,
    ) => {
      transport.socket.send(
        await transport.channel.seal(
          new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              requestID: crypto.randomUUID(),
              hostID: grants.hostID,
              runtimeID: record.runtimeID,
              grantID: approved.id,
              grantVersion: approved.version,
              method,
              sessionID: targetSessionID,
              operationID,
              projectID,
              payload,
            }),
          ),
        ),
      )
      return JSON.parse(new TextDecoder().decode(await transport.channel.open(await transport.receive()))) as {
        type: string
        data?: unknown
        code?: string
      }
    }
    return call
  }
  try {
    expect(await access({ method: "status" })).toMatchObject({ ok: false, error: "noRuntime" })
    expect(await RuntimeDiscovery.read(database)).toBeUndefined()
    expect(await access({ method: "status", password: "secret-extra-field" })).toMatchObject({
      ok: false,
      error: "invalidRequest",
    })
    expect(await access("{invalid")).toMatchObject({ ok: false, error: "invalidRequest" })
    expect(await access(" ".repeat(65_537))).toMatchObject({ ok: false, error: "invalidRequest" })
    const first = start()
    const record = await ready(first)
    expect(await access({ method: "status" })).toMatchObject({
      version: 1,
      ok: true,
      runtimeID: record.runtimeID,
      data: { enabled: true, hostID: grants.hostID },
    })
    expect(
      await access({
        method: "invite",
        runtimeID: "wrong-runtime-identity",
        policy: {
          permissions: ["read"],
          sessionIDs: [sessionID],
          projectIDs: [],
          expiresAt: Date.now() + 60_000,
        },
      }),
    ).toMatchObject({ ok: false, error: "runtimeChanged" })
    expect(await access({ method: "pending", runtimeID: record.runtimeID })).toMatchObject({ ok: true, data: [] })
    const headers = { authorization: `Basic ${Buffer.from(`miao:${record.credential}`).toString("base64")}` }
    expect((await fetch(new URL("/api/health", record.url))).status).toBe(401)
    expect((await fetch(new URL("/api/remote", record.url), { headers })).status).toBe(404)
    const created = await fetch(new URL("/api/session", record.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ id: sessionID, location: { directory: project } }),
    })
    expect(created.status).toBe(200)
    const session = ((await created.json()) as { data: { id: string; projectID: string } }).data
    expect((await fetch(new URL("/api/runtime/control", record.url))).status).toBe(401)
    const control = await fetch(new URL("/api/runtime/control", record.url), { headers })
    expect(await control.json()).toMatchObject({ enabled: true, hostID: grants.hostID })
    const configureURL = new URL("/api/runtime/control/configuration", record.url)
    expect(
      (
        await fetch(configureURL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hubURL: `http://127.0.0.1:${hub.port}`, hostToken }),
        })
      ).status,
    ).toBe(401)
    const sdk = OpenCode.make({ baseUrl: record.url, headers })
    const invalidToken = "private-token-must-not-appear-in-errors!"
    const rejectedConfiguration = await fetch(configureURL, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ hubURL: `http://127.0.0.1:${hub.port}`, hostToken: invalidToken }),
    })
    expect(rejectedConfiguration.status).toBe(400)
    expect(await rejectedConfiguration.text()).not.toContain(invalidToken)
    const configured = await sdk["server.runtime"].configure({ hubURL: `http://127.0.0.1:${hub.port}`, hostToken })
    expect(configured).toMatchObject({ enabled: true, hostID: grants.hostID, runtimeID: record.runtimeID })
    expect((await RuntimeDiscovery.read(database))?.runtimeID).toBe(record.runtimeID)
    expect(await sdk.sessions.get({ sessionID })).toMatchObject({ id: sessionID, projectID: session.projectID })
    expect(await access({ method: "session", runtimeID: record.runtimeID, sessionID })).toMatchObject({
      ok: true,
      data: { sessionID, projectID: session.projectID },
    })
    const invited = await access({
      method: "invite",
      runtimeID: record.runtimeID,
      policy: {
        permissions: ["read"],
        sessionIDs: [sessionID],
        projectIDs: [],
        expiresAt: Date.now() + 60_000,
      },
    })
    expect(invited.ok).toBe(true)
    const invitation = invited.data as ControlPairing.Invitation
    const newDevice = await SecureChannel.createIdentity()
    const provisional = await connection(record, newDevice, invitation)
    expect(
      JSON.parse(new TextDecoder().decode(await provisional.channel.open(await provisional.receive()))),
    ).toMatchObject({ type: "pairing", status: "pending" })
    expect(await access({ method: "pending", runtimeID: record.runtimeID })).toMatchObject({
      ok: true,
      data: [{ pairingID: invitation.pairingID, candidate: { publicKey: newDevice.publicKey } }],
    })
    expect(
      await access({
        method: "approve",
        runtimeID: record.runtimeID,
        pairingID: invitation.pairingID,
        publicKey: device.publicKey,
      }),
    ).toMatchObject({ ok: false, error: "unconfirmed" })
    const approved = await access({
      method: "approve",
      runtimeID: record.runtimeID,
      pairingID: invitation.pairingID,
      publicKey: newDevice.publicKey,
    })
    expect(approved.ok).toBe(true)
    const newGrant = approved.data as DeviceGrants.Grant
    expect(
      JSON.parse(new TextDecoder().decode(await provisional.channel.open(await provisional.receive()))),
    ).toMatchObject({ type: "pairing", status: "approved", grant: { id: newGrant.id } })
    provisional.socket.send(
      await provisional.channel.seal(
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            requestID: crypto.randomUUID(),
            hostID: grants.hostID,
            runtimeID: record.runtimeID,
            grantID: newGrant.id,
            grantVersion: newGrant.version,
            method: "session.get",
            sessionID,
            payload: {},
          }),
        ),
      ),
    )
    expect(
      JSON.parse(new TextDecoder().decode(await provisional.channel.open(await provisional.receive()))),
    ).toMatchObject({ type: "result", data: { id: sessionID } })
    expect(
      await access({
        method: "revoke",
        runtimeID: record.runtimeID,
        grantID: newGrant.id,
        grantVersion: newGrant.version + 1,
      }),
    ).toMatchObject({ ok: false, error: "unconfirmed" })
    expect(
      await access({
        method: "revoke",
        runtimeID: record.runtimeID,
        grantID: newGrant.id,
        grantVersion: newGrant.version,
      }),
    ).toMatchObject({
      ok: true,
      data: {
        id: newGrant.id,
        version: newGrant.version + 1,
        revokedAt: expect.any(Number),
      },
    })
    expect(await access({ method: "devices", runtimeID: record.runtimeID })).toMatchObject({
      ok: true,
      data: expect.arrayContaining([expect.objectContaining({ id: newGrant.id, revokedAt: expect.any(Number) })]),
    })
    const call = await connectRemote(record, grant)
    expect(await call("session.get", {})).toMatchObject({ type: "result", data: { id: sessionID } })
    const renameID = crypto.randomUUID()
    expect(await call("session.rename", { title: "Phone session" }, renameID)).toMatchObject({
      type: "result",
      data: { status: "completed" },
    })
    expect(await call("session.get", {})).toMatchObject({ type: "result", data: { title: "Phone session" } })
    const replay = await call("session.events", { after: 0, waitMs: 0 })
    const replayData = replay.data as { data: Array<{ id: string; durable: { seq: number } }>; cursor: number }
    expect(replayData.cursor).toBe(replayData.data.at(-1)!.durable.seq)
    expect(await call("session.events", { after: replayData.cursor, waitMs: 0 })).toMatchObject({
      type: "result",
      data: { data: [], cursor: replayData.cursor },
    })
    expect(await call("session.events", { after: replayData.cursor, waitMs: 50 })).toMatchObject({
      type: "result",
      data: { data: [], cursor: replayData.cursor },
    })
    const live = call("session.events", { after: replayData.cursor, waitMs: 1000 })
    await Bun.sleep(50)
    const changed = await fetch(new URL(`/api/session/${sessionID}/rename`, record.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "Live title" }),
    })
    if (changed.status !== 204)
      throw new Error(`Rename during event wait failed: ${changed.status} ${await changed.text()}`)
    const events = (await live).data as { data: Array<{ id: string }>; cursor: number }
    expect(events.data.length).toBeGreaterThan(0)
    expect(events.cursor).toBeGreaterThan(replayData.cursor)
    expect(events.data.some((event) => replayData.data.some((old) => old.id === event.id))).toBe(false)
    expect(await call("session.rename", { title: "Phone session" }, crypto.randomUUID())).toMatchObject({
      type: "result",
      data: { status: "completed" },
    })
    expect(await call("session.events", { after: 0, waitMs: 1001 })).toMatchObject({
      type: "error",
      code: "invalid_request",
    })
    expect(await call("selection.list", {})).toMatchObject({
      type: "result",
      data: { agents: expect.any(Array), models: expect.any(Array) },
    })
    expect(await call("session.rename", { title: "Changed retry" }, renameID)).toMatchObject({
      type: "error",
      code: "conflict",
    })
    expect(await call("session.interrupt", { executionID: "old-execution" }, crypto.randomUUID())).toMatchObject({
      type: "result",
      data: { status: "rejected", code: "conflict" },
    })
    expect(
      await call("permission.reply", { requestID: "per_missing", reply: "always" }, crypto.randomUUID()),
    ).toMatchObject({ type: "error", code: "invalid_request" })
    expect(
      await call("permission.reply", { requestID: "per_missing", reply: "once" }, crypto.randomUUID()),
    ).toMatchObject({ type: "result", data: { status: "rejected", code: "not_found" } })
    expect(await call("question.reply", { requestID: "que_missing", reject: true }, crypto.randomUUID())).toMatchObject(
      { type: "result", data: { status: "rejected", code: "not_found" } },
    )
    const sibling = await fetch(new URL("/api/session", record.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ id: "ses_unapproved_sibling", location: { directory: project } }),
    })
    expect(sibling.status).toBe(200)
    expect(await call("selection.list", {}, undefined, undefined, "ses_unapproved_sibling")).toMatchObject({
      type: "error",
      code: "forbidden",
    })
    expect(await call("session.list", {})).toMatchObject({
      type: "result",
      data: { data: [{ id: sessionID }], cursor: { next: null } },
    })
    expect(await call("project.list", {})).toMatchObject({ type: "result", data: { data: [] } })
    expect(await call("session.list", { directory: project })).toMatchObject({ type: "error", code: "invalid_request" })
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
    // Reproduce the crash window after preparing a mutation, before its durable
    // result. The next Runtime must not replay that mutation automatically.
    const unknownID = crypto.randomUUID()
    const stored = new Database(database)
    stored
      .query(
        "INSERT INTO remote_operation(subject,id,method,session_id,project_id,digest,status,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        createHash("sha256").update(`${grant.id}:${grant.publicKey}`).digest("hex"),
        unknownID,
        "session.rename",
        sessionID,
        null,
        createHash("sha256")
          .update(JSON.stringify({ title: "Interrupted rename" }))
          .digest("hex"),
        "prepared",
        Date.now(),
        Date.now(),
      )
    stored.close()
    const ownerGrants = await DeviceGrants.load(path.join(directory, "devices.json"))
    const projectGrant = await ownerGrants.approve({
      publicKey: device.publicKey,
      label: "project phone",
      permissions: ["read", "session.create"],
      projectIDs: [session.projectID],
      sessionIDs: [],
      expiresAt: Date.now() + 120_000,
    })
    await ownerGrants.close()
    const next = await ready(start())
    expect(next.runtimeID).not.toBe(record.runtimeID)
    expect(next.credential).not.toBe(record.credential)
    expect(await access({ method: "pending", runtimeID: record.runtimeID })).toMatchObject({
      ok: false,
      error: "runtimeChanged",
      runtimeID: next.runtimeID,
    })
    const resumed = await fetch(new URL(`/api/session/${session.id}`, next.url), {
      headers: { authorization: `Basic ${Buffer.from(`miao:${next.credential}`).toString("base64")}` },
    })
    expect(resumed.status).toBe(200)
    const devices = await fetch(new URL("/api/runtime/control/device", next.url), {
      headers: { authorization: `Basic ${Buffer.from(`miao:${next.credential}`).toString("base64")}` },
    })
    expect(await devices.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: newGrant.id, version: newGrant.version + 1, revokedAt: expect.any(Number) }),
      ]),
    )
    const restoredCall = await connectRemote(next, grant)
    expect(await restoredCall("session.rename", { title: "Interrupted rename" }, unknownID)).toMatchObject({
      type: "result",
      data: { status: "outcome_unknown" },
    })
    expect(await restoredCall("session.get", {})).toMatchObject({ type: "result", data: { title: "Phone session" } })
    expect(await restoredCall("operation.get", { operationID })).toMatchObject({
      type: "result",
      data: { status: "accepted", result: accepted.data },
    })
    expect(
      (await restoredCall("session.prompt", { text: "remote test input", delivery: "queue" }, operationID)).data,
    ).toEqual(accepted.data)
    const projectCall = await connectRemote(next, projectGrant)
    const projects = await projectCall("project.list", {})
    expect(projects.type).toBe("result")
    const directoryID = (
      projects.data as { data: Array<{ id: string; directories: Array<{ id: string }> }> }
    ).data.find((entry) => entry.id === session.projectID)?.directories[0]?.id
    expect(directoryID).toBeDefined()
    const createID = crypto.randomUUID()
    const remoteCreated = await projectCall("session.create", { directoryID }, createID, session.projectID)
    expect(remoteCreated).toMatchObject({
      type: "result",
      data: { status: "completed", session: { projectID: session.projectID } },
    })
    expect((await projectCall("session.create", { directoryID }, createID, session.projectID)).data).toEqual(
      remoteCreated.data,
    )
    expect(
      await projectCall("session.create", { directoryID, directory: project }, crypto.randomUUID(), session.projectID),
    ).toMatchObject({ type: "error", code: "invalid_request" })
    expect(
      await projectCall("session.create", { directoryID: "0".repeat(64) }, crypto.randomUUID(), session.projectID),
    ).toMatchObject({ type: "error", code: "forbidden" })
  } finally {
    sockets.forEach((socket) => socket.close())
    children.forEach((child) => {
      if (child.exitCode === null) child.kill("SIGTERM")
    })
    await Promise.all(children.map((child) => child.exited))
    await hub.stop()
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 120_000)
