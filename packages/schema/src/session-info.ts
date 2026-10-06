export * as SessionInfo from "./session-info"

import { Schema } from "effect"
import { Agent } from "./agent"
import { Location } from "./location"
import { Model } from "./model"
import { Project } from "./project"
import { Provider } from "./provider"
import { DateTimeUtcFromMillis, optional, RelativePath } from "./schema"
import { SessionID } from "./session-id"
import { Revert } from "./revert"

/**
 * Lifetime usage projected from the `session_turn_usage` / `session_tool_usage`
 * fact tables: totals that survive transcript paging, split by the model that
 * actually billed each turn.
 */
export interface Usage extends Schema.Schema.Type<typeof Usage> {}
export const Usage = Schema.Struct({
  turns: Schema.Finite,
  tools: Schema.Struct({
    calls: Schema.Finite,
    failures: Schema.Finite,
  }),
  models: Schema.Array(
    Schema.Struct({
      providerID: Provider.ID,
      id: Model.ID,
      variant: Schema.String.pipe(optional),
      turns: Schema.Finite,
      cost: Schema.Finite,
      tokens: Schema.Struct({
        input: Schema.Finite,
        output: Schema.Finite,
        reasoning: Schema.Finite,
        cache: Schema.Struct({
          read: Schema.Finite,
          write: Schema.Finite,
        }),
      }),
      lastTurnAt: DateTimeUtcFromMillis,
    }),
  ),
}).annotate({ identifier: "SessionV2.Usage" })

/**
 * Current Session record. Lives outside `session.ts` so the session event
 * module can embed it without a module cycle.
 */
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: SessionID,
  parentID: SessionID.pipe(optional),
  projectID: Project.ID,
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  cost: Schema.Finite,
  usage: Usage.pipe(optional),
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    archived: DateTimeUtcFromMillis.pipe(optional),
  }),
  title: Schema.String,
  location: Location.Ref,
  subpath: RelativePath.pipe(optional),
  share: Schema.optional(Schema.Struct({ url: Schema.String })),
  revert: Revert.State.pipe(optional),
}).annotate({ identifier: "SessionV2.Info" })
