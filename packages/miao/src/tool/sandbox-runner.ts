/**
 * Hidden `miao __sandbox-run` entry point. A compiled single-file binary cannot
 * ship a separate `miao-run` sidecar, so it re-executes itself through this
 * command to run a child under the OS sandbox. The implementation lives in
 * `@miao/core/sandbox/runner` so the V1 shell tool and the V2 bash tool share it.
 */
import { SandboxPolicy } from "@miao/core/sandbox/policy"
import { SandboxRunner } from "@miao/core/sandbox/runner"

export type SandboxRunOptions = SandboxRunner.Options

export const parseSandboxArgs = SandboxRunner.parseArgs
export const parseDeniedLine = SandboxPolicy.parseDeniedLine
export const sandboxRun = SandboxRunner.run
