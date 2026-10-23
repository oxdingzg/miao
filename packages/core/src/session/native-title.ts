export * as SessionNativeTitle from "./native-title"

import type { LLMError, LLMEvent, LLMRequest, Model } from "@miao/llm"
import { SessionTitle } from "./title"
import { SessionRunnerModel, type Interface as SessionRunnerModelInterface } from "./runner/model"
import type { SessionStore } from "./store"
import { AgentV2 } from "../agent"
import type { EventV2 } from "../event"
import { SessionSchema } from "./schema"
import type { SessionID } from "@miao/schema/session-id"
import { SessionEvent } from "@miao/schema/session-event"
import { DateTime, Effect, type Stream } from "effect"

const inFlight = new Set<string>()

/**
 * Generate the product title for a Session whose first run just settled and
 * whose title is still the creation placeholder — the same fact the TypeScript
 * runner publishes after its first exchange, factored out so the native host
 * can reuse it. Model choice mirrors the runner: the `title` agent's preferred
 * model when it declares one, otherwise the Session's own. Dependencies are
 * passed in by the host; failures are silent — a missing title must never
 * fail a wait.
 */
export const afterRun = Effect.fn("SessionNativeTitle.afterRun")(function* (input: {
  readonly sessionID: SessionID
  readonly prompt: string
  readonly store: { readonly get: SessionStore.Interface["get"] }
  readonly llm: { readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError> }
  readonly agents: Pick<AgentV2.Interface, "get">
  readonly models: { readonly resolve: SessionRunnerModelInterface["resolve"] }
  readonly events: {
    readonly publish: (
      definition: typeof SessionEvent.Info.Updated,
      payload: {
        readonly sessionID: SessionID
        readonly timestamp: DateTime.Utc
        readonly title: string
      },
    ) => Effect.Effect<void>
  }
}) {
  if (inFlight.has(input.sessionID)) return
  const info = yield* input.store.get(input.sessionID)
  if (!info || info.parentID !== undefined || !SessionTitle.isDefault(info.title)) return
  inFlight.add(input.sessionID)
  return yield* Effect.gen(function* () {
    const titleAgent = yield* input.agents.get(AgentV2.ID.make("title"))
    let preferred: Model | undefined
    if (titleAgent?.model) {
      const option = yield* input.models.resolve({ ...info, model: titleAgent.model }).pipe(Effect.option)
      if (option._tag === "Some") preferred = option.value.model
    }
    if (!preferred) {
      const option = yield* input.models.resolve(info).pipe(Effect.option)
      if (option._tag === "Some") preferred = option.value.model
    }
    if (!preferred) return
    const title = yield* SessionTitle.generate({
      llm: input.llm,
      model: preferred,
      system: titleAgent?.system,
      prompt: input.prompt,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!title) return
    // The user may have renamed the Session while the title model ran.
    const current = yield* input.store.get(input.sessionID)
    if (!current || !SessionTitle.isDefault(current.title)) return
    yield* input.events.publish(SessionEvent.Info.Updated, {
      sessionID: input.sessionID,
      timestamp: yield* DateTime.now,
      title,
    })
  }).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(input.sessionID))))
})
