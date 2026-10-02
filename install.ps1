# miao installer for Windows (PowerShell 5.1 and PowerShell 7).
#
#   irm https://mtty.dev/miao/install.ps1 | iex
#
# A pipe into `iex` cannot take parameters, so options also come from the
# environment:
#
#   $env:MIAO_VERSION = "0.0.33"; irm https://mtty.dev/miao/install.ps1 | iex
#
# or run the downloaded script with parameters:
#
#   & ([scriptblock]::Create((irm https://mtty.dev/miao/install.ps1))) -Version 0.0.33
#
# The binary goes to $HOME\.miao\bin, the same directory the bash installer uses,
# and that directory is added to the user PATH.

param(
  [string]$Version = $(if ($env:MIAO_VERSION) { $env:MIAO_VERSION } else { $env:VERSION }),
  [string]$Binary = $env:MIAO_BINARY,
  [switch]$NoModifyPath = ($env:MIAO_NO_MODIFY_PATH -eq "1")
)

function Install-Miao {
  param([string]$Version, [string]$Binary, [bool]$NoModifyPath)

  # Errors throw instead of `exit`: under `irm | iex` an exit would close the
  # user's PowerShell window.
  $ErrorActionPreference = "Stop"
  # Invoke-WebRequest's progress bar makes PowerShell 5.1 downloads many times slower.
  $ProgressPreference = "SilentlyContinue"
  # PowerShell 5.1 may still default to TLS 1.0, which GitHub refuses.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = "oxdingzg/miao"
  $installDir = Join-Path $HOME ".miao\bin"
  $exe = Join-Path $installDir "miao.exe"

  if (-not [Environment]::Is64BitOperatingSystem) {
    throw "miao needs 64-bit Windows."
  }
  # Releases ship windows-x64 only; Windows on ARM runs it under x64 emulation.
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  if ($arch -eq "ARM64") {
    Write-Host "Windows on ARM: installing the x64 build, which runs under emulation." -ForegroundColor DarkGray
  }

  New-Item -ItemType Directory -Force -Path $installDir | Out-Null

  if ($Binary) {
    if (-not (Test-Path $Binary)) { throw "Binary not found: $Binary" }
    Write-Host "Installing miao from $Binary"
    Copy-Item -Force $Binary $exe
  }
  else {
    $Version = $Version -replace "^v", ""
    if (-not $Version) {
      $release = Invoke-RestMethod -UseBasicParsing -Headers @{ "User-Agent" = "miao-installer" } `
        -Uri "https://api.github.com/repos/$repo/releases/latest"
      $Version = $release.tag_name -replace "^v", ""
      if (-not $Version) { throw "Could not determine the latest miao version." }
    }

    if (Test-Path $exe) {
      $installed = (& $exe --version 2>$null | Out-String).Trim()
      if ($installed -eq $Version) {
        Write-Host "miao $Version is already installed at $exe"
        Add-MiaoToPath $installDir $NoModifyPath
        return
      }
      if ($installed) { Write-Host "Installed version: $installed" -ForegroundColor DarkGray }
    }

    $url = "https://github.com/$repo/releases/download/v$Version/miao-windows-x64.zip"
    Write-Host "Installing miao version $Version"
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("miao_install_" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
      $zip = Join-Path $tmp "miao-windows-x64.zip"
      try {
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
      }
      catch {
        throw "Download failed for miao $Version ($url). Available releases: https://github.com/$repo/releases"
      }
      Expand-Archive -Force -Path $zip -DestinationPath $tmp
      $downloaded = Get-ChildItem -Path $tmp -Recurse -Filter "miao.exe" | Select-Object -First 1
      if (-not $downloaded) { throw "miao.exe was not found in $url" }
      # A running miao.exe cannot be overwritten, but it can be renamed out of the way.
      if (Test-Path $exe) {
        $old = "$exe.old"
        Remove-Item -Force $old -ErrorAction SilentlyContinue
        try { Move-Item -Force $exe $old } catch { throw "Close every running miao and try again: $exe is in use." }
      }
      Move-Item -Force $downloaded.FullName $exe
      Remove-Item -Force "$exe.old" -ErrorAction SilentlyContinue
    }
    finally {
      Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
  }

  Add-MiaoToPath $installDir $NoModifyPath

  Write-Host ""
  Write-Host " /\_/\   miao $((& $exe --version 2>$null | Out-String).Trim())" -ForegroundColor Magenta
  Write-Host "( o.o )  installed to $exe"
  Write-Host " > ^ <"
  Write-Host ""
  Write-Host "cd <project>   # open a project"
  Write-Host "miao           # start"
  Write-Host ""
  Write-Host "Docs: https://mtty.dev/docs/miao" -ForegroundColor DarkGray
}

function Add-MiaoToPath {
  param([string]$Dir, [bool]$NoModifyPath)

  if ($env:GITHUB_ACTIONS -eq "true" -and $env:GITHUB_PATH) {
    Add-Content -Path $env:GITHUB_PATH -Value $Dir
    Write-Host "Added $Dir to GITHUB_PATH"
  }

  $inSession = ($env:Path -split ";") -contains $Dir
  if (-not $inSession) { $env:Path = "$Dir;$env:Path" }
  if ($NoModifyPath) { return }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = if ($userPath) { $userPath -split ";" } else { @() }
  if ($entries -contains $Dir) { return }
  $next = if ($userPath) { "$Dir;$userPath" } else { $Dir }
  [Environment]::SetEnvironmentVariable("Path", $next, "User")
  Write-Host "Added $Dir to your user PATH. Open a new terminal for other windows to pick it up." -ForegroundColor DarkGray
}

Install-Miao -Version $Version -Binary $Binary -NoModifyPath:$NoModifyPath
