import { test } from "bun:test"
import { verifyWindowsUpgrade } from "./windows-fixture"

test.skipIf(process.platform !== "win32")(
  "upgrades a running Windows executable and preserves it on invalid releases",
  verifyWindowsUpgrade,
  60_000,
)
