# Sandbox isolation map

What each engine capability is confined by, on each platform, and which parts of
the product run outside the sandbox entirely. The map is written from the code
cited in each row; a row without a citation is a row that drifted.

## 1. Three separate decisions

| Decision       | Owner                                              | What it controls                                        |
| -------------- | -------------------------------------------------- | ------------------------------------------------------- |
| May this call run at all? | Permission policy (`permission.rs`, rules, approvals) | Whether a tool call is executed, once, for one path |
| How is the child confined? | Agent sandbox policy (`config_derive::sandbox_enabled`) | Filesystem roots, network, process group of the spawned child |
| Did confinement really apply? | The result payload of the tool call          | `sandbox_profile`, `enforcement_required`, `network_allowed` |

A permission rule never changes the second decision. An `allow` rule on `**`
approves the call; the command still runs inside the same roots, and a write
outside them fails. `tests/process.rs` pins this with a wildcard-allow policy
(`an_allowed_command_stays_confined_to_the_workspace_roots`).

The sandbox switch belongs to the operator, not to the model or to a saved
approval:

- `MIAO_SANDBOX` wins in both directions over the merged `sandbox.mode` document
  value (`config_derive.rs`, `sandbox_enabled`); with neither set, commands stay
  confined.
- The model-facing tool input (`process::Input`) has no sandbox field and
  rejects unknown fields, and the runner payload it builds defaults `sandbox` to
  `true`. A model cannot ask its way out.
- An opt-out is reported rather than hidden: the call result carries
  `sandbox_profile: "off"` plus `enforcement_required: false`. A terminal start
  does the same, because an opt-out runs the same pty unconfined
  (`an_unsandboxed_terminal_reports_the_sandbox_it_runs_with`).

## 2. Platform backends

| Platform | Backend                                        | Writes                                  | Reads            | Network                              | Process tree |
| -------- | ---------------------------------------------- | --------------------------------------- | ---------------- | ------------------------------------ | ------------ |
| macOS    | seatbelt profile via `sandbox-exec` (`miao-sandbox::profile`) | workspace, workspace temp, `/tmp`, `/private/tmp`, `/private/var/tmp`, `/dev` | everywhere | denied unless the policy allows it | same process group, killed as a group |
| Linux    | Landlock ruleset, ABI v3 required, applied to the runner (`apply_linux_strict`) | workspace and its temp dir, plus `/dev/null` | everywhere | seccomp filter denies socket creation unless allowed; Landlock net rules cover TCP bind/connect only on kernels with ABI v4+ | same process group, killed as a group |
| Windows  | AppContainer plus job object (`miao_sandbox::win::run_in`) | `Modify` granted on the work directories only | container default | container capability tokens unless network allowed | contained job, terminated together |

The Linux backend refuses to run when Landlock is older than ABI v3 or when the
ruleset is not fully enforced, so a kernel that cannot confine produces a failed
call instead of an unconfined one. Windows ConPTY terminals report
`windows_unconfined` when the confined launch cannot be established.

## 3. Per-capability map

| Capability | How it executes | OS-confined today |
| ---------- | --------------- | ----------------- |
| `run_command` (bash tool) | engine re-execs itself as `__sandbox-run`, which applies the platform backend and then the argv (`process.rs`) | yes |
| `terminal_*` (pty) | same `__sandbox-run` runner with a pty; Windows via ConPTY in the AppContainer | yes |
| hooks | built as `process::Input`, so they take the same runner | yes |
| formatter | `process::spawn`, with network always denied | yes |
| `write_file` / `edit_file` / `apply_patch` | in-process Rust, no child process | **no OS confinement**: workspace path validation only |
| monitor | background child through the same runner (`spawn_sandboxed_monitor`) | yes |
| MCP servers | `Command::new` in `mcp.rs` | **no** |
| workers | `Command::new` in `worker.rs` | **no** |
| LSP servers | `Command::new` in `lsp.rs` | **no** |
| PDF conversion | `tokio::process::Command` in `pdf.rs` | **no** |

The four unconfined spawns are deliberate for now: they launch programs the
operator configured (an MCP server binary, a language server, a conversion
tool), which commonly need to reach their own installation paths, sockets, and
the network, and confining them without per-server exception rules would break
them silently. They are outside the sandbox, not "sandboxed but permissive", so
a permission rule or an approval never implies they are confined. Any change
here needs its own design; do not widen this table by accident when adding a
new host capability.

In-process file writes are guarded by path validation against the workspace
roots, not by the OS. That is a policy boundary inside one trusted process, not
an isolation boundary against a compromised child.

## 4. Verification

| Check | Where it runs |
| ----- | ------------- |
| `crates/miao-engine/tests/process.rs` (confinement, opt-out reporting, group kill) | engine suite on macOS and Linux, every pull request |
| `crates/miao-engine/tests/terminal.rs` (pty confinement and profile reporting) | same |
| `crates/miao-native/tests/linux-sandbox.rs` | Linux engine suite |
| `crates/miao-native/tests/windows-sandbox.rs` | Windows suite, nightly only |

Windows is the weakest link in this map: its backend is the largest one and its
suite does not gate a pull request. Treat a Windows confinement claim as
unverified until the nightly run says so.
