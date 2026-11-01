import { isDefaultTitle } from "./session"
import type { SessionStatus } from "@miao/schema/view-models"

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** A title is OSC payload, so controls must not terminate or restart its sequence. */
export function terminalTitle(input: string) {
  const title = input
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!title) return "miao"
  const chars = Array.from(segments.segment(title), (part) => part.segment)
  return chars.length > 40 ? chars.slice(0, 37).join("") + "…" : title
}

/**
 * What a Session's tab should read. A generated title is an auxiliary model
 * call: it can be slow, rate limited, or unavailable, and while it is missing
 * the tab read the product name for the whole first turn — hours, in a long
 * one. The request that opened the Session names the tab in the meantime.
 */
export function tabTitle(input: { title: string; prompt?: string }) {
  return terminalTitle(isDefaultTitle(input.title) ? (input.prompt ?? "") : input.title)
}

/**
 * The terminal title for a Session: a marker while a turn runs, its plain title
 * when idle.
 *
 * The marker is deliberately static. A tab is read by glancing at it, and a
 * title that rewrites itself every second ("working 2m 31s · …") pushes the
 * Session's name out of the part of the tab anyone can actually read, while the
 * elapsed time it carried is already on screen in the composer footer. Presence
 * or absence of `⏳` still tells a working Session from an idle one at a glance.
 */
export function sessionTitle(input: { title: string; prompt?: string; status?: SessionStatus }) {
  const base = tabTitle({ title: input.title, prompt: input.prompt })
  const status = input.status
  if (status?.type !== "busy" && status?.type !== "retry") return base
  return status.type === "retry" ? `⏳ retrying · ${base}` : `⏳ working · ${base}`
}
