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
# Release installs also fetch the matching native engine. Local prebuilt pairs
# can use -Binary/-EngineBinary (or MIAO_BINARY/MIAO_ENGINE_BINARY).

param(
  [string]$Version = $(if ($env:MIAO_VERSION) { $env:MIAO_VERSION } else { $env:VERSION }),
  [string]$Binary = $env:MIAO_BINARY,
  [string]$EngineBinary = $env:MIAO_ENGINE_BINARY,
  [switch]$NoModifyPath = ($env:MIAO_NO_MODIFY_PATH -eq "1")
)

function Publish-Miao {
  param([string]$Source, [string]$destination)
  $directory = Split-Path -Parent $destination
  $stage = Join-Path $directory ('.install-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    $candidate = Join-Path $stage 'candidate.exe'
    Copy-Item -LiteralPath $Source -Destination $candidate
    & $candidate --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Executable failed version verification' }
    if ((Test-Path -LiteralPath $destination) -and (Get-FileHash -LiteralPath $candidate).Hash -eq (Get-FileHash -LiteralPath $destination).Hash) {
      return
    }

    # Antivirus products briefly lock freshly copied executables, so the publish
    # steps retry with backoff; retention is idempotent across retries (an
    # existing retained file is hash-checked).
    Get-ChildItem -LiteralPath $directory -File -Filter ((Split-Path -Leaf $destination) + '.bak-*') |
      Remove-Item -Force -ErrorAction SilentlyContinue
    foreach ($attempt in 1..8) {
      try {
        $buildID = (& $candidate --build-id | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $buildID -notmatch '^[0-9a-fA-F-]{36}$') { throw 'Invalid build identity' }
        $retainedDir = Join-Path (Join-Path $directory '.versions') $buildID
        New-Item -ItemType Directory -Force -Path $retainedDir | Out-Null
        $retained = Join-Path $retainedDir (Split-Path -Leaf $destination)
        if (Test-Path -LiteralPath $retained) {
          if ((Get-FileHash -LiteralPath $candidate).Hash -ne (Get-FileHash -LiteralPath $retained).Hash) { throw 'Conflicting build identity' }
        } else {
          New-Item -ItemType HardLink -Path $retained -Target $candidate | Out-Null
        }
        $next = Join-Path $stage 'launcher.exe'
        Remove-Item -LiteralPath $next -Force -ErrorAction SilentlyContinue
        New-Item -ItemType HardLink -Path $next -Target $retained | Out-Null
        if (Test-Path -LiteralPath $destination) {
          $backup = $destination + '.bak-' + [Guid]::NewGuid().ToString('N')
          [IO.File]::Replace($next, $destination, $backup)
        } else { [IO.File]::Move($next, $destination) }
        break
      } catch {
        if ($attempt -ge 8) { throw }
        Start-Sleep -Milliseconds (300 * $attempt)
      }
    }
  } finally { Remove-Item -LiteralPath $stage -Recurse -Force }
}

function Get-MiaoEngineCapabilities {
  param([string]$Binary)
  # Windows PowerShell 5.1 promotes native stderr into an error record. A
  # legacy --capabilities refusal is an expected compatibility result.
  $ErrorActionPreference = 'Continue'
  $previousExitCode = $LASTEXITCODE
  try {
    $reported = & $Binary --capabilities 2>$null | Out-String
    if ($LASTEXITCODE -ne 0) { return $null }
    try {
      $capabilities = $reported | ConvertFrom-Json -ErrorAction Stop
      if ($capabilities.name -ne 'miao-engine' -or $capabilities.version -isnot [string]) { return $null }
      if ($capabilities.protocol -isnot [int] -and $capabilities.protocol -isnot [long]) { return $null }
      if ($capabilities.protocol -lt 2) { return $null }
      return $capabilities
    } catch { return $null }
  } finally {
    # CI shells propagate LASTEXITCODE; an optional compatibility probe must
    # not turn a successful TypeScript-only installation into a failed job.
    $global:LASTEXITCODE = $previousExitCode
  }
}

