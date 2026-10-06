import { expect, test } from "bun:test"
import { Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { DeviceGrants } from "../src/grants"
import { PushSender } from "../src/push-sender"
import { PushContext } from "../src/push-context"
import { SecureChannel } from "../src/secure-channel"

test("Runtime hints use scoped device encryption, final drain transitions and revocation reconciliation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-push-sender-"))
  const grants = await DeviceGrants.load(path.join(directory, "devices.json"))
  const device = await SecureChannel.createIdentity()
  const unrelated = await SecureChannel.createIdentity()
  const sessionID = "ses_fixture_123456"
  const projectID = "proj_fixture_123456"
  const grant = await grants.approve({
    publicKey: device.publicKey,
    label: "Phone",
    permissions: ["read"],
    projectIDs: [projectID],
    sessionIDs: [],
    expiresAt: Date.now() + 60_000,
  })
  await grants.approve({
    publicKey: unrelated.publicKey,
    label: "Other",
    permissions: ["read"],
    projectIDs: ["other-project"],
    sessionIDs: [],
    expiresAt: Date.now() + 60_000,
  })
  const requests: { route: string; body: Record<string, unknown> }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-host-credential")
      requests.push({
        route: new URL(request.url).pathname,
        body: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await request.json()),
      })
      return Response.json({ status: "accepted" })
    },
  })
  const sender = PushSender.make({
    hubURL: server.url.origin,
    hostToken: "fixture-host-credential",
    runtimeID: crypto.randomUUID(),
    grants,
    connected: () => true,
    allowLoopbackHTTP: true,
    projectForSession: async () => projectID,
  })
  const status = (type: string) => ({ type: "session.next.status", data: { sessionID, status: { type } } })
  try {
    sender.accept(status("idle"))
    sender.accept({ type: "session.next.step.ended", data: { sessionID } })
    await sender.drain()
    expect(requests).toHaveLength(0)
    sender.accept(status("busy"))
    sender.accept(status("idle"))
    sender.accept(status("idle"))
    await sender.drain()
    expect(requests).toHaveLength(1)
    const notice = requests[0]!.body as unknown as PushContext.Binding & { kind: string; context: string }
    expect(notice.deviceID).toBe(device.publicKey)
    expect(notice.kind).toBe("completed")
    expect(JSON.stringify(notice)).not.toContain(sessionID)
    expect(JSON.stringify(notice)).not.toContain(projectID)
    expect(await PushContext.open(device, grants.identity.publicKey, notice, notice.context)).toMatchObject({
      sessionID,
      projectID,
    })
    const question = { id: crypto.randomUUID(), type: "question.v2.asked", data: { sessionID } }
    sender.accept(question)
    sender.accept(question)
    await sender.drain()
    expect(requests).toHaveLength(2)
    expect(requests[1]!.body.kind).toBe("attention")
    sender.accept(status("busy"))
    sender.accept({ id: crypto.randomUUID(), type: "session.next.failed", data: { sessionID } })
    sender.accept(status("idle"))
    await sender.drain()
    expect(requests).toHaveLength(3)
    expect(requests[2]!.body.kind).toBe("attention")
    sender.accept({
      id: crypto.randomUUID(),
      type: "session.next.notified",
      data: { sessionID, title: "Build", message: "Build finished" },
    })
    await sender.drain()
    expect(requests).toHaveLength(4)
    expect(requests[3]!.body.kind).toBe("attention")
    const revoked = await grants.revoke(grant.id, grant.version)
    await sender.revoke(revoked)
    expect(requests[4]).toMatchObject({
      route: `/api/hub/hosts/${grants.hostID}/push/revoke`,
      body: { grantID: grant.id, grantVersion: revoked.version },
    })
    sender.accept({ id: crypto.randomUUID(), type: "permission.v2.asked", data: { sessionID } })
    await sender.drain()
    expect(requests).toHaveLength(5)
    const restored = PushSender.make({
      hubURL: server.url.origin,
      hostToken: "fixture-host-credential",
      runtimeID: crypto.randomUUID(),
      grants,
      connected: () => true,
      allowLoopbackHTTP: true,
      projectForSession: async () => projectID,
    })
    try {
      restored.accept({ id: crypto.randomUUID(), type: "question.v2.asked", data: { sessionID } })
      await restored.drain()
      expect(requests).toHaveLength(6)
      expect(requests[5]!.route).toEndWith("/push/revoke")
    } finally {
      await restored.stop()
    }
    await sender.stop()
    sender.accept(question)
    await sender.drain()
    expect(requests).toHaveLength(6)
  } finally {
    await sender.stop()
    await server.stop(true)
    await grants.close()
    await rm(directory, { recursive: true, force: true })
  }
})
