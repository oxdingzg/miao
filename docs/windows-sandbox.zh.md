# Windows 沙箱：实现与验证规格

**语言 / Language:** [中文](windows-sandbox.zh.md) | [English](windows-sandbox.en.md)

给 `crates/miao-sandbox` 增加 Windows 后端，使约束与 macOS seatbelt / Linux landlock 对等：**进程级、内核强制**的写白名单与默认禁网。后端被 `miao-run`（dev/测试）与编译后主二进制自执行路径共用，因此只需要写一次。本文件是可直接执行的交接规格。

> 开发与验证全部在 **Windows** 上进行，不需要 Linux/mac。

## 环境准备（Windows 开发机）

1. **Rust（MSVC 工具链）**
   - `winget install Rustup`（或从 <https://rustup.rs> 下载 `rustup-init.exe`）。
   - 安装 MSVC C++ 生成工具（提供 `link.exe`）：
     `winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`
   - `rustup default stable-msvc`；确认 `cargo --version` 可用。
   - 备选：`rustup default stable-gnu` + MinGW；首选 MSVC。
2. **Git**：`winget install Git.Git`；`curl` 是 Windows 10+ 自带。
3. **克隆仓库**（公开仓库，无需鉴权）：
   ```powershell
   git clone https://github.com/oxdingzg/miao
   ```
4. **构建沙箱与测试**（只需要 `miao-run` 与 `miao-sandbox`，不必构建整个原生 addon）：
   ```powershell
   cd miao\crates\miao-sandbox
   cargo test --release                    # 沙箱后端单测
   cd ..\miao-native
   cargo build --release --bin miao-run   # 产出 target\release\miao-run.exe
   cargo test --release                    # Rust 单测 + Windows 集成测试
   ```
5. **管理员权限**：AppContainer profile 的创建与 ACL 修改通常需要**以管理员身份**运行 PowerShell；普通会话可能失败（见第 4 节，需定义降级）。

> 若 `~/.cargo/config.toml` 被设成 `[net] offline = true`，用 `$env:CARGO_NET_OFFLINE="false"; cargo ...` 覆盖，别直接改掉别人已有的离线配置。

## 1. 目标

- 写：只允许 workdir 与 `--allow-path` 指定的目录；其余拒绝。
- 读：允许（系统文件、只读路径正常读取）。
- 网络：默认拒绝；`--allow-network` 放行。
- 进程树：能随 `miao-run` 一起被终止（不遗留孤儿进程）。
- 门控：仅在 `sandbox` 配置或 `MIAO_SANDBOX` 开启时运行沙箱；找不到后端时回退并**明确报告**，不静默。

## 2. 现状

- 沙箱逻辑在 `crates/miao-sandbox`：`profile()`（seatbelt 文本）、`apply_linux_restrictions()`（landlock）、`supported()`。
- `miao-run`（`crates/miao-native/src/bin/miao-run.rs`）与主二进制的隐藏 `__sandbox-run`（`packages/miao/src/sandbox-runner.ts`，转导 `@miao/core/sandbox/runner`）都调用这个 crate；release 走自执行，dev/测试走 `miao-run`。
- macOS：`sandbox-exec -p <seatbelt profile>`。
- Linux：进程内 landlock（写白名单 + TCP bind/connect 默认禁），已在真机验证；集成测试见 `crates/miao-native/tests/linux-sandbox.rs`。
- Windows：**没有后端**，当前走 `#[cfg(not(any(target_os = "macos", target_os = "linux")))]` 分支，打印 `no sandbox backend` 后**直接运行**。
- 注意：AppContainer 是**创建子进程时**施加的，不是“限制自身”，所以 Windows 不能像 Linux 那样用 `sandboxRestrict` 先限制再 spawn；需要 addon 暴露一个“在 AppContainer 中 spawn”的入口（见第 5 节）。
- 现有 CLI：
  ```
  miao-run [--workdir <dir>]... [--allow-path <dir>]... [--allow-network] [--compat]
           [--deny-report <file>] [--print-profile] -- <command> [args...]
  ```

