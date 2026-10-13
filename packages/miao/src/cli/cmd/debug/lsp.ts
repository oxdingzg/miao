import { EOL } from "os"
import { Effect } from "effect"
import { Location } from "@miao/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@miao/core/location-services"
import { AbsolutePath } from "@miao/core/schema"
import { LSP } from "@miao/core/lsp"
import { effectCmd, fail } from "../../effect-cmd"
import { cmd } from "../cmd"

const locationScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })),
    ),
    Effect.provide(locationServiceMapLayer),
  )

export const LSPCommand = cmd({
  command: "lsp",
  describe: "LSP debugging utilities",
  builder: (yargs) =>
    yargs.command(DiagnosticsCommand).command(SymbolsCommand).command(DocumentSymbolsCommand).demandCommand(),
  async handler() {},
})

const DiagnosticsCommand = effectCmd({
  command: "diagnostics <file>",
  describe: "get diagnostics for a file",
  instance: false,
  builder: (yargs) => yargs.positional("file", { type: "string", demandOption: true }),
  handler: (args) =>
    Effect.gen(function* () {
      const lsp = yield* LSP.Service
      yield* lsp.touchFile(args.file, "full")
      const out = yield* lsp.diagnostics()
      process.stdout.write(JSON.stringify(out, null, 2) + EOL)
    }).pipe(locationScope),
})

export const SymbolsCommand = effectCmd({
  command: "symbols <file> <query>",
  describe: "search workspace symbols using the server that owns the file",
  builder: (yargs) =>
    yargs.positional("file", { type: "string", demandOption: true }).positional("query", {
      type: "string",
      demandOption: true,
    }),
  handler: (args) =>
    Effect.gen(function* () {
      const lsp = yield* LSP.Service
      const results = yield* lsp
        .workspaceSymbol(args.file, args.query)
        .pipe(Effect.catch((error) => fail(error.message)))
      process.stdout.write(JSON.stringify(results, null, 2) + EOL)
    }).pipe(locationScope),
})

export const DocumentSymbolsCommand = effectCmd({
  command: "document-symbols <file>",
  describe: "get symbols from a document",
  builder: (yargs) => yargs.positional("file", { type: "string", demandOption: true }),
  handler: (args) =>
    Effect.gen(function* () {
      const lsp = yield* LSP.Service
      const results = yield* lsp.documentSymbol(args.file).pipe(Effect.catch((error) => fail(error.message)))
      process.stdout.write(JSON.stringify(results, null, 2) + EOL)
    }).pipe(locationScope),
})
