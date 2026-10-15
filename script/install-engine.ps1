param(
    [string]$Binary,
    [string]$Release,
    [switch]$Rollback,
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'miao-engine\bin'),
    [string]$ReleaseBaseUrl = 'https://github.com/oxdingzg/miao/releases'
)
# Dedicated engine installation; never replaces the daily miao command.
# -Binary installs a prebuilt executable, -Release latest/vX.Y.Z downloads a
# verified ZIP, and -Rollback atomically restores the previous executable.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (([int]([bool]$Binary) + [int]([bool]$Release) + [int]$Rollback.IsPresent) -ne 1) {
    throw 'Choose exactly one of -Binary <path>, -Release <tag|latest>, or -Rollback.'
}
$Current = Join-Path $InstallDirectory 'miao-engine.exe'
$Previous = Join-Path $InstallDirectory 'miao-engine.prev.exe'
$Temporary = $null
$Staged = $null
try {
    New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
    if ($Rollback) {
        if (!(Test-Path -LiteralPath $Previous -PathType Leaf)) { throw 'No previous engine installation.' }
        $Staged = Join-Path $InstallDirectory ('rollback-' + [guid]::NewGuid() + '.exe')
        Copy-Item -LiteralPath $Previous -Destination $Staged
    } else {
        if ($Release) {
            $Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
            if ($Architecture -ne 'x64' -and $Architecture -ne 'arm64') { throw "Unsupported architecture: $Architecture" }
            $Asset = "miao-engine-windows-$Architecture.zip"
            $Base = $ReleaseBaseUrl.TrimEnd('/')
            $Url = if ($Release -eq 'latest') { "$Base/latest/download/$Asset" } else { "$Base/download/$Release/$Asset" }
            $Temporary = Join-Path ([IO.Path]::GetTempPath()) ('miao-engine-' + [guid]::NewGuid())
            New-Item -ItemType Directory -Path $Temporary | Out-Null
            $Archive = Join-Path $Temporary $Asset
            Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Archive
            $ManifestFile = Join-Path $Temporary "$Asset.sha256"
            Invoke-WebRequest -UseBasicParsing -Uri "$Url.sha256" -OutFile $ManifestFile
            $Manifest = (Get-Content -LiteralPath $ManifestFile -Raw).Trim()
            if ($Manifest -notmatch ('^([a-fA-F0-9]{64})  ' + [regex]::Escape($Asset) + '$')) { throw 'Invalid checksum manifest.' }
            $Expected = $Matches[1]
            if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $Expected) { throw 'Engine archive checksum mismatch.' }
            Expand-Archive -LiteralPath $Archive -DestinationPath $Temporary
            $Binary = Join-Path $Temporary 'miao-engine.exe'
        }
        if (!(Test-Path -LiteralPath $Binary -PathType Leaf)) { throw "Engine binary missing: $Binary" }
        $Staged = Join-Path $InstallDirectory ('install-' + [guid]::NewGuid() + '.exe')
        Copy-Item -LiteralPath $Binary -Destination $Staged
    }
    # Validate the staged binary before touching either installed executable.
    $Version = (& $Staged --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $Version -notmatch '^miao-engine \S+$') { throw 'Engine version smoke test failed.' }
    if (Test-Path -LiteralPath $Current) {
        # Same-volume replacement preserves the old current executable as the
        # rollback slot. No symlink/developer-mode privilege is needed.
        [IO.File]::Replace($Staged, $Current, $Previous)
    } else {
        [IO.File]::Move($Staged, $Current)
    }
    $Staged = $null
    Write-Output "Installed $Version at $Current"
    Write-Output "Rollback: powershell -NoProfile -File script/install-engine.ps1 -Rollback -InstallDirectory '$InstallDirectory'"
} finally {
    if ($Staged -and (Test-Path -LiteralPath $Staged)) { Remove-Item -LiteralPath $Staged -Force }
    if ($Temporary -and (Test-Path -LiteralPath $Temporary)) { Remove-Item -LiteralPath $Temporary -Recurse -Force }
}
