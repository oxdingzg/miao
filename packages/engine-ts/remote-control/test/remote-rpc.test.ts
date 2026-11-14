import { expect, test } from "bun:test"
import { RemoteRPC } from "../src/remote-rpc"

function fixture() {
  const sent: Record<string, unknown>[] = []
  let receiver: { resolve(value: unknown): void; reject(error: Error): void } | undefined
  const transport: RemoteRPC.Transport = {
    send: async (value) => { sent.push(value as Record<string, unknown>) },
    receive: () => new Promise((resolve, reject) => { receiver = { resolve, reject } }),
    close: () => { receiver?.reject(new Error("closed")); receiver = undefined },
  }
  const grant = { id: "grant_rpc_fixture", publicKey: "B" + "a".repeat(86), label: "browser", version: 1,
    createdAt: Date.now(), revokedAt: null,
    permissions: ["read", "prompt"] as const, projectIDs: ["project_fixture"], sessionIDs: [], expiresAt: Date.now() + 60000 }
  const rpc = RemoteRPC.make({ transport, target: { hostID: "host_rpc_fixture", runtimeID: "runtime_rpc_fixture" },
    grant: { ...grant, permissions: [...grant.permissions] }, identityPublicKey: grant.publicKey })
  return { rpc, sent, reply: (value: unknown) => receiver!.resolve(value) }
}

test("matches out-of-order responses to request IDs and uses pinned grant metadata", async () => {
  const f = fixture()
  try {
    const first = f.rpc.request("session.get", { sessionID: "one" })
    const second = f.rpc.request("session.get", { sessionID: "two" })
    f.reply({ version: 1, type: "result", requestID: f.sent[1]!.requestID, data: "second" })
    expect(await second).toBe("second")
    f.reply({ version: 1, type: "result", requestID: f.sent[0]!.requestID, data: "first" })
    expect(await first).toBe("first")
    expect(f.sent[0]).toMatchObject({ hostID: "host_rpc_fixture", runtimeID: "runtime_rpc_fixture", grantID: "grant_rpc_fixture", grantVersion: 1 })
  } finally { f.rpc.close(); await f.rpc.finished }
})

test("requires persisted operation IDs and never retries uncertain writes", async () => {
  const f = fixture()
  try {
    await expect(f.rpc.request("session.prompt")).rejects.toMatchObject({ code: "invalid_request" })
    expect(f.sent).toHaveLength(0)
    const operationID = crypto.randomUUID()
    await expect(f.rpc.request("session.prompt", { operationID, timeout: 5 })).rejects.toMatchObject({ code: "outcome_unknown" })
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.operationID).toBe(operationID)
    const interrupted = f.rpc.request("session.prompt", { operationID: crypto.randomUUID() })
    const rejected = interrupted.catch((error: unknown) => error)
    f.rpc.close()
    expect(await rejected).toMatchObject({ code: "outcome_unknown" })
    expect(f.sent).toHaveLength(2)
  } finally { f.rpc.close(); await f.rpc.finished }
})

test("bounds pending requests and closes all readers on malformed envelopes", async () => {
  const f = fixture()
  const requests = Array.from({ length: 32 }, () => f.rpc.request("session.get").catch((error: unknown) => error))
  await expect(f.rpc.request("session.get")).rejects.toMatchObject({ code: "busy" })
  f.reply({ version: 2, type: "result", requestID: f.sent[0]!.requestID })
  const errors = await Promise.all(requests)
  expect(errors.every((error) => error instanceof RemoteRPC.RequestError && error.code === "disconnected")).toBe(true)
  expect(f.rpc.stopped()).toBe(true)
  await f.rpc.finished
})

for (const method of ["session.switchAgent", "session.switchModel"] as const) {
  test(`${method} requires a persisted operation and preserves uncertain outcomes`, async () => {
    const f = fixture()
    try {
      await expect(f.rpc.request(method)).rejects.toMatchObject({ code: "invalid_request" })
      expect(f.sent).toHaveLength(0)
      const operationID = crypto.randomUUID()
      await expect(f.rpc.request(method, { operationID, timeout: 5 })).rejects.toMatchObject({ code: "outcome_unknown" })
      expect(f.sent).toHaveLength(1)
      expect(f.sent[0]).toMatchObject({ method, operationID })
    } finally { f.rpc.close(); await f.rpc.finished }
  })
}
