export * as SessionNativeTitle from "./native-title"

import type { LLMError, LLMEvent, LLMRequest } from "@miao/llm"
import { SessionTitle } from "./title"
import { SessionRunnerModel } from "./runner/model"
import type { SessionStore } from "./store"
import { AgentV2 } from "../agent"
import type { EventV2 } from "../event"
import { SessionSchema } from "./schema"
import type { SessionID } from "@miao/schema/session-id"
import { SessionEvent } from "@miao/schema/session-event"
import { DateTime, Effect, Option, type Stream } from "effect"

const inFlight = new Set<string>()

/**
 * Generate the product title for a Session whose first run just settled and
 * whose title is still the creation placeholder — the same fact the TypeScript
 * runner publishes after its first exchange, factored out so the native host
 * can reuse it. Model choice mirrors the runner: the `title` agent's preferred
 * model when it declares one, otherwise the Session's own. Dependencies are
 * passed in by the host; failures are silent — a missing title must never
 * fail a wait. Returns the title it published, if any, so the host can mirror
 * it onto its own title authority.
 */
export const afterRun = Effect.fn("SessionNativeTitle.afterRun")(function* (input: {
  readonly sessionID: SessionID
  readonly prompt: string
  readonly store: { readonly get: SessionStore.Interface["get"] }
  readonly llm: { readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError> }
  readonly agents: Pick<AgentV2.Interface, "get">
  readonly models: { readonly resolve: SessionRunnerModel.Interface["resolve"] }
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
  inFlight.add(input.sessionID)
  return yield* Effect.gen(function* () {
    const info = yield* input.store.get(input.sessionID)
    if (!info || info.parentID !== undefined || !SessionTitle.isDefault(info.title)) return
    const titleAgent = yield* input.agents.get(AgentV2.ID.make("title"))
    const preferred = titleAgent?.model
      ? Option.getOrUndefined(yield* input.models.resolve({ ...info, model: titleAgent.model }).pipe(Effect.option))
      : undefined
    const own = Option.getOrUndefined(yield* input.models.resolve(info).pipe(Effect.option))
    // A stored native route may have disappeared from the product catalog.
    // Auxiliary naming may use the current default, without carrying a pin
    // belonging to the unavailable provider into that fallback resolution.
    const selected =
      own ??
      Option.getOrUndefined(
        yield* input.models.resolve({ ...info, model: undefined, credentialID: undefined }).pipe(Effect.option),
      )
    const candidates = [preferred, selected]
      .filter((value) => value !== undefined)
      .filter(
        (value, index, all) =>
          all.findIndex(
            (candidate) => candidate.model.provider === value.model.provider && candidate.model.id === value.model.id,
          ) === index,
      )
    for (const resolved of candidates) {
      const title = yield* SessionTitle.generate({
        llm: input.llm,
        model: resolved.model,
        system: titleAgent?.system,
        prompt: input.prompt,
      }).pipe(
        Effect.timeoutOption("15 seconds"),
        Effect.map(Option.getOrUndefined),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!title) continue
      // The user may have renamed the Session while the title model ran.
      const current = yield* input.store.get(input.sessionID)
      if (!current || !SessionTitle.isDefault(current.title)) return
      yield* input.events.publish(SessionEvent.Info.Updated, {
        sessionID: input.sessionID,
        timestamp: yield* DateTime.now,
        title,
      })
      return title
    }
  }).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(input.sessionID))))
})
