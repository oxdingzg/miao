export * as PlanIntent from "./plan-intent"

/**
 * Ties how a plan is treated to what the user actually asked for. A request for
 * a plan or design document ends when that document is written; a request for a
 * result treats any plan as an intermediate artifact that must not stall on a
 * user confirmation. Kept as a cross-cutting system part next to output
 * language so every model family and every agent applies the same rule, instead
 * of each persona re-deriving it (or silently disagreeing with it).
 */
export const instruction = [
  "# Plan or deliverable",
  "",
  "What the user asked for decides whether a plan is the deliverable or only an intermediate step.",
  "- If the user asked for a plan or a design document, that document is the deliverable: produce it and stop. Do not start implementing.",
  "- If the user asked for a result, a plan is only an intermediate step: do not stop to ask the user to confirm it, and do not present it as the deliverable. State it briefly if it helps, then carry the work through to implementation and verification.",
].join("\n")
