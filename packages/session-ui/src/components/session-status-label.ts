import type { BusyPhase } from "@miao/schema/session-event"
import type { UiI18nKey } from "@miao/ui/context/i18n"

/**
 * The label for a live turn while no assistant output is visible. `queued` and
 * `preparing` have not reached the provider, `requesting` is a dispatched
 * request awaiting its first token, and anything else (including `streaming`)
 * reads as the generic thinking shimmer.
 */
export function sessionPhaseLabelKey(phase: BusyPhase | undefined): UiI18nKey {
  if (phase === "queued") return "ui.message.queued"
  if (phase === "preparing") return "ui.sessionTurn.status.preparingRequest"
  if (phase === "requesting") return "ui.sessionTurn.status.waitingForModel"
  return "ui.sessionTurn.status.thinking"
}
