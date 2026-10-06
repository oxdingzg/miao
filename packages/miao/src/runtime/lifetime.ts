export * as RuntimeLifetime from "./lifetime"

const DEFAULT_LINGER_MS = 0
const NEVER = -1

/**
 * Grace after the activity vector becomes empty before the Runtime drains and
 * exits (`specs/runtime-lifetime.md`). `0` (default) exits as soon as the last
 * client disconnects and nothing else is active — the lightweight "follow the
 * visible client" model, where the next `miao` starts the installed build. A
 * positive value stays warm for a returning client; `-1` never exits
 * automatically. Startup configuration: it is read when the Runtime starts, so
 * a client cannot change it for a running owner.
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

const DEFAULT_STARTUP_GRACE_MS = 60_000

/**
 * A Runtime is spawned by `RuntimeConnect.ensure` and only then does its client
 * connect, so an empty vector right after start is not "the last client left".
 * The idle countdown only arms once the Runtime has been active at least once;
 * a Runtime that is never used still exits after this grace so a stray spawn
 * cannot leak. Startup configuration, like `lingerMs`.
 */
export function startupGraceMs(input = process.env.MIAO_RUNTIME_STARTUP_GRACE_MS) {
  if (input === undefined || input.trim() === "") return DEFAULT_STARTUP_GRACE_MS
  const value = Number(input)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_STARTUP_GRACE_MS
}
