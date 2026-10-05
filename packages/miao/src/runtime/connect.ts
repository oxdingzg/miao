export * as RuntimeConnect from "./connect"

import { RuntimeOwnership } from "@miao/core/runtime/ownership"
import { RuntimeDiscovery } from "@miao/core/runtime/discovery"
import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { spawn } from "node:child_process"
import { CliProgram } from "@/cli-program"

// The protocol schema controls compatibility; the signed software version
// identifies the owner without requiring clients to share its build.
export async function current(filename: string): Promise<RuntimeDiscovery.Record | undefined> {
  const storage = await RuntimeOwnership.canonicalStorage(filename)
  const record = await RuntimeDiscovery.read(storage)
  if (!record) return undefined
  return RuntimeDiscovery.attest(record, {
    version: record.version,
    storageID: createHash("sha256").update(storage).digest("hex"),
  })
}

/** Stop only the verified owner and wait until it has released storage. */
export async function stop(filename: string, record: RuntimeDiscovery.Record) {
  const storage = await RuntimeOwnership.canonicalStorage(filename)
  await RuntimeDiscovery.attest(record, {
    version: record.version,
    storageID: createHash("sha256").update(storage).digest("hex"),
  })
  const response = await fetch(new URL("/api/runtime/stop", record.url), {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Basic ${Buffer.from(`miao:${record.credential}`).toString("base64")}` },
    signal: AbortSignal.timeout(3000),
  })
  if (!response.ok) throw new Error("The Runtime rejected shutdown")
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const current = await RuntimeDiscovery.read(storage)
    if (current && current.runtimeID !== record.runtimeID)
      throw new Error('Another Runtime started during shutdown; retry "miao runtime stop" if it should also stop')
    if (!current) {
      const owner = await RuntimeOwnership.acquire(storage).catch((error: unknown) => {
        if (error instanceof RuntimeOwnership.BusyError) return undefined
        throw error
      })
      if (owner) {
        owner.release()
        return
      }
    }
    await Bun.sleep(100)
  }
  throw new Error("Runtime shutdown timed out; inspect its private runtime log")
}

/** Discover or start one persistent owner, never take over a live owner's storage. */
export async function ensure(filename: string): Promise<RuntimeDiscovery.Record> {
  const storage = await RuntimeOwnership.canonicalStorage(filename)
  const storageID = createHash("sha256").update(storage).digest("hex")
  const deadline = Date.now() + 45_000
  const state: { launched: boolean; lastError?: unknown } = { launched: false }
  while (Date.now() < deadline) {
    const record = await RuntimeDiscovery.read(storage)
    if (record) {
      const verified = await RuntimeDiscovery.attest(record, { version: record.version, storageID }).catch(
        (error: unknown) => {
          state.lastError = error
          return undefined
        },
      )
      if (verified) {
        const configurationID = createHash("sha256")
          .update(process.env.MIAO_CONFIG_CONTENT ?? "")
          .digest("hex")
        if (verified.configurationID !== configurationID)
          throw new Error(
            "MIAO_CONFIG_CONTENT differs from the running Runtime; stop it before changing startup configuration",
          )
        return verified
      }
    }
    if (!state.launched) {
      const owner = await RuntimeOwnership.acquire(storage).catch((error: unknown) => {
        if (error instanceof RuntimeOwnership.BusyError) return undefined
        throw error
      })
      if (owner) {
        owner.release()
        await launch(storage)
        state.launched = true
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
  }
  throw new Error("The local Runtime did not become ready; inspect its private runtime log", {
    cause: state.lastError,
  })
}

async function launch(storage: string) {
  const log = await open(`${storage}.runtime.log`, "a", 0o600)
  try {
    await log.chmod(0o600)
    const program = CliProgram.command("runtime")
    const child = spawn(program[0], program.slice(1), {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !["MTTY_PANE_ID", "MIAOTTY_PANE_ID"].includes(key)),
        ),
        MIAO_DB: storage,
      },
      windowsHide: true,
    })
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve)
      child.once("error", reject)
    })
    child.unref()
  } finally {
    await log.close()
  }
}
