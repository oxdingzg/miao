// Source-checkout sandbox runner entry: `bun src/sandbox/main.ts <runner args>`.
// Compiled builds use `miao __sandbox-run` instead; see ./runner.ts.
import { SandboxRunner } from "./runner"

process.exit(await SandboxRunner.run(process.argv.slice(2)))
