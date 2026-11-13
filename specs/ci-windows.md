# CI on Windows

Status: `unit (windows)` and `e2e (windows)` in `.github/workflows/test.yml` run with
`continue-on-error: true` — non-blocking until Windows suite is fixed. Linux is the merge gate.

`e2e (windows)` does not run on pull requests at all: it is non-blocking and cost a Windows
runner on every push, so `.github/workflows/e2e.yml` now lists it only on the nightly schedule
and on manual dispatch.

`engine (windows)` and `window runtime (windows)` follow the same rule and are stricter about
it: they do not run on pull requests **or** on pushes to `main`. Windows validation is not part
of the per-commit gate:

- The nightly schedule is the early warning.
- `release.yml` runs the full Windows engine suite against the exact release commit and
  `publish` waits for it, so a Windows regression cannot ship without either run having seen
  it.
- `engine-v*` tags and manual dispatch still run the engine suite directly.

An ordinary pull request therefore starts no Windows job at all; the price is that a
Windows-only compile or behaviour break surfaces at night or at the release gate rather than
on the pull request that caused it.

This file tracks what still fails so the Windows jobs can become blocking again. Remove a row
once a fix is merged and a green Windows run proves it; make the `blocking: true` Windows
entries in `.github/workflows/test.yml` blocking again once the table is empty.

