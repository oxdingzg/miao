# miao vs opencode: performance and capability comparison

**Language:** [English](miao-vs-opencode.en.md) | [中文](miao-vs-opencode.zh.md)

miao is a fork of opencode. opencode's TS implementation is exactly the baseline in this repo
before the native modules were added, running on the same JavaScriptCore engine. This page
consolidates the benchmarks and capability comparisons into one checklist.

Measurement conditions: release build, same machine, medians; the TS baseline is the current
`packages/miao` implementation (source and `--compile` output verified equivalent); Rust is
`crates/miao-native` called in-process via napi. Correctness is covered by parity tests
(29 JS + 24 Rust).

## 1. Performance (higher is better; `x` is the speedup)

| Item | opencode (TS baseline) | miao (Rust native) | Speedup | Status |
|---|---|---|---|---|
| edit exact match (12k lines) | 0.21 ms | 0.12 ms | **1.7x** | PoC |
| edit fuzzy match (12k lines) | 0.76 ms | 0.39 ms | **1.9x** | PoC |
| edit match + diff stats (12k lines) | 2.03 ms | 1.78 ms | 1.14x | PoC |
| apply_patch `deriveNewContents` exact (20k lines) | 1.67 ms | 1.28 ms | **1.3x** | PoC |
| apply_patch trim match (20k lines) | 3.47 ms | 1.76 ms | **2.0x** | PoC |
| apply_patch unicode-normalize (20k lines) | 13.06 ms | 5.21 ms | **2.5x** | PoC |
| git status small repo (10 files / 2 changes) | 12.3 ms | 1.0 ms | **11.9x** | PoC |
| git status large repo (2200 files / 400 changes) | 13.6 ms | 5.8 ms | **2.4x** | PoC |

Key points:

- **opencode reads git status with a subprocess model**, with a fixed ~11 ms floor (11 ms even for 10 files); miao uses `gix` in-process, scaling with file count: 12x faster on a small repo and still 2.4x on a large one.
- **Fuzzy matching and unicode normalization** are pure CPU paths where miao is 2-2.5x faster; exact matching is 1.7x.
- Only paths dominated by whole-file diff/string assembly show a small gain (1.1-1.3x), because both sides pay the same O(n) assembly cost there.

## 2. Capability (what opencode does not have)

| Capability | opencode | miao | Status |
|---|---|---|---|
| Process-level sandbox | None. Rule-based permissions; once approved the process has full user privileges | Opt-in (`MIAO_SANDBOX=1`): macOS seatbelt / Linux Landlock enforce a write allowlist by the kernel; blocked paths reported and retried after a prompt. Network allowed by default (`MIAO_SANDBOX_DENY_NETWORK=1` denies it) | Opt-in |
| Sandbox configurability | None | `--allow-path` for precise allowlisting; `--compat` mode (deny only credential paths + network) | Opt-in |
| git status read | `git` subprocess (`diff-files` + `ls-files`) | `gix` in-process, no spawn | PoC |
| Self-update source | `anomalyco/opencode`, follows upstream versioning | `oxdingzg/miao`, version starts at `0.0.1`, does not follow upstream | Merged |
| Branding | opencode | miao: exit banner (cat + MIAO), terminal title prefixed with miao, install script | Merged |

Sandbox measured on the same machine:

| Behavior | opencode (rule-based permissions) | miao (seatbelt) |
|---|---|---|
| Write `$HOME/...` | Allowed (no enforcement after approval) | Denied (Operation not permitted) |
| Network access | Allowed (HTTP 200) | Denied (curl exit 6, cannot resolve host) |
| Write workdir | Allowed | Allowed |
| Normal command (`git status`) | Works | Works |

Note: the table is the sandbox backend's (`miao-run` / `__sandbox-run`) default behavior; once wired into the shell tool, network is allowed by default, and only `MIAO_SANDBOX_DENY_NETWORK=1` restores the denial above.

## 3. Status and boundaries (read this)

- **Merged to main**: version/update-source decoupling and branding (banner / terminal title / install script).
- **Native modules are a PoC, on by default where wired**: the edit/patch pure functions in `crates/miao-native` run by default (`MIAO_NATIVE=0` falls back); the git/text/walk/shell modules are still unwired and the default paths use TS, subprocess git, and rule-based permissions.
- **The sandbox is wired, opt-in**: the shell tool runs through the sandbox runner when `MIAO_SANDBOX=1` (release binary self-execs `__sandbox-run`; macOS seatbelt / Linux Landlock).
- The baseline is **the TS implementation in this repo before the fork's native work** (i.e. opencode's implementation), not the live opencode repository.
- Performance numbers are **isolated pure-function comparisons**; they exclude the Effect/IO/LSP/formatting work that is identical on both sides.
- Sandbox backends: macOS and Linux are implemented; Windows (AppContainer + Job object) is not.

Risks of wiring these PoCs into production (packaging, false-green CI, synchronous blocking, platform gaps) are in [rust-integration-risks.en.md](rust-integration-risks.en.md).

## 4. Next steps (toward "merged")

1. Wire `edit` / `apply_patch` / `snapshot` to native with a TS fallback, and compare RSS memory.
2. ~~Route the bash tool through the sandbox runner with the permission prompt as `ask`~~ Done: the shell tool runs sandboxed when `MIAO_SANDBOX=1`.
3. ~~Add the Linux landlock/seccomp backend~~ Done (Landlock with TCP denied); Windows remains.
