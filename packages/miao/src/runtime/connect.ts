export * as RuntimeConnect from "./connect"

import { RuntimeOwnership } from "@miao/core/runtime/ownership"
import { RuntimeDiscovery } from "@miao/core/runtime/discovery"
import { InstallationVersion } from "@miao/core/installation/version"
import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { spawn } from "node:child_process"

export async function current(filename: string): Promise<RuntimeDiscovery.Record | undefined> {
  const storage = await RuntimeOwnership.canonicalStorage(filename)
  const record = await RuntimeDiscovery.read(storage)
  if (!record) return undefined
  return RuntimeDiscovery.attest(record, {
    version: InstallationVersion,
    storageID: createHash("sha256").update(storage).digest("hex"),
  })
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
      const verified = await RuntimeDiscovery.attest(record, { version: InstallationVersion, storageID }).catch(
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
      } else if (record && record.version !== InstallationVersion) {
        throw new Error("The running Runtime uses another miao version; stop it before changing versions")
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
    const program = Bun.main.endsWith(".ts")
      ? [process.execPath, "run", Bun.main, "runtime"]
      : [process.execPath, "runtime"]
    const child = spawn(program[0], program.slice(1), {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, MIAO_DB: storage },
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
