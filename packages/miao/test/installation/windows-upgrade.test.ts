import { test } from "bun:test"
import { verifyWindowsUpgrade } from "./windows-fixture"

test.skipIf(process.platform !== "win32")(
  "upgrades a running Windows executable and preserves it on invalid releases",
  () => verifyWindowsUpgrade(),
  60_000,
)

test.skipIf(process.platform !== "win32")(
  "upgrades the Windows installer binary while preserving its launcher",
  () => verifyWindowsUpgrade("miao-bin.exe"),
  60_000,
)