Evidence comes from runs 36954126870 and 36954890353 on `oxdingzg/miao` (first runs of the test
workflow on `main`). Upstream `anomalyco/opencode` is green on Windows, but runs on
`blacksmith-4vcpu-windows-2025`; miao uses GitHub's `windows-2025` image. Later baselines:
run 43222581978 (2026-11-12 nightly, pre-#2938: 8 core failures) and run 43363882232
(2026-11-13 dispatch, post-#2938 gates: 4 core failures — the step log truncated the failure
names, so the host list below is the named baseline).

## Fixed in the workflow change that made Windows non-blocking

| Area | Root cause | Fix |
| --- | --- | --- |
| `SessionRunnerLLM recorded` fixture mismatch (core) | Git for Windows checks out with `core.autocrlf=true`; persona `.txt` prompts imported as text became CRLF, so the request body carried `\r\n` while the fixture has `\n` | `.gitattributes`: `* text=auto eol=lf` |
| Ripgrep tests (5) and TencentTokenPlanPlugin tests (3) (core) | The image has no `rg`, so `packages/core/src/ripgrep/binary.ts` downloads the release zip and extracts it with `powershell.exe Expand-Archive`, which outlasts the 5s test timeout (`ChildProcess.exitCode` PlatformError, SIGTERM). The Tencent tests record every HTTP request and saw the ripgrep download URL as an extra call | Workflow installs ripgrep with `choco install ripgrep` before the tests (unverified until the next Windows run) |
| Missing failure list for `packages/miao` | `bun turbo test` stops at the first failing package, so `miao#test` was killed mid-run | Windows runs `bun turbo test --continue` |
| `e2e (windows)` near the step timeout | The run took 28.3 minutes against a 30-minute cap | Windows e2e step timeout raised to 45 minutes |

## Remaining failures

Re-baselined 2026-11-13 against a90a39102 on the Windows build host (`bun` 1.4.2 + Node 24,
the CI-parity toolset; run-level CI evidence in 43363882232). The `packages/miao` rows below
are gone because RUS-02 retired that package. The intermittent git-timeout rows passed the
2026-11-13 dispatch and stay on watch.

| Package | Test | Root cause class | Evidence | Next step |
| --- | --- | --- | --- | --- |
| core | `Git > fetches, checks out, and resets remote changes` | Many git child processes exceed the 5s default timeout (intermittent) | Failed in 36954890353; passed in 43363882232 | Keep watching; explicit timeout if it recurs |
| core | `RepositoryCache > serializes concurrent materialization for the same checkout` | Same as above | `this test timed out after 5000ms` (36954890353); passed in 43363882232 | Same as above |
| core | `sqlite busy retry` cleanup (reported as an unnamed failure) | Windows cannot `rm` a file a connection still holds (EBUSY, errno -4082); POSIX can, so the cleanup path is untested there | `EBUSY: resource busy or locked, rm 'C:\tmp\miao-sqlite-busy-*'` on the build host | Close connections before the temp-dir cleanup, or retry the rm |
| core | `Git status > reports structured working tree entries` | Assertion under Windows git output (337ms, not a timeout) | Build host 2026-11-13 | Reproduce, read the diff, fix status parsing or the fixture |
| core | `MonitorTool > returns immediately, delivers only matching lines, and reports the exit` and `MonitorTool > cancels the command and says so when the timeout elapses` | Spawn/line-delivery semantics on Windows (~25ms failures, not timeouts) | Build host 2026-11-13 (2 of 4 MonitorTool tests; the third is #2938-gated) | Same |
| core | `ProjectWorktree > creates a populated worktree on a miao branch…` | Exceeds the 5s default timeout (git worktree + start script) | `this test timed out after 5000ms` on the build host | Give the test an explicit timeout, then check the pieces |
| core | `ProjectWorktree > relocates anchored sessions to the checkout when removing a worktree` and `SessionHeal > relocates a Session whose directory vanished` | Same family as the EBUSY row: the fixture removes a directory Windows still holds, so "vanished" never becomes true | Build host 2026-11-13 | Same as the EBUSY row |
| core | `MoveSession > moves (nested) session changes…` and `cross-spawn … .all` | Host-only flake on the build box (passed on the hosted runner era, appear/disappear between host runs) | Present in one host run, absent in the next | Watch; do not chase until it reproduces twice |

### engine (windows) — release gate

The release-gate suite (`release.yml` engine-windows) first ran against a
release commit on 2026-11-03 (runs 41530268572, 41537726830) and exposed:

| Test | Count | Root cause class | Evidence | Next step |
| --- | --- | --- | --- | --- |
| `runtime::cancel_authority_tests::*` | 8 | Host pipe-capacity / event-wait deadlines on hosted Windows (all eight share the harness) | run 41537726830, 84s single-threaded run | Debug on a Windows host (build machine `96`); give the harness explicit event deadlines |

Only `runtime::cancel_authority_tests` is still skipped at the release gate
(`--skip cancel_authority_tests`) so the rest of the suite still gates the
release.

`permission_source::tests::a_frozen_source_retains_durable_input_without_starting_a_provider`
came off that list with #2903/#2915: the handoff row stored the Windows
`\\?\C:\...` spelling while `engine_location.root` stored the plain one, so the
freeze trigger's string equality never held and a frozen source blocked
nothing. Both writers now use `placement::canonical`, measured on a Windows
host at 90 passed / 0 failed for `cargo test --lib permission`.


### engine (windows) — release gate

The release-gate suite first ran against a release commit on 2026-11-03
(runs 41530268572, 41537726830, 41541777831) and kept exposing new layers:

- `runtime::cancel_authority_tests` (8) — host pipe-capacity deadlines; still
  skipped at the gate.
- `permission_source::a_frozen_source` — was a real product defect, not a
  timeout (#2903): the workspace was spelled with the Windows `\\?\` prefix
  while the Location used the plain form. Fixed in #2915, skip removed.
- `mcp::call_metadata_tests::metadata_interpolation_is_bounded_and_fails_closed`
  — the test doubled the ambient `PATH`, whose length belongs to the host's
  profile (4673 bytes on the build host), so the doubling tripped the 8192
  budget before the assertion could say anything. The fixture is now a
  variable the test owns (#2943, verified on the build host and on macOS).
- `tests/accuracy.rs` integration binaries (denied_write, product_fix) —
  filesystem-effect assertions fail on hosted Windows; integration tests are
  now off Windows at the gate entirely, like the non-blocking TS unit suite.

The gate still runs the lib suite (498 tests, Windows-compiled) minus the
known groups. Re-add integration coverage once the Windows suite is fixed
and a green release proves it. The 0.3.66 release (run 43375439352,
2026-11-13) ran this gate green against a90a39102, and a build-host run the
same day measured 487 passed / 1 failed — the 1 being the #2943 row above,
now fixed.

## tui on Windows

`tui.yml` has no Windows leg (its matrix is ubuntu plus the self-hosted
macOS host), so `crates/miao-tui` had never compiled or run on Windows when
#2873 was filed. The two #2873 rows are fixed on `main` — #2892 made the
unbound-shortcut assertion platform-aware, #2902 taught the narrow-pane
tests to read the rendered grid cell by cell — and on 2026-11-13 the whole
crate ran on the Windows build host with the CI-parity invocation
(`cargo test --locked --no-fail-fast -- --test-threads=1`, incremental
off):

| Suite | Result |
| --- | --- |
| lib unittests | 655 passed / 0 failed — includes `every_shortcut_command_resolves_to_a_bound_chord` (#2892) |
| `client_matrix` | 3/3 — narrow-pane pair and tmux (#2902) |
| `input_latency` / `interaction_*` ×5 / `smoke` / `startup_latency` | all green (5, 1, 1, 1, 1, 1, 27, 2) |
| `embedded_stream` | `a_cancel_lands_ahead_of_a_pouring_delta_flood` **overflows the stack** — the poll chain plus fixture future exceeds the default worker stack in an MSVC debug build |
| `idle_resources` | **hangs** in `a_prolonged_stream_does_not_grow_the_process` (40+ minutes against a sub-60-second deadline); killed so the rest of the suite could run, its other tests unmeasured |

Two compile notes from the same host: `rustc` 1.98.1 on Windows ICEs
("no resolution for an import", delayed at `rustc_ast_lowering`) when
compiling `miao-tui`'s lib test with incremental compilation on; the same
target compiles clean with `CARGO_INCREMENTAL=0`. And the debug tree with
the codegraph grammar set is large enough that a C:-drive target directory
ran out of space mid-build twice — build it against a roomier volume.

These two failures are why the crate still has no Windows CI leg: adding
one today would add a red job, not a gate. Fix the overflow (box or shrink
the fixture future, or raise the worker stack) and the hang (an event wait
that never fires on ConPTY) first; then a Windows leg becomes worth its
runner minutes.


### e2e (windows)

The hard e2e failures on Windows were the same set as on Linux (V2 app vs V1 mocks, fixed in
`packages/app`). Windows-only flakes seen so far, absorbed by Playwright retries but worth
watching:

- `file-browser-sidebar-tab-switch.spec.ts:19`
- `open-file-expand-folder.spec.ts:14`
- `review-open-file.spec.ts:14`
- `session-rename.spec.ts:71`
- `collapse-state.spec.ts:104`
- `session-timeline-reasoning-projection.spec.ts:58` ("summaries on no content")

## Not Windows-specific: parked e2e fixtures

14 app e2e cases are marked `test.fixme(..., LEGACY_V1_FIXTURE)` on every platform because their
fixtures still describe V1 data (V1 part ids, compaction/file/patch parts, message summary diffs)
that the V2-only app no longer reads. The reason is
documented next to `LEGACY_V1_FIXTURE` in `packages/app/e2e/utils/mock-server.ts`; list the cases
with `grep -rn LEGACY_V1_FIXTURE packages/app/e2e`. As of this change they are in
`session-timeline-context-resize` (2),
`session-timeline-history-root` (1, two scenarios), `session-timeline-lifecycle-state` (1),
`session-timeline-projection` (3), `session-timeline-reasoning-projection` (2),
`session-timeline-reducer-projection` (1), `session-timeline-shell-outline` (1),
`session-timeline-transport` (1) and `smoke/session-timeline` (1). `session-todo-dock-navigation`
runs again now that the app reads `/api/session/:id/todo`, and `regression/remote-session-settings`
runs against the V2 permission list, reply route and `permission.v2.asked` event.
