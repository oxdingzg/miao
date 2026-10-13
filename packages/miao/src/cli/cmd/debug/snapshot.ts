import { EOL } from "os"
import { Effect } from "effect"
import { Location } from "@miao/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@miao/core/location-services"
import { AbsolutePath } from "@miao/core/schema"
import { Snapshot } from "@miao/core/snapshot"
import { effectCmd, fail } from "../../effect-cmd"
import { cmd } from "../cmd"

export const SnapshotCommand = cmd({
  command: "snapshot",
  describe: "snapshot debugging utilities",
  builder: (yargs) => yargs.command(CaptureCommand).command(FilesCommand).command(DiffCommand).demandCommand(),
  async handler() {},
})

const locationScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })),
    ),
    Effect.provide(locationServiceMapLayer),
  )

const CaptureCommand = effectCmd({
  command: "capture",
  describe: "capture the current filesystem state as a content-addressed tree",
  handler: () =>
    Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const id = yield* snapshot.capture()
      process.stdout.write((id ?? "snapshots disabled or unavailable") + EOL)
    }).pipe(locationScope),
})

const FilesCommand = effectCmd({
  command: "files <from> <to>",
  describe: "list project-relative paths changed between two captured trees",
  builder: (yargs) =>
    yargs.positional("from", { type: "string", demandOption: true }).positional("to", {
      type: "string",
      demandOption: true,
    }),
  handler: (args) =>
    Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const paths = yield* snapshot
        .files({ from: Snapshot.ID.make(args.from), to: Snapshot.ID.make(args.to) })
        .pipe(Effect.catch((error) => fail(error.message)))
      for (const path of paths) process.stdout.write(path + EOL)
    }).pipe(locationScope),
})

const DiffCommand = effectCmd({
  command: "diff <from> <to>",
  describe: "show per-file diffs between two captured trees",
  builder: (yargs) =>
    yargs
      .positional("from", { type: "string", demandOption: true })
      .positional("to", { type: "string", demandOption: true })
      .option("context", { describe: "unchanged lines around each diff hunk", type: "number", default: 3 }),
  handler: (args) =>
    Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const diffs = yield* snapshot
        .diff({
          from: Snapshot.ID.make(args.from),
          to: Snapshot.ID.make(args.to),
          context: args.context,
        })
        .pipe(Effect.catch((error) => fail(error.message)))
      process.stdout.write(JSON.stringify(diffs, null, 2) + EOL)
    }).pipe(locationScope),
})
