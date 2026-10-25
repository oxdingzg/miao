export * as SessionTurnUsage from "./session-turn-usage"

import { Schema } from "effect"
import { Model } from "./model"
import { SessionMessage } from "./session-message"
import { optional } from "./schema"

/** One settled provider step, independent of transcript paging and later compaction. */
export const Info = Schema.Struct({
  id: Schema.String,
  messageID: SessionMessage.ID,
  model: Model.Ref,
  time: Schema.Finite,
  finish: Schema.String,
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
  }),
  ttftMs: Schema.Finite.pipe(optional),
}).annotate({ identifier: "SessionTurnUsage.Info" })
export type Info = typeof Info.Type

export const Page = Schema.Struct({
  items: Schema.Array(Info),
  /** Exclusive event ID for the next, older page. Items within a page are chronological. */
  next: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionTurnUsage.Page" })
