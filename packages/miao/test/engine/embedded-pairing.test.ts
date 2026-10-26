import { test } from "bun:test"
import { verifyEmbeddedPairing } from "./embedded-pairing-fixture"

test.skipIf(process.platform !== "win32")(
  "a compiled Windows host upgrades its paired engine while a legacy engine stays running",
  verifyEmbeddedPairing,
  120_000,
)