## 3. 技术选型

**主方案：AppContainer（进程级、内核强制）。**

- 用 `CreateAppContainerProfile` 创建/复用一个容器 profile，得到 AppContainer SID；用 `DeleteAppContainerProfile` 清理。
- 用 ACL API（`SetEntriesInAcl` + `SetNamedSecurityInfo`）把该 SID 授予 workdir 与所有 `--allow-path` 目录（Modify 权限）→ 实现**写白名单**。
- 网络：**默认不授予**任何网络 capability；`--allow-network` 时在 `SECURITY_CAPABILITIES` 中加入 `internetClient`（需要时再加 `internetClientServer` / `privateNetworkClientServer`）。
- 用 `CreateProcess` + `STARTUPINFOEX` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 在容器内启动目标命令。
- **Job object**：`CreateJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（可选内存/进程上限），把子进程加入 job，保证进程树一并结束。
- crate：`windows`（windows-rs）。可选 `win32job`。

**补充/备选：**

- 若需按端口/地址细化网络，叠加 **WFP**（Windows Filtering Platform）按进程 AppID 过滤；AppContainer 的 capability 粒度较粗。
- **不要**用 Windows Sandbox / WDAC / Defender Application Guard：VM 级、面向整机，不适合作为"每条命令一次"的 exec 包装。
- **Job object 单独不提供文件/网络隔离**，只能做资源与生命周期管理，必须与 AppContainer 组合。

## 4. 开始前需要明确的点

1. **权限**：`CreateAppContainerProfile` 在部分环境需要管理员。确认目标机（0xdtee 的 Windows 机器）与 GitHub `windows-2025` runner 是否可创建。runner 通常是 admin，一般可行；普通用户机可能不行。若不可创建，定义降级：报错并（按配置）回退无沙箱，绝不静默。
2. **profile 生命周期**：创建后复用还是每次新建；退出时是否 `DeleteAppContainerProfile`。
3. **ACL 是持久副作用**：把容器 SID 授予目录会**留在 ACL 里**。需明确"用完是否回收"，或接受"只授予不回收"并在文档注明。
4. **`--deny-report`**：Windows 没有 landlock/seatbelt 那样的"被拒路径"内核事件。只能从子进程 stderr 推断，或明确**不支持**（写清限制，别假装有）。
5. **`--compat`**：在 Windows 的语义（允许默认、只禁凭证路径 + 禁网）。
6. **路径规范化**：盘符 / UNC / 大小写 / 8.3 短名；`--workdir` / `--allow-path` 的解析与 canonicalize。

## 5. 实现步骤

0. 在 `crates/miao-native/Cargo.toml` 增加 Windows 依赖（仅 Windows 编译）：
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
   具体 feature 名称以所选 `windows` 版本为准。
1. 新增 `#[cfg(windows)] fn apply_windows_restrictions(workdirs, allow_paths, allow_network) -> Result<JobGuard, String>`。
2. AppContainer：创建 profile → 派生 SID → 对每个 workdir / allow-path 设 ACL（授予改）。
3. 启动：构造 `SECURITY_CAPABILITIES`（含/不含网络 capability），`CreateProcess` 到目标命令。
4. Job object：创建、设 `KILL_ON_JOB_CLOSE`、`AssignProcessToJobObject`。
5. 退出码透传、stderr 收集；`--deny-report` 按第 4 节结论处理。
6. 修改 `main` 的 `#[cfg(not(any(macos,linux)))]` 分支：Windows 走新后端；其余平台保留"无沙箱"提示。
7. TS 侧无需改动：仍由 `SandboxRunner.resolve()` / `SandboxRunner.run()` 调用同一 CLI（`miao-run` 或 `__sandbox-run`）。

## 6. 验证

