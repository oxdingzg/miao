export * as ConfigSandbox from "./sandbox"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigV2.Sandbox")({
  mode: Schema.Literals(["off", "workspace-write"]).pipe(Schema.optional).annotate({
    description:
      "Run bash commands inside the OS sandbox. workspace-write limits writes to the Location, the command's working directory, temp directories, and approved paths. Defaults to off; MIAO_SANDBOX=1 or 0 overrides it.",
  }),
  network: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Allow network access inside the sandbox (default: true). MIAO_SANDBOX_DENY_NETWORK=1 overrides it to deny.",
  }),
  writable_roots: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description:
      "Extra directories the sandbox may write to. Relative paths resolve from the Location; ~ expands to the home directory.",
  }),
  on_unavailable: Schema.Literals(["warn", "fail"]).pipe(Schema.optional).annotate({
    description:
      "What to do when the sandbox is enabled but no sandbox runner is available: warn and run unsandboxed (default), or fail the command.",
  }),
}) {}
