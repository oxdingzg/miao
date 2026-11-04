// Source-checkout sandbox runner entry: `bun src/sandbox/main.ts <runner args>`.
// The shipped binary carries its own runner (`miao-run` in the Rust tree).
import { SandboxRunner } from "./runner"

process.exit(await SandboxRunner.run(process.argv.slice(2)))
