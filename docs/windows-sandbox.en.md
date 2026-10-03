# Windows sandbox: implementation and verification spec

**Language:** [English](windows-sandbox.en.md) | [中文](windows-sandbox.zh.md)

Add a Windows backend to `crates/miao-sandbox` so the guarantee matches macOS seatbelt / Linux landlock: a **process-level, kernel-enforced** write allowlist with network denied by default. The backend is shared by `miao-run` (dev/tests) and the released binary's self-exec path, so it is written once. This file is a handoff spec that can be executed directly.

> Development and verification happen on **Windows**; no Linux/mac needed.

## Environment setup (Windows dev machine)

1. **Rust (MSVC toolchain)**
   - `winget install Rustup` (or download `rustup-init.exe` from <https://rustup.rs>).
   - Install the MSVC C++ build tools (provides `link.exe`):
     `winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`
   - `rustup default stable-msvc`; confirm `cargo --version`.
   - Alternative: `stable-gnu` + MinGW; MSVC preferred.
2. **Git**: `winget install Git.Git`; `curl` ships with Windows 10+.
3. **Clone** (public repo):
   ```powershell
   git clone https://github.com/oxdingzg/miao
   ```
4. **Build and test** (only `miao-run` and `miao-sandbox` are needed; no need to build the whole native addon):
   ```powershell
   cd miao\crates\miao-sandbox
   cargo test --release                    # sandbox backend unit tests
   cd ..\miao-native
   cargo build --release --bin miao-run   # produces target\release\miao-run.exe
   cargo test --release                    # Rust unit tests + Windows integration tests
   ```
5. **Administrator rights**: creating an AppContainer profile and editing ACLs usually needs an **elevated** PowerShell; a normal session may fail (see section 4 for the fallback).

> If `~/.cargo/config.toml` sets `[net] offline = true`, override with `$env:CARGO_NET_OFFLINE="false"; cargo ...` instead of editing someone else's config.

## 1. Goals

- Write: only workdir and `--allow-path` directories; everything else denied.
- Read: allowed (system files and read-only paths work normally).
- Network: denied by default; `--allow-network` permits it.
- Process tree: terminated together with `miao-run` (no orphans).
- Gated: the sandbox runs only when `sandbox` config or `MIAO_SANDBOX` enables it; when no backend exists, fall back and **report explicitly**, never silently.

## 2. Current state

- Sandbox logic lives in `crates/miao-sandbox`: `profile()` (seatbelt text), `apply_linux_restrictions()` (landlock), `supported()`.
- Both `miao-run` (`crates/miao-native/src/bin/miao-run.rs`) and the main binary's hidden `__sandbox-run` (`packages/miao/src/sandbox-runner.ts`, re-exporting `@miao/core/sandbox/runner`) call this crate; release self-executes, dev/tests use `miao-run`.
- macOS: `sandbox-exec -p <seatbelt profile>`.
- Linux: in-process landlock (write allowlist + TCP bind/connect denied), verified on a real host; integration tests in `crates/miao-native/tests/linux-sandbox.rs`.
- Windows: **no backend**; it currently hits `#[cfg(not(any(target_os = "macos", target_os = "linux")))]`, prints `no sandbox backend`, and runs **unsandboxed**.
- Note: AppContainer is applied **when creating the child process**, not by restricting self, so Windows cannot restrict-then-spawn like Linux's `sandboxRestrict`; the addon needs a "spawn inside an AppContainer" entry point (section 5).
- Existing CLI:
  ```
  miao-run [--workdir <dir>]... [--allow-path <dir>]... [--allow-network] [--compat]
           [--deny-report <file>] [--print-profile] -- <command> [args...]
  ```

## 3. Approach

**Primary: AppContainer (process-level, kernel-enforced).**

- Create/reuse a container profile with `CreateAppContainerProfile` to get the AppContainer SID; clean up with `DeleteAppContainerProfile`.
- Use the ACL APIs (`SetEntriesInAcl` + `SetNamedSecurityInfo`) to grant that SID Modify on the workdir and every `--allow-path` → the **write allowlist**.
- Network: grant **no** network capability by default; with `--allow-network`, add `internetClient` (plus `internetClientServer` / `privateNetworkClientServer` if needed) to `SECURITY_CAPABILITIES`.
- Start the command inside the container with `CreateProcess` + `STARTUPINFOEX` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`.
- **Job object**: `CreateJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (optional memory/process caps); assign the child so the tree dies together.
- Crate: `windows` (windows-rs). Optional `win32job`.

**Supplement / alternatives:**

- For per-port/address network control, add **WFP** (Windows Filtering Platform) keyed by process AppID; AppContainer capabilities are coarse.
- **Do not** use Windows Sandbox / WDAC / Defender Application Guard: VM/whole-machine level, unsuitable as a per-command exec wrapper.
- **A job object alone does not isolate files or network**; it is resource/lifecycle only and must be combined with AppContainer.

## 4. Decisions needed before starting

1. **Privileges**: `CreateAppContainerProfile` needs admin in some environments. Confirm the target machine (0xdtee's Windows box) and the GitHub `windows-2025` runner can create it. Runners are usually admin; a normal user machine may not be. If it cannot be created, define the fallback: report and (per config) run unsandboxed, never silent.
2. **Profile lifecycle**: reuse vs create per run; `DeleteAppContainerProfile` on exit.
3. **ACL grants are a persistent side effect**: granting the container SID on a directory stays in the ACL. Decide whether to revoke, or accept grant-only and document it.
4. **`--deny-report`**: Windows has no landlock/seatbelt-style "denied path" kernel event. Infer from child stderr, or explicitly mark it unsupported.
5. **`--compat`** semantics on Windows (allow by default, deny only credential paths + network).
6. **Path normalization**: drive letters / UNC / case / 8.3 short names; resolution of `--workdir` / `--allow-path`.

## 5. Implementation steps

0. Add the Windows dependency (Windows-only build) to `crates/miao-native/Cargo.toml`:
   ```toml
   [target.'cfg(windows)'.dependencies]
   windows = { version = "0.61", features = [
     "Win32_Foundation",
     "Win32_Security",
     "Win32_Security_Isolation",
     "Win32_Security_Authorization",
     "Win32_System_Threading",
     "Win32_System_JobObjects",
     "Win32_Storage_FileSystem",
   ] }
   ```
   Exact feature names depend on the chosen `windows` version.
1. Add the Windows backend in `crates/miao-sandbox` (for example `#[cfg(windows)] fn apply_windows_restrictions(workdirs, allow_paths, allow_network) -> Result<JobGuard, String>`), and expose it through the addon as a spawn-under-AppContainer entry point.
2. AppContainer: create profile → derive SID → set ACLs (grant Modify) on each workdir / allow-path.
3. Launch: build `SECURITY_CAPABILITIES` (with/without the network capability), `CreateProcess` the command.
4. Job object: create, set `KILL_ON_JOB_CLOSE`, `AssignProcessToJobObject`.
5. Propagate exit code, collect stderr; handle `--deny-report` per section 4.
6. Change the `#[cfg(not(any(macos,linux)))]` branch in `main`: Windows goes through the new backend; other platforms keep the "no sandbox" notice.
7. TS side: `SandboxRunner.resolve()` / `SandboxRunner.run()` pick the runner (`miao-run` or `__sandbox-run`) and call the same CLI, so no format change; the Windows spawn path is invoked by the runner.

## 6. Verification

### 6.1 Manual matrix (0xdtee's Windows machine)

| Behavior | Expectation |
|---|---|
| Write inside workdir | allowed |
| Write `%USERPROFILE%\miao-outside.txt` | denied (Access denied) |
| Write `C:\Windows\Temp\...` | denied |
| Read a file under `%SystemRoot%\System32` | allowed |
| `curl http://1.1.1.1` (TCP) | denied by default; allowed with `--allow-network` |
| `cmd /c echo hi`, `powershell -c "..."` | work |
| Kill `miao-run` | child tree dies too (job object) |

Build and run:

```powershell
cd crates\miao-native
cargo build --release --bin miao-run
$wd = New-Item -ItemType Directory -Path $env:TEMP\miao-wd -Force
.\target\release\miao-run.exe --workdir $wd.FullName -- cmd /c "echo hi > $env:TEMP\miao-wd\in.txt"
.\target\release\miao-run.exe --workdir $wd.FullName -- cmd /c "echo hi > $env:USERPROFILE\miao-outside.txt"
.\target\release\miao-run.exe --workdir $wd.FullName -- curl.exe -m 5 -sS -o NUL http://1.1.1.1
.\target\release\miao-run.exe --workdir $wd.FullName --allow-network -- curl.exe -m 5 -sS -o NUL http://1.1.1.1
```

### 6.2 Automation

- Add `crates/miao-native/tests/windows-sandbox.rs` (`#![cfg(windows)]`), mirroring `tests/linux-sandbox.rs`: spawn the binary via `env!("CARGO_BIN_EXE_miao-run")` and assert the matrix above.
- CI: add a `sandbox-windows` job (`windows-2025`) to `.github/workflows/native.yml` running `cargo test --release`.
  - If AppContainer is unavailable on the runner, **allow a skip but record the reason explicitly**; no silent pass (no false green).

### 6.3 Performance / consistency

- Record the extra startup latency vs unsandboxed (AppContainer create + ACL set).
- Confirm basic commands (`cmd /c ver`, `miao-run --version`) work inside the sandbox.

## 7. Acceptance criteria

- The 6.1 matrix passes on the real machine; the 6.2 integration tests pass in CI (or an explicitly recorded skip).
- Without AppContainer privileges: explicit error and a configured fallback, **not silent**.
- macOS / Linux behavior unchanged; the sandbox switch is gated by `sandbox` config / `MIAO_SANDBOX`; the Windows backend is not implemented.

## 8. Risks

- AppContainer depends on admin/specific Windows versions; enterprise policy may disable it.
- ACL grants are persistent; a revoke strategy is needed.
- Capability-level network control is coarse (add WFP to refine).
- `--deny-report` is less precise than macOS/Linux; mark it unsupported if it cannot be done well.

## 9. Related files

- `crates/miao-sandbox/src/lib.rs` (seatbelt / landlock / backend dispatch and `supported()`)
- `crates/miao-native/src/bin/miao-run.rs` (dev/test runner, calls `miao-sandbox`)
- `crates/miao-native/tests/linux-sandbox.rs` (Linux enforcement tests; template for the Windows version)
- `packages/core/src/sandbox/runner.ts` (`resolve` / `backend`) and `packages/core/src/sandbox.ts` (`Sandbox.Service`)
- `packages/miao/src/sandbox-runner.ts` (the hidden `__sandbox-run` implementation for release self-exec)
- `.github/workflows/native.yml` (`native` / `sandbox-linux` jobs; add `sandbox-windows`)
- `docs/rust-rewrite-feasibility.en.md` (where the sandbox sits in the overall plan)
