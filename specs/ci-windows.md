# CI on Windows

Status: `unit (windows)` and `e2e (windows)` in `.github/workflows/test.yml` run with
`continue-on-error: true` — non-blocking until Windows suite is fixed. Linux is the merge gate.

This file tracks what still fails so the Windows jobs can become blocking again. Remove a row
once a fix is merged and a green Windows run proves it; flip `blocking: true` for the Windows
matrix entries once the table is empty.

Evidence comes from runs 36954126870 and 36954890353 on `oxdingzg/miao` (first runs of the test
workflow on `main`). Upstream `anomalyco/opencode` is green on Windows, but runs on
`blacksmith-4vcpu-windows-2025`; miao uses GitHub's `windows-2025` image.

## Fixed in the workflow change that made Windows non-blocking

| Area | Root cause | Fix |
| --- | --- | --- |
| `SessionRunnerLLM recorded` fixture mismatch (core) | Git for Windows checks out with `core.autocrlf=true`; persona `.txt` prompts imported as text became CRLF, so the request body carried `\r\n` while the fixture has `\n` | `.gitattributes`: `* text=auto eol=lf` |
| Ripgrep tests (5) and TencentTokenPlanPlugin tests (3) (core) | The image has no `rg`, so `packages/core/src/ripgrep/binary.ts` downloads the release zip and extracts it with `powershell.exe Expand-Archive`, which outlasts the 5s test timeout (`ChildProcess.exitCode` PlatformError, SIGTERM). The Tencent tests record every HTTP request and saw the ripgrep download URL as an extra call | Workflow installs ripgrep with `choco install ripgrep` before the tests (unverified until the next Windows run) |
| Missing failure list for `packages/miao` | `bun turbo test` stops at the first failing package, so `miao#test` was killed mid-run | Windows runs `bun turbo test --continue` |
| `e2e (windows)` near the step timeout | The run took 28.3 minutes against a 30-minute cap | Windows e2e step timeout raised to 45 minutes |

## Remaining failures

| Package | Test | Root cause class | Evidence | Next step |
| --- | --- | --- | --- | --- |
| core | `Git > fetches, checks out, and resets remote changes` | Many git child processes exceed the 5s default timeout (intermittent) | Timed out at `git reset --hard origin/feature/docs`; passed in 36954126870, failed in 36954890353 | Watch a few runs; give the test an explicit timeout if it keeps failing |
| core | `RepositoryCache > serializes concurrent materialization for the same checkout` | Same as above | `this test timed out after 5000ms` | Same as above |
| miao | `debug config redaction > always masks resolved credentials` | CLI child produced no output within 30s; root cause not confirmed (slow cold start on Windows, or instance boot fetching ripgrep) | `expected exit 0, got -1 after 30127ms`, `Error: Timed out`, empty stdout | Re-check once ripgrep is preinstalled |
| miao | `opencode mcp add (non-interactive subprocess) > adds a local server…` | Same as above | `got -1 after 30452ms` | Same as above |
| miao | `CLI plain-text fallback > miao --help stays plain under NO_COLOR` | Same as above (`--help` loads every command module) | `timed out after 30000ms` | Same as above |
| miao | Everything after the first failure | Unknown: earlier runs stopped `miao#test` when `@miao/core#test` failed | `Failed: @miao/core#test`, no miao summary | Read the first `--continue` run and add rows here |

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
