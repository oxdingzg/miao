# Windows VT verification checklist

**Language:** [English](windows-vt-verification.en.md) | [中文](windows-vt-verification.zh.md)

Background: legacy Windows consoles (old conhost / PowerShell 5.1 / cmd) do not interpret ANSI
escapes by default, so the UI prints `\x1b[38;5;…m` sequences **literally**. The fix enables
`ENABLE_VIRTUAL_TERMINAL_PROCESSING` on the stdout/stderr handles at startup
(`packages/tui/src/terminal-win32.ts`) and falls back to plain text when VT cannot be enabled or
output is redirected. This page is the on-device verification.

## Setup

```powershell
# Install via the PowerShell script
irm https://raw.githubusercontent.com/oxdingzg/miao/main/install.ps1 | iex
# Or drop the miao.exe from miao-windows-x64.zip onto PATH
miao --version
```

## Test matrix

| # | Terminal | Command | Expected |
|---|---|---|---|
| 1 | Windows Terminal + pwsh 7 | `miao --help` | cat logo + help, **no** raw `\x1b` |
| 2 | PowerShell 5.1 (legacy conhost) | `miao --help` | same (the app enables VT itself) |
| 3 | cmd.exe | `miao --help` | same |
| 4 | any | `miao --help > out.txt 2>&1`, then inspect `out.txt` | plain text, no `\x1b` (redirect fallback) |
| 5 | any | `set NO_COLOR=1 & miao --help` | plain text |
| 6 | Windows Terminal | `miao` (TUI) | renders normally; if VT is truly unavailable it should print a **clear error telling you to use Windows Terminal / pwsh 7**, never a wall of escapes |
| 7 | Windows Terminal | `miao run "..."` (mini footer) | renders normally, no garbage |

## Pass criteria

- Cases 1-5 must show **no `\x1b`** (search the output for `\x1b`, `[38;`, or `[48;`).
- Case 6 passes with either outcome: it renders, or it prints the clear message; a screen full of
  `[…m` is a failure.

Check for raw escapes:

```powershell
$out = miao --help 2>&1 | Out-String
if ($out -match "\x1b\[") { "FAIL: raw ANSI present" } else { "OK" }
```

## Known boundaries

- Windows < 10 1511 has no VT: `SetConsoleMode` fails and we fall back to plain text.
- Redirected, non-console output makes `GetConsoleMode` fail, so we also fall back to plain text.
- If a legacy console still garbles, opentui may be writing to the console directly rather than via
  `process.stdout`; that would need to be handled in the opentui layer.

## Record

When verifying, attach: Windows version, terminal, `miao --version`, and the actual output of each
case (text or screenshot).
