import { expect, test } from "bun:test"
import { ResponseAssembler } from "../src/response-assembler"

function chunks(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value))
  const total = Math.ceil(bytes.length / (64 * 1024))
  const transferID = crypto.randomUUID()
  return Array.from({ length: total }, (_, index) => ({ version: 1, type: "chunk", transferID, index, total,
    payload: bytes.subarray(index * 64 * 1024, (index + 1) * 64 * 1024).toString("base64url") }))
}

test("commits a large Unicode response only after the final ordered chunk", () => {
  const assembler = ResponseAssembler.make()
  const response = { version: 1, type: "result", data: "跨端会话".repeat(30000) }
  const packets = chunks(response)
  for (const packet of packets.slice(0, -1)) expect(assembler.accept(packet)).toBeUndefined()
  expect(assembler.accept(packets.at(-1))).toEqual(response)
})

test("rejects reorder, interleaving, invalid sizes and malformed assembled envelopes", () => {
  const packets = chunks({ version: 1, type: "result", data: "x".repeat(100000) })
  const first = packets[0]!
  const bad = [packets[1], { ...first, total: 129 }, { ...first, payload: "YQ" },
    { ...first, payload: first.payload + "=" }]
  for (const packet of bad) expect(() => ResponseAssembler.make().accept(packet)).toThrow()
  const assembler = ResponseAssembler.make()
  assembler.accept(packets[0])
  expect(() => assembler.accept({ version: 1, type: "result", data: [] })).toThrow()
  expect(assembler.accept({ version: 1, type: "result", data: [] })).toEqual({ version: 1, type: "result", data: [] })
  expect(() => assembler.accept(chunks({ type: "unknown" })[0])).toThrow()
})
