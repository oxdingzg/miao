// PowerShell 5.1 is included in supported Windows releases. Use its system proxy
// settings when no explicit proxy is configured; Bun does not read WinINet.
const network = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$client = New-Object Net.WebClient
$client.Headers.Add('User-Agent', 'miao-upgrade')
$proxy = if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } elseif ($env:HTTP_PROXY) { $env:HTTP_PROXY } else { $null }
if ($proxy) { $client.Proxy = New-Object Net.WebProxy($proxy) }
else { $client.Proxy = [Net.WebRequest]::GetSystemWebProxy() }
if ($client.Proxy) { $client.Proxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials }
`

export function windowsCommand(script: string) {
  return [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]
}

export const windowsLatest = `${network}
try {
  $request = [Net.HttpWebRequest]::Create('https://github.com/oxdingzg/miao/releases/latest')
  $request.AllowAutoRedirect = $false
  $request.Proxy = $client.Proxy
  $request.UserAgent = 'miao-upgrade'
  $response = $request.GetResponse()
  $location = $response.Headers['Location']
  $response.Dispose()
  if ($location -match '/releases/tag/v?([^/?#]+)$') {
    [Console]::Out.Write($Matches[1])
    exit 0
  }
  $release = $client.DownloadString('https://api.github.com/repos/oxdingzg/miao/releases/latest') | ConvertFrom-Json
  [Console]::Out.Write($release.tag_name.TrimStart('v'))
} finally { $client.Dispose() }
`

export const windowsUpgrade = `${network}
$phase = 'prepare'
$stage = $null
$backup = $null
$lock = $null
$replaced = $false
try {
  $version = $env:MIAO_UPGRADE_VERSION
  if ($version -notmatch '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$') { throw 'Invalid release version' }
  $destination = $env:MIAO_UPGRADE_EXECUTABLE
  $directory = Split-Path -Parent $destination
  $phase = 'lock'
  $lock = [IO.File]::Open((Join-Path $directory '.miao-upgrade.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  # A previous run leaves its stage behind when a locked file (antivirus, a
  # still-running child) blocks removal. The lock proves no other installer is
  # active, so sweep those leftover stages before creating this run's.
  Get-ChildItem -LiteralPath $directory -Directory -Filter '.miao-upgrade-*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  $stage = Join-Path $directory ('.miao-upgrade-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  $asset = 'miao-windows-arm64.zip'
  if ($env:MIAO_UPGRADE_ARCH -ne 'arm64') {
    $cpu = Add-Type -Name MiaoCpu -Namespace Upgrade -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature);' -PassThru
    $asset = if ($cpu::IsProcessorFeaturePresent(40)) { 'miao-windows-x64.zip' } else { 'miao-windows-x64-baseline.zip' }
  }
  $phase = 'download'
  $archive = Join-Path $stage 'release.zip'
  $client.DownloadFile(('https://github.com/oxdingzg/miao/releases/download/v' + $version + '/' + $asset), $archive)
  $phase = 'extract'
  Expand-Archive -LiteralPath $archive -DestinationPath $stage
  $candidates = @(Get-ChildItem -LiteralPath $stage -Filter miao.exe -Recurse -File)
  if ($candidates.Count -ne 1) { throw 'Release must contain exactly one miao.exe' }
  $candidate = $candidates[0].FullName
  $phase = 'verify'
  $actual = (& $candidate --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $actual -ne $version) { throw 'Release executable failed version verification' }
  $phase = 'replace'

  # Antivirus products briefly lock freshly extracted executables, so the steps
  # that touch the downloaded candidate retry with backoff. Retaining the build
  # is idempotent across retries (an existing retained file is hash-checked), so
  # re-running the section after a partial attempt is safe.
  Get-ChildItem -LiteralPath $directory -File -Filter ((Split-Path -Leaf $destination) + '.bak-*') |
    Remove-Item -Force -ErrorAction SilentlyContinue
  $backup = $null
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
  $replaced = $true
  [Console]::Out.WriteLine('Installed ' + $version + '; previous executable: ' + $backup)
} catch {
  # Avoid exposing credentials embedded in proxy URLs or arbitrary child output.
  $cause = $_.Exception
  while ($cause.InnerException) { $cause = $cause.InnerException }
  $detail = '(' + $cause.GetType().Name + ', HRESULT=' + ('0x{0:X8}' -f $cause.HResult) + ')'
  if ($replaced) {
    # The new build is already in place, so a later step only failed to tidy up.
    # Report it as installed rather than a failure that leaves the user thinking
    # they are still on the old version.
    [Console]::Out.WriteLine('Installed ' + $version + '; post-install step failed during ' + $phase + ' ' + $detail + '.')
    exit 0
  }
  $code = '0x{0:X8}' -f $cause.HResult
  $hint = if ($phase -eq 'download') { 'Check HTTPS_PROXY or Windows system proxy settings and GitHub connectivity.' }
  elseif ($code -eq '0x80070020') { 'A needed file was locked by another process, commonly antivirus scanning the freshly downloaded release; the previous executable was preserved and retrying in a few minutes usually succeeds.' }
  elseif ($code -eq '0x80070005') { 'The previous executable was preserved; run from an elevated prompt when the install directory requires administrator rights.' }
  else { 'The previous executable was preserved; check permissions, antivirus locks, and the release archive.' }
  [Console]::Error.WriteLine('Windows upgrade failed during ' + $phase + ' ' + $detail + '. ' + $hint)
  exit 1
} finally {
  # Cleanup must never change the exit code: a throwing dispose would otherwise
  # turn a successful install into a reported failure.
  try { $client.Dispose() } catch { }
  try { if ($lock) { $lock.Dispose() } } catch { }
  if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
`