function Install-MiaoEngine {
  param([string]$InstallDirectory, [string]$Version, [string]$Binary, [bool]$Download)

  if (-not $Binary -and -not $Download) { return }
  $destination = Join-Path $InstallDirectory 'miao-engine.exe'
  if (-not $Binary -and (Test-Path -LiteralPath $destination)) {
    $capabilities = Get-MiaoEngineCapabilities $destination
    if ($capabilities -and $capabilities.version -eq $Version) { return }
  }

  $stage = Join-Path $InstallDirectory ('.engine-install-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    $candidate = Join-Path $stage 'miao-engine.exe'
    if ($Binary) {
      if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) { throw "Engine binary not found: $Binary" }
      Copy-Item -LiteralPath $Binary -Destination $candidate
    } else {
      # The product ships x64 on Windows, including under ARM emulation.
      $asset = 'miao-engine-windows-x64.zip'
      $url = "https://github.com/oxdingzg/miao/releases/download/v$Version/$asset"
      $archive = Join-Path $stage $asset
      try {
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
      } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
          Write-Host 'This release has no native engine archive; keeping TypeScript sessions.' -ForegroundColor DarkGray
          return
        }
        throw
      }
      $manifest = Join-Path $stage ($asset + '.sha256')
      Invoke-WebRequest -UseBasicParsing -Uri ($url + '.sha256') -OutFile $manifest
      if ((Get-Content -LiteralPath $manifest -Raw).Trim() -notmatch ('^([a-fA-F0-9]{64})  ' + [regex]::Escape($asset) + '$')) {
        throw 'Invalid engine checksum manifest.'
      }
      $expected = $Matches[1]
      if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'Engine archive checksum mismatch.' }
      Expand-Archive -LiteralPath $archive -DestinationPath $stage -Force
      if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw 'Engine archive has no miao-engine.exe.' }
    }
    # Old releases predate this handshake. They remain usable through the
    # TypeScript engine, without replacing an already compatible sidecar.
    $capabilities = Get-MiaoEngineCapabilities $candidate
    if (-not $capabilities) {
      if ($Binary) { throw 'Engine does not support the required protocol (2).' }
      Write-Host 'This release engine predates the required protocol; keeping TypeScript sessions.' -ForegroundColor DarkGray
      return
    }
    if ($capabilities.version -ne $Version) { throw "Engine version does not match miao $Version." }
    if ((Test-Path -LiteralPath $destination) -and (Get-FileHash -LiteralPath $candidate).Hash -eq (Get-FileHash -LiteralPath $destination).Hash) {
      return
    }
    foreach ($attempt in 1..8) {
      try {
        if (Test-Path -LiteralPath $destination) {
          [IO.File]::Replace($candidate, $destination, (Join-Path $InstallDirectory 'miao-engine.prev.exe'))
        } else { [IO.File]::Move($candidate, $destination) }
        break
      } catch {
        if ($attempt -ge 8) { throw }
        Start-Sleep -Milliseconds (300 * $attempt)
      }
    }
    Write-Host "Native engine installed: $destination" -ForegroundColor DarkGray
  } finally { Remove-Item -LiteralPath $stage -Recurse -Force }
}

function Install-Miao {
  param([string]$Version, [string]$Binary, [string]$EngineBinary, [bool]$NoModifyPath)

  # Errors throw instead of `exit`: under `irm | iex` an exit would close the
  # user's PowerShell window.
  $ErrorActionPreference = "Stop"
  # Invoke-WebRequest's progress bar makes PowerShell 5.1 downloads many times slower.
  $ProgressPreference = "SilentlyContinue"
  # PowerShell 5.1 may still default to TLS 1.0, which GitHub refuses.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = "oxdingzg/miao"
  $installDir = if ($env:MIAO_INSTALL_DIR) { $env:MIAO_INSTALL_DIR } else { Join-Path $HOME ".miao\bin" }
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
    Publish-Miao $Binary $exe
    $Version = (& $exe --version | Out-String).Trim()
    Install-MiaoEngine -InstallDirectory $installDir -Version $Version -Binary $EngineBinary -Download:$false
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
        # Reconcile a missing sidecar even when the product is already current.
        Install-MiaoEngine -InstallDirectory $installDir -Version $Version -Binary $EngineBinary -Download:$true
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
      $actual = (& $downloaded.FullName --version | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or $actual -ne $Version) { throw 'Release failed version verification' }
      Publish-Miao $downloaded.FullName $exe
      Install-MiaoEngine -InstallDirectory $installDir -Version $Version -Binary $EngineBinary -Download:$true
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

Install-Miao -Version $Version -Binary $Binary -EngineBinary $EngineBinary -NoModifyPath:$NoModifyPath
