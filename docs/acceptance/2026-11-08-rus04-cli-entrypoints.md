# Acceptance record — RUS-04 the Rust CLI as the complete product entry point

Item: `RUS-04`. Tree: `main` at `c13275e9a6` (`#2676`), with `#2677`'s engine
test file present on the build host (the engine library itself is unchanged by
that pull request). Commands ran on the Linux build host
(`x86_64-unknown-linux-gnu`) with `HOME` pointed at a fresh sandbox for the
real-client smokes.

## The criterion this record accepts

**TUI/run/serve/attach/acp/auth/config/db/doctor and their compatibility
contracts are accepted item by item.** One binary answers all of them; the
usage text says so and the process list proves it: `miao --help` prints
"single binary (native) … All commands run in this process: the TUI is linked
in, not spawned", and the doctor smoke ran with no Bun/Node and no dev
checkout involved.

| entry point | contract evidence (commands run from the crate directory) | observed |
| --- | --- | --- |
| TUI | `cargo test` in `crates/miao-tui/` — 21 files green, including the 30-test smoke suite that spawns the real binary against a fixture engine; the real PTY pass with the worktree and workspace dialogs is `2026-11-07-wsp01-workspace-surfaces.md` | all `test result: ok` |
| run | the smoke suite's `the_palette_runs_actions_and_a_template_command_reaches_the_engine` drives the real binary end to end: open a Session, run a template command, watch it reach the engine; the engine runtime suites behind it are in `crates/miao-engine` | `30 passed; 0 failed` for the smoke file |
| serve | `cargo test the_serve_default_database_is_outside_the_workspace` (from `crates/miao-cli/`) | 1 passed |
| attach | real smoke: `miao attach` with no argument | `miao attach: usage: miao attach URL` |
| acp | real smoke: an `initialize` request on stdin with no credentials stored | refuses cleanly: `miao acp: API key or explicit credential source is required` |
| auth | real smoke: `miao auth status` with no stored credentials | prints the `login`/`logout` usage and exits 0 |
| config | `cargo test a_config_without_extensions_needs_no_sidecar an_explicit_config_dir_stays_the_only_layer disabling_the_project_config_skips_its_layers the_agent_option_names_the_configuration_agent` and the `debug_config` integration test | all passed within the suite below |
| db | `cargo test backup_reads_the_copy_back_and_never_replaces_one the_report_counts_the_write_ahead_log_and_the_shared_index the_database_report_names_the_target_before_anything_is_written the_serve_default_database_is_outside_the_workspace` | all passed within the suite below |
| doctor | `cargo test --test doctor` and the real smoke `HOME=<sandbox> miao doctor` | `miao 0.3.46 · engine protocol 2 schema 25`, the sandboxed database path, `database not created yet · sessions 0 · config missing · plugins 0 · routes 0` |

## The whole-crate run behind the table

`cargo test` from `crates/miao-cli/`: `49 passed; 0 failed` (lib) plus
`1 passed; 0 failed` for each of `debug_config` and `doctor` — 51 passed, 0
failed on the recorded tree.

## What this record does not claim

- Bare `miao auth` (no subcommand) exits 0 without printing anything; the
  usage only appears for `auth status` or an unknown subcommand. Recorded as
  observed — a cosmetic inconsistency, not a compatibility break; a follow-up
  may teach bare `auth` to print the same usage.
- `export`, `stats`, `providers`, `memory`, `plugins`, `models`, `session`,
  `worktree`, `completion` are outside this criterion's named list; the worktree
  surface is accepted by `2026-11-07-wsp01-workspace-surfaces.md` and the rest
  carry the same crate suite.
- Windows entry points stay unexercised, as every record so far.
