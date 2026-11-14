import { createHash } from "crypto"

export namespace Hash {
  export function fast(input: string | Uint8Array): string {
    return createHash("sha1").update(input).digest("hex")
  }

  export function sha256(input: string | Uint8Array): string {
    return createHash("sha256").update(input).digest("hex")
  }
}
