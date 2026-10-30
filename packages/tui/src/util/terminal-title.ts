import { isDefaultTitle } from "./session"
import { Locale } from "./locale"
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
 * The terminal title for a Session, carrying a liveness marker only while a
 * turn runs. A frozen elapsed timer cannot tell a hung session from a finished
 * one, so the marker's clock advances only during an active turn: a title that
 * keeps counting is the one signal that survives a tab switch and proves the
 * session is progressing rather than stalled. An idle Session reads as its
 * plain title — the "ready for input" state — so the presence or absence of
 * `⏳` distinguishes working from done at a glance.
 */
export function sessionTitle(input: { title: string; prompt?: string; status?: SessionStatus; now: number }) {
  const base = tabTitle({ title: input.title, prompt: input.prompt })
  const status = input.status
  if (status?.type !== "busy" && status?.type !== "retry") return base
  const label = status.type === "retry" ? "retrying" : "working"
  const since = status.type === "busy" ? status.since : undefined
  if (since === undefined) return `⏳ ${label} · ${base}`
  return `⏳ ${label} ${Locale.duration(Math.max(0, input.now - since))} · ${base}`
}
