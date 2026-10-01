const length = 26
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
// Legacy identifiers stored only the low 48 bits of `timestamp * 0x1000 + counter` as 12 hex
// characters, so their order wrapped every 2^36 ms (~795 days: 2026-08-14, 2028-10-17, ...).
// Current identifiers start with a marker that sorts after every hex digit, so they order after
// all legacy identifiers, followed by 60 bits as 15 hex characters, which last until year 10889.
const marker = "g"
const timeLength = 15
const mask = (1n << 60n) - 1n
let lastTimestamp = 0
let counter = 0

export function ascending() {
  return create(false)
}

export function descending() {
  return create(true)
}

export function create(descending: boolean, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const time = ((descending ? ~current : current) & mask).toString(16).padStart(timeLength, "0")
  const bytes = crypto.getRandomValues(new Uint8Array(length - 1 - timeLength))
  return marker + time + Array.from(bytes, (byte) => chars[byte % 62]).join("")
}

/**
 * Extract the creation time in milliseconds from an ascending identifier body (without the
 * `prefix_`). Legacy identifiers only yield the time modulo 2^36 ms. Does not work with
 * descending identifiers.
 */
export function timestamp(identifier: string) {
  const hex = identifier.startsWith(marker) ? identifier.slice(1, 1 + timeLength) : identifier.slice(0, 12)
  return Number(BigInt("0x" + hex) / 0x1000n)
}
