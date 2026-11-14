export * as ResponseAssembler from "./response-assembler"

/** Bound a single ordered Agent response. Incomplete pages must never advance a client's durable cursor. */
export function make() {
  let transferID: string | undefined
  let total = 0
  let next = 0
  let bytes = 0
  let pieces: Uint8Array[] = []
  const reset = () => {
    transferID = undefined
    total = 0
    next = 0
    bytes = 0
    pieces = []
  }
  function accept(value: unknown): unknown | undefined {
    try {
      if (!isObject(value) || value.version !== 1) throw new Error()
      if (value.type !== "chunk") {
        if (transferID || !["result", "error", "pairing", "roster"].includes(String(value.type))) throw new Error()
        return value
      }
      if (
        typeof value.transferID !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.transferID) ||
        typeof value.total !== "number" ||
        !Number.isInteger(value.total) ||
        value.total < 1 ||
        value.total > 128 ||
        typeof value.index !== "number" ||
        !Number.isInteger(value.index) ||
        value.index < 0 ||
        value.index >= value.total ||
        typeof value.payload !== "string" ||
        value.payload.length > 88 * 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(value.payload)
      )
        throw new Error()
      if (!transferID) {
        if (value.index !== 0) throw new Error()
        transferID = value.transferID
        total = value.total
      }
      if (value.transferID !== transferID || value.total !== total || value.index !== next) throw new Error()
      const binary = atob(value.payload.replace(/-/g, "+").replace(/_/g, "/"))
      if (
        btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== value.payload ||
        binary.length > 64 * 1024 ||
        (next < total - 1 && binary.length !== 64 * 1024) ||
        bytes + binary.length > 8 * 1024 * 1024
      )
        throw new Error()
      pieces.push(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
      bytes += binary.length
      next++
      if (next !== total) return undefined
      const joined = new Uint8Array(bytes)
      let offset = 0
      for (const piece of pieces) {
        joined.set(piece, offset)
        offset += piece.length
      }
      reset()
      const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined))
      if (
        !isObject(result) ||
        result.version !== 1 ||
        !["result", "error", "pairing", "roster"].includes(String(result.type))
      )
        throw new Error()
      return result
    } catch {
      reset()
      throw new Error("Invalid or incomplete Agent response")
    }
  }
  return { accept, reset }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
