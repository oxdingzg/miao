export * as RuntimeAttach from "./attach"

import { RuntimeOwnership } from "@miao/core/runtime/ownership"
import { RuntimeRegistration } from "@miao/core/runtime/registration"
import { createHash } from "node:crypto"

/**
 * Discover a live Runtime already serving this storage that this window can
 * attach to instead of starting its own, so a pending schema upgrade never
 * blocks opening. A record only attests while its recorded process still
 * listens at the recorded URL and proves the recorded identity, so stale
 * records from crashed windows never attach. The protocol generation is part
 * of the record schema: records from an incompatible API generation fail to
 * decode, and this window then starts (and migrates) its own Runtime.
 */
export async function discover(filename: string) {
  const storage = await RuntimeOwnership.canonicalStorage(filename)
  const storageID = createHash("sha256").update(storage).digest("hex")
  const configurationID = createHash("sha256").update(process.env.MIAO_CONFIG_CONTENT ?? "").digest("hex")
  const records = await RuntimeRegistration.list(storage).catch(() => [])
  const candidates = records.filter(
    (record) => record.configurationID === undefined || record.configurationID === configurationID,
  )
  // expected.version is each record's own version: any release of this
  // protocol generation may attach, including older windows. A differing
  // configuration keeps this window on its own Runtime, as before.
  return Promise.any(
    candidates.map((record) =>
      RuntimeRegistration.attest(record, { version: record.version, storageID }),
    ),
  ).catch(() => undefined)
}
