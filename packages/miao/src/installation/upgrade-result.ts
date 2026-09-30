import path from "path"
import { Global } from "@miao/core/global"

// Durable record of the last automatic upgrade attempt. Mirrors Claude Code's
// .last-update-result.json so a failed background update can be diagnosed later
// instead of disappearing into a swallowed promise rejection.
export interface UpgradeResult {
  timestamp: string
  outcome: "success" | "failure"
  method: string
  versionFrom: string
  versionTo: string
  error?: string
}

const resultFile = () => path.join(Global.Path.state, "upgrade-result.json")

export async function writeUpgradeResult(input: Omit<UpgradeResult, "timestamp">) {
  const result: UpgradeResult = { timestamp: new Date().toISOString(), ...input }
  await Bun.write(resultFile(), JSON.stringify(result)).catch(() => {})
}

export async function readUpgradeResult(): Promise<UpgradeResult | undefined> {
  return Bun.file(resultFile())
    .json()
    .catch(() => undefined)
}