### 6.1 真机手动矩阵（0xdtee 的 Windows 机器）

| 行为 | 期望 |
|---|---|
| 写 workdir 内文件 | 允许 |
| 写 `%USERPROFILE%\miao-outside.txt` | 拒绝（Access denied） |
| 写 `C:\Windows\Temp\...` | 拒绝 |
| 读 `%SystemRoot%\System32` 下文件 | 允许 |
| `curl http://1.1.1.1`（TCP） | 默认拒绝；`--allow-network` 放行 |
| `cmd /c echo hi`、`powershell -c "..."` | 正常 |
| 终止 `miao-run` | 子进程树一并结束（job object） |

构建与运行：

```powershell
cd crates\miao-native
cargo build --release --bin miao-run
$wd = New-Item -ItemType Directory -Path $env:TEMP\miao-wd -Force
# 写 workdir
.\target\release\miao-run.exe --workdir $wd.FullName -- cmd /c "echo hi > $env:TEMP\miao-wd\in.txt"
# 写 USERPROFILE（应被拒）
.\target\release\miao-run.exe --workdir $wd.FullName -- cmd /c "echo hi > $env:USERPROFILE\miao-outside.txt"
# 网络
.\target\release\miao-run.exe --workdir $wd.FullName -- curl.exe -m 5 -sS -o NUL http://1.1.1.1
.\target\release\miao-run.exe --workdir $wd.FullName --allow-network -- curl.exe -m 5 -sS -o NUL http://1.1.1.1
```

### 6.2 自动化

- 新增 Rust 集成测试 `crates/miao-native/tests/windows-sandbox.rs`（`#![cfg(windows)]`），与 `tests/linux-sandbox.rs` 同构：用 `env!("CARGO_BIN_EXE_miao-run")` 跑上面的矩阵。
- CI：`.github/workflows/native.yml` 增加 `sandbox-windows`（`windows-2025`）跑 `cargo test --release`。
  - 若 AppContainer 在该 runner 上不可用，**允许跳过但必须显式记录原因**（打印并让 job 输出说明），禁止"静默通过"造成假绿。

### 6.3 性能 / 一致性

- 记录相对无沙箱的额外启动延迟（AppContainer create + ACL 设置）。
- 确认基础命令（`cmd /c ver`、`miao-run --version`）在沙箱内正常。

## 7. 验收标准

- 6.1 矩阵在真机全过；6.2 的集成测试在 CI 通过（或显式记录的跳过）。
- 无 AppContainer 权限时：明确报错并按配置回退，**不静默**。
- 不改动 macOS / Linux 行为；沙箱开关由 `sandbox` 配置 / `MIAO_SANDBOX` 门控；Windows 后端尚未实现。

## 8. 风险

- AppContainer 依赖管理员/特定 Windows 版本，企业策略可能禁用。
- ACL 授予是持久副作用，需回收策略。
- capability 粒度的网络控制较粗（需细化时加 WFP）。
- `--deny-report` 精度低于 macOS/Linux；若做不到就明确标注不支持。

## 9. 相关文件

- `crates/miao-sandbox/src/lib.rs`（seatbelt / landlock / 后端分派与 `supported()`）
- `crates/miao-native/src/bin/miao-run.rs`（dev/测试用 runner，调用 `miao-sandbox`）
- `crates/miao-native/tests/linux-sandbox.rs`（Linux 强制集成测试，作为 Windows 版的模板）
- `packages/core/src/sandbox/runner.ts`（`resolve` / `backend`）与 `packages/core/src/sandbox.ts`（`Sandbox.Service`）
- `packages/miao/src/sandbox-runner.ts`（release 自执行的隐藏 `__sandbox-run` 实现）
- `.github/workflows/native.yml`（`native` / `sandbox-linux` job，新增 `sandbox-windows`）
- `docs/rust-rewrite-feasibility.zh.md`（沙箱在整体计划中的位置）
