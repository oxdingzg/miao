import path from "node:path"

export function isWindowsStandalone(executable: string, localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData) return false
  return (
    path.win32.normalize(executable).toLowerCase() ===
    path.win32.join(localAppData, "Programs", "Miao", "miao.exe").toLowerCase()
  )
}

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
try {
  $version = $env:MIAO_UPGRADE_VERSION
  if ($version -notmatch '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$') { throw 'Invalid release version' }
  $destination = $env:MIAO_UPGRADE_EXECUTABLE
  $directory = Split-Path -Parent $destination
  $phase = 'lock'
  $lock = [IO.File]::Open((Join-Path $directory '.miao-upgrade.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
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
  $backup = $destination + '.bak-' + [Guid]::NewGuid().ToString('N')
  [IO.File]::Move($destination, $backup)
  try {
    [IO.File]::Move($candidate, $destination)
  } catch {
    [IO.File]::Move($backup, $destination)
    throw
  }
  [Console]::Out.WriteLine('Installed ' + $version + '; previous executable: ' + $backup)
} catch {
  # Avoid exposing credentials embedded in proxy URLs or arbitrary child output.
  $cause = $_.Exception
  while ($cause.InnerException) { $cause = $cause.InnerException }
  [Console]::Error.WriteLine('Windows upgrade failed during ' + $phase + ' (' + $cause.GetType().Name + ', HRESULT=' + ('0x{0:X8}' -f $cause.HResult) + '). ' +
    $(if ($phase -eq 'download') { 'Check HTTPS_PROXY or Windows system proxy settings and GitHub connectivity.' } else { 'The previous executable was preserved; check permissions, antivirus locks, and the release archive.' }))
  exit 1
} finally {
  $client.Dispose()
  if ($lock) { $lock.Dispose() }
  if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
`
