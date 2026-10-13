import { Effect, Option, Schema, Stream } from "effect"
import { SessionEvent } from "@miao/schema/session-event"
import { NativeEngine } from "./native-engine"

/** The journal cursor advances even when a row has no public Session projection. */
export function nativeSessionEvents(
  native: Pick<NativeEngine.Interface, "events">,
  input: Parameters<NativeEngine.Interface["events"]>[0],
) {
  const decode = Schema.decodeUnknownOption(Schema.toType(SessionEvent.Durable))
  return Stream.unwrap(Effect.sync(() => {
    const state = { after: input.after, initial: true }
    return Stream.fromEffectRepeat(Effect.gen(function* () {
      if (!state.initial) yield* Effect.sleep("250 millis")
      state.initial = false
      const page = yield* native.events({ ...input, after: state.after })
      state.after = page.cursor
      return page.events
    })).pipe(
      Stream.flattenIterable,
      Stream.map((event) => decode(event)),
      Stream.filter(Option.isSome),
      Stream.map((event) => event.value),
    )
  }))
}
