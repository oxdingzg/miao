# Windows VT 真机验证清单

**语言 / Language:** [中文](windows-vt-verification.zh.md) | [English](windows-vt-verification.en.md)

背景：老式 Windows 控制台（老 conhost / PowerShell 5.1 / cmd）默认不解释 ANSI 转义，导致界面把 `\x1b[38;5;…m` 之类**按字面打印**成乱码。修复是：启动时对 stdout/stderr 句柄开启 `ENABLE_VIRTUAL_TERMINAL_PROCESSING`（`packages/tui/src/terminal-win32.ts`），并在**无法开启或输出被重定向**时降级为纯文本。下面是在真机上确认这套逻辑的步骤。

## 准备

```powershell
# 用 release 安装脚本（Git Bash 或 WSL 里执行）
curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash
# 或直接把 miao-windows-x64.zip 解压出来的 miao.exe 放到 PATH
miao --version
```

## 用例矩阵

| # | 终端 | 命令 | 期望 |
|---|---|---|---|
| 1 | Windows Terminal + pwsh 7 | `miao --help` | 猫 logo + 帮助，**无** `\x1b` 原始码 |
| 2 | PowerShell 5.1（老 conhost） | `miao --help` | 同上（程序自行开启 VT） |
| 3 | cmd.exe | `miao --help` | 同上 |
| 4 | 任意 | `miao --help > out.txt 2>&1` 然后看 `out.txt` | 纯文本，不含 `\x1b`（重定向降级） |
| 5 | 任意 | `set NO_COLOR=1 & miao --help` | 纯文本 |
| 6 | Windows Terminal | `miao`（TUI） | 正常渲染；若真的无 VT，应**明确报错提示用 Windows Terminal / pwsh 7**，而不是刷乱码 |
| 7 | Windows Terminal | `miao run "..."`（--mini footer） | 正常渲染，无乱码 |

## 判定

- 用例 1–5 必须全部**看不到 `\x1b`**（可用 `findstr` / 编辑器搜索 `\x1b` 或 `[38;` 检查）。
- 用例 6 的两种结果都算通过：要么正常渲染，要么是清晰的提示语；**不允许**出现满屏 `[…m`。

检查是否有原始转义：

```powershell
$out = miao --help 2>&1 | Out-String
if ($out -match "\x1b\[") { "FAIL: raw ANSI present" } else { "OK" }
```

## 已知边界

- Windows < 10 1511 不支持 VT：`SetConsoleMode` 会失败，此时走纯文本降级。
- 输出被重定向（非控制台句柄）时 `GetConsoleMode` 失败 → 同样降级纯文本。
- 若老控制台仍乱码，说明 opentui 可能绕过 `process.stdout` 直写控制台；需在 opentui 层处理。

## 记录

验证时请附上：Windows 版本、终端、`miao --version`、以及每个用例的实际输出截图/文本。
