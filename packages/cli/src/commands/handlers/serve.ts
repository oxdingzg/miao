import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { listen } from "../../services/listener"

export default Runtime.handler(
  Commands.commands.serve,
  Effect.fn("cli.serve")(function* (input) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const url = yield* listen(
          input.hostname,
          Option.getOrElse(input.port, () => 4096),
          process.env.MIAO_SERVER_PASSWORD,
        )
        console.log(`server listening on ${url}`)
        return yield* Effect.never
      }),
    )
  }),
)
