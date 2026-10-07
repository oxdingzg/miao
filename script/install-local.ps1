#!/usr/bin/env pwsh
# Build the current platform's miao binary and install it as the daily `miao`
# command on Windows, keeping the previous install for one-step rollback.
#
#   pwsh -File script/install-local.ps1
#
# IMPORTANT: the running agent IS `miao-bin.exe`. Windows cannot overwrite a
# running process image in place, and `Stop-Process miao-bin` takes the agent
# down with it (this is exactly what froze previous sessions mid-task). So this
# script never kills miao-bin and never copies over the live exe: it renames the
# running exe aside first (which Windows does allow) and then writes the new one.

[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\Miao"),
  [string]$ExeName = "miao-bin.exe",
  [string]$DbChannel = "local",
  [string]$Version,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$builtDir = Join-Path $repo "packages\miao\dist\miao-windows-x64\bin"
$builtExe = Join-Path $builtDir "miao.exe"
$builtModels = Join-Path $builtDir "models.json"
$target = Join-Path $InstallDir $ExeName
$prev = "$target.prev"

if (-not $Version) {
  # Preserve the currently installed version string when we can.
  if (Test-Path -LiteralPath $target) {
    try { $Version = (& $target --version 2>$null | Select-Object -First 1).Trim() } catch {}
  }
  if (-not $Version) { $Version = "0.0.1-$DbChannel" }
}

if (-not $SkipBuild) {
  Write-Host "==> building miao-windows-x64 (channel=$DbChannel version=$Version)"
  $env:MIAO_CHANNEL = $DbChannel
  $env:MIAO_VERSION = $Version
  & bun run --cwd (Join-Path $repo "packages\miao") script/build.ts --single --skip-install --skip-embed-web-ui
  if ($LASTEXITCODE -ne 0) { throw "build failed (exit $LASTEXITCODE)" }
}

if (-not (Test-Path -LiteralPath $builtExe)) { throw "built binary not found: $builtExe (run without -SkipBuild)" }

Write-Host "==> smoke test (built)"
& $builtExe --version

if (-not (Test-Path -LiteralPath $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir | Out-Null }

if (Test-Path -LiteralPath $target) {
  if (Test-Path -LiteralPath $prev) {
    try {
      Remove-Item -LiteralPath $prev -Force -ErrorAction Stop
    } catch {
      # `.prev` (or `target`) can be the mapped image of the running agent. Windows
      # refuses to delete a running exe, but it does allow renaming it. Rotate it aside.
      Rename-Item -LiteralPath $prev -NewName ("$ExeName.prev-" + (Get-Date -Format yyyyMMdd-HHmmss))
    }
  }
  # Rename, do NOT kill and do NOT overwrite: the running process keeps the renamed image.
  Rename-Item -LiteralPath $target -NewName (Split-Path -Leaf $prev)
}
Copy-Item -LiteralPath $builtExe -Destination $target -Force
if (Test-Path -LiteralPath $builtModels) {
  Copy-Item -LiteralPath $builtModels -Destination (Join-Path $InstallDir "models.json") -Force
  $cacheDir = Join-Path $InstallDir ".local\cache\miao"
  if (Test-Path -LiteralPath $cacheDir) {
    Copy-Item -LiteralPath $builtModels -Destination (Join-Path $cacheDir "models.json") -Force
  }
}

# Carry session data across the opencode-<channel>.db -> miao-<channel>.db rename.
$dataDir = Join-Path $InstallDir ".local\data\miao"
if (Test-Path -LiteralPath $dataDir) {
  foreach ($suffix in @("", "-shm", "-wal")) {
    $old = Join-Path $dataDir ("opencode-$DbChannel.db$suffix")
    $new = Join-Path $dataDir ("miao-$DbChannel.db$suffix")
    if ((Test-Path -LiteralPath $old) -and -not (Test-Path -LiteralPath $new)) {
      Copy-Item -LiteralPath $old -Destination $new -Force
      Write-Host "==> migrated $(Split-Path -Leaf $old)"
    }
  }
}

Write-Host "==> installed"
$cmd = Join-Path $InstallDir "miao.cmd"
if (Test-Path -LiteralPath $cmd) {
  Write-Host ("    version: " + (& $cmd --version 2>$null | Select-Object -First 1))
}
Write-Host "    $target  (previous kept at $prev)"
Write-Host "    rollback: Move-Item -Force '$prev' '$target'"
