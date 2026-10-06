export * as RuntimeLifetime from "./lifetime"

const DEFAULT_LINGER_MS = 5 * 60 * 1000
const NEVER = -1

/**
 * Grace after the activity vector becomes empty before the Runtime drains and
 * exits (`specs/runtime-lifetime.md`). `> 0` stays warm for a returning client,
 * `0` follows the last client, and `-1` never exits automatically. Startup
 * configuration: it is read when the Runtime starts, so a client cannot change
 * it for a running owner.
 */
export function lingerMs(input = process.env.MIAO_RUNTIME_LINGER_MS) {
  if (input === undefined || input.trim() === "") return DEFAULT_LINGER_MS
  const value = Number(input)
  if (!Number.isFinite(value)) return DEFAULT_LINGER_MS
  if (value < 0) return NEVER
  return Math.floor(value)
}

/** Whether a configured remote-control agent pins the Runtime. Default true. */
export function remoteControlPins(input = process.env.MIAO_RUNTIME_REMOTE_CONTROL_PINS) {
  if (input === undefined || input.trim() === "") return true
  return !["0", "false", "no", "off"].includes(input.trim().toLowerCase())
}
