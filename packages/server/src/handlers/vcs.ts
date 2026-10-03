import { Git } from "@miao/core/git"
import { GitCli } from "@miao/core/git-cli"
import { VcsDiff } from "@miao/core/vcs-diff"
import { Location } from "@miao/core/location"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const VcsHandler = HttpApiBuilder.group(Api, "server.vcs", (handlers) =>
  Effect.gen(function* () {
    // GitCli is an app-level service, so it is resolved here rather than inside a request.
    const cli = yield* GitCli.Service
    return handlers
      .handle(
        "vcs.get",
        Effect.fn(function* () {
          const location = yield* Location.Service
          const git = yield* Git.Service
          const repository = yield* git.repo.discover(location.directory)
          if (!repository) return yield* response(Effect.succeed({}))
          const [branch, default_branch] = yield* Effect.all(
            [git.history.branch(repository), git.history.defaultRemoteBranch(repository)],
            { concurrency: 2 },
          )
          return yield* response(Effect.succeed({ branch, default_branch }))
        }),
      )
      .handle(
        "vcs.status",
        Effect.fn(function* () {
          const location = yield* Location.Service
          const git = yield* Git.Service
          const repository = yield* git.repo.discover(location.directory)
          if (!repository) return yield* response(Effect.succeed([]))
          const entries = yield* git.status.entries(repository)
          return yield* response(
            Effect.succeed(
              entries.map((entry) => ({
                file: entry.path,
                additions: entry.additions,
                deletions: entry.deletions,
                status: entry.status,
              })),
            ),
          )
        }),
      )
      .handle(
        "vcs.diff",
        Effect.fn(function* (ctx) {
          const location = yield* Location.Service
          const git = yield* Git.Service
          if (!(yield* git.repo.discover(location.directory))) return yield* response(Effect.succeed([]))
          const options = { context: ctx.query.context }
          const files =
            ctx.query.mode === "working"
              ? yield* VcsDiff.working(cli, location.directory, options)
              : yield* VcsDiff.branch(cli, location.directory, options)
          return yield* response(Effect.succeed(files))
        }),
      )
  }),
)
