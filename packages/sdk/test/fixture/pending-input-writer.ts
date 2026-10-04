import { Effect } from "effect"
import { OpenCode, Prompt, Session } from "../../src"

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* OpenCode.create()
      yield* host.sessions.prompt({
        sessionID: Session.ID.make(process.argv[2]),
        prompt: Prompt.make({ text: "Message from another process" }),
        delivery: "queue",
        resume: false,
      })
    }),
  ),
)
