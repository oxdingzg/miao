/**
 * Access to the `miao-native` addon, gated by `MIAO_NATIVE`. When the flag is off
 * or the addon was not built (dev without Rust), `native()` returns `undefined`
 * and callers use the TypeScript implementations.
 *
 * The addon is loaded from `@miao/native`, whose literal `require("./miao-native.node")`
 * lets Bun embed it into the compiled single-file binary. A multi-platform release
 * still needs the addon built per target. See `docs/rust-integration-risks.en.md`.
 */
import { Flag } from "@miao/core/flag/flag"
import { native as addon, type NativeModule } from "@miao/native"

export type { NativeDeriveResult, NativeModule, NativePatchChunk } from "@miao/native"

export function native(): NativeModule | undefined {
  if (!Flag.MIAO_NATIVE) return undefined
  return addon
}
