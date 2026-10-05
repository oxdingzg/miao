import { expect, test } from "bun:test"
import { RuntimeConnect } from "../../src/runtime/connect"
import { RuntimeDiscovery } from "@miao/core/runtime/discovery"
import { RuntimeIdentity } from "@miao/core/runtime/identity"
import { RuntimeOwnership } from "@miao/core/runtime/ownership"
import { InstallationVersion } from "@miao/core/installation/version"
import { tmpdir } from "../fixture/fixture"
import path from "node:path"
import { createHash } from "node:crypto"

test("mismatch warns only when the owner release differs from this client", () => {
  const identity = RuntimeIdentity.create("/tmp/miao-mismatch.db", InstallationVersion, "0".repeat(48))
  const record: RuntimeDiscovery.Record = {
    url: "http://127.0.0.1:1234/",
    runtimeID: identity.runtimeID,
    version: InstallationVersion,
    protocol: 1,
    storageID: identity.storageID,
    credential: "0".repeat(48),
  }
  expect(RuntimeConnect.mismatch(record)).toBeUndefined()
  const warning = RuntimeConnect.mismatch({ ...record, version: "0.0.1" })
  expect(warning).toContain("0.0.1")
  expect(warning).toContain(InstallationVersion)
})

for (const scenario of ["older", "newer", "forged", "unsupported", "configuration"] as const) {
  test(`Runtime connection handles a ${scenario} owner across releases`, async () => {
    await using tmp = await tmpdir()
    const database = path.join(tmp.path, "sessions.db")
    const owner = await RuntimeOwnership.acquire(database)
    const credential = "runtime-test-credential-0000000000000000000000000000"
    const identity = RuntimeIdentity.create(owner.storage, scenario === "newer" ? "99.0.0" : "0.1.9", credential)
    const requests: string[] = []
    const headers: (string | null)[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        requests.push(url.pathname)
        headers.push(request.headers.get("authorization"))
        if (url.pathname === "/api/runtime/identity") {
          const proof = identity.prove(url.searchParams.get("challenge")!)!
          return Response.json(scenario === "forged" ? { ...proof, proof: "0".repeat(64) } : proof)
        }
        expect(request.method).toBe("POST")
        expect(request.headers.get("authorization")).toBe(
          `Basic ${Buffer.from(`miao:${credential}`).toString("base64")}`,
        )
        await RuntimeDiscovery.remove(owner.storage, identity.runtimeID)
        owner.release()
        return new Response(null, { status: 204 })
      },
    })
    identity.bind(server.url.href)
    const record: RuntimeDiscovery.Record = {
      url: server.url.href,
      runtimeID: identity.runtimeID,
      version: identity.version,
      protocol: identity.protocol,
      storageID: identity.storageID,
      credential,
      configurationID: createHash("sha256")
        .update(process.env.MIAO_CONFIG_CONTENT ?? "")
        .digest("hex"),
    }
    try {
      await RuntimeDiscovery.publish(owner.storage, record)
      if (scenario === "unsupported") {
        await Bun.write(`${owner.storage}.runtime-info.json`, JSON.stringify({ ...record, protocol: 2 }))
        await expect(RuntimeConnect.current(database)).rejects.toThrow()
        await expect(RuntimeConnect.ensure(database)).rejects.toThrow()
        expect(requests).toEqual([])
        return
      }
      if (scenario === "configuration") {
        await RuntimeDiscovery.publish(owner.storage, { ...record, configurationID: "0".repeat(64) })
        await expect(RuntimeConnect.ensure(database)).rejects.toThrow("MIAO_CONFIG_CONTENT differs")
        expect(requests).not.toContain("/api/runtime/stop")
        return
      }
      if (scenario === "forged") {
        await expect(RuntimeConnect.current(database)).rejects.toBeInstanceOf(RuntimeDiscovery.IdentityError)
        await expect(RuntimeConnect.stop(database, record)).rejects.toBeInstanceOf(RuntimeDiscovery.IdentityError)
        expect(requests).not.toContain("/api/runtime/stop")
        expect(headers.every((header) => header === null)).toBe(true)
        return
      }
      expect(await RuntimeConnect.current(database)).toEqual(record)
      // New clients join the existing owner, without starting or stopping it.
      const clients = await Promise.all([RuntimeConnect.ensure(database), RuntimeConnect.ensure(database)])
      expect(clients).toEqual([record, record])
      expect(requests).not.toContain("/api/runtime/stop")
      await expect(RuntimeOwnership.acquire(database)).rejects.toBeInstanceOf(RuntimeOwnership.BusyError)
      await RuntimeConnect.stop(database, record)
      expect(await RuntimeDiscovery.read(owner.storage)).toBeUndefined()
      const next = await RuntimeOwnership.acquire(database)
      next.release()
      expect(requests).toContain("/api/runtime/stop")
    } finally {
      owner.release()
      await server.stop(true)
    }
  })
}
