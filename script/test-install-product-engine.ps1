# Real executable fixtures for the standalone Windows product installer.
# Compile and run on Windows; all publication happens in a temporary directory.
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('miao-product-engine-test-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
$originalInstall = $env:MIAO_INSTALL_DIR
$originalEngine = $env:MIAO_ENGINE_BINARY
$originalPath = $env:Path
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
try {
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  function New-Fixture {
    param([string]$Name, [string]$Version, [int]$Protocol = 2)
    $id = [Guid]::NewGuid().ToString()
    $source = Join-Path $root ($Name + '.cs')
    $binary = Join-Path $root ($Name + '.exe')
    $versionOutput = if ($Name.StartsWith('product')) { $Version } else { 'miao-engine ' + $Version }
    $json = '{"name":"miao-engine","version":"' + $Version + '","protocol":' + $Protocol + ',"schema":12}'
    $escaped = $json.Replace('"', '\"')
    $handshake = if ($Protocol -eq 0) { 'System.Console.Error.WriteLine("unknown option"); return 2;' } else { 'System.Console.WriteLine("' + $escaped + '"); return 0;' }
    Set-Content -LiteralPath $source -Value @"
public class Fixture {
  public static int Main(string[] args) {
    if (args.Length == 0) return 1;
    if (args[0] == "--version") { System.Console.WriteLine("$versionOutput"); return 0; }
    if (args[0] == "--build-id") { System.Console.WriteLine("$id"); return 0; }
    if (args[0] == "--capabilities") { $handshake }
    return 1;
  }
}
"@
    & $compiler /nologo /target:exe "/out:$binary" $source
    if ($LASTEXITCODE -ne 0) { throw "Fixture compilation failed: $Name" }
    return $binary
  }
  $product = New-Fixture 'product-first' '1.0.0'
  $productNext = New-Fixture 'product-next' '1.0.1'
  $engine = New-Fixture 'engine-first' '1.0.0'
  $engineNext = New-Fixture 'engine-next' '1.0.1'
  $legacy = New-Fixture 'engine-legacy' '1.0.1' 1
  $ancient = New-Fixture 'engine-ancient' '1.0.1' 0
  $mismatch = New-Fixture 'engine-mismatch' '9.0.0'
  $env:MIAO_INSTALL_DIR = Join-Path $root 'installed'
  $env:MIAO_ENGINE_BINARY = $null
  $installer = Join-Path (Split-Path -Parent $PSScriptRoot) 'install.ps1'
  $current = Join-Path $env:MIAO_INSTALL_DIR 'miao-engine.exe'
  $previous = Join-Path $env:MIAO_INSTALL_DIR 'miao-engine.prev.exe'

  & $installer -Binary $product -NoModifyPath
  if (Test-Path -LiteralPath $current) { throw 'A product-only local install unexpectedly installed an engine.' }
  # A same-version product install must still repair its missing sidecar.
  & $installer -Version '1.0.0' -EngineBinary $engine -NoModifyPath
  if ((& $current --version) -ne 'miao-engine 1.0.0') { throw 'Same-version sidecar repair failed.' }
  & $installer -Binary $productNext -EngineBinary $engineNext -NoModifyPath
  if ((& $current --version) -ne 'miao-engine 1.0.1') { throw 'Engine upgrade failed.' }
  if ((& $previous --version) -ne 'miao-engine 1.0.0') { throw 'Engine upgrade lost the rollback executable.' }
  $currentHash = (Get-FileHash -LiteralPath $current).Hash
  $previousHash = (Get-FileHash -LiteralPath $previous).Hash
  & $installer -Version '1.0.1' -NoModifyPath
  & $installer -Binary $productNext -EngineBinary $engineNext -NoModifyPath
  if ((Get-FileHash -LiteralPath $previous).Hash -ne $previousHash) { throw 'Idempotent installation changed the rollback slot.' }

  foreach ($bad in @($legacy, $ancient, $mismatch, (Join-Path $root 'missing.exe'))) {
    $failed = $false
    try { & $installer -Version '1.0.1' -EngineBinary $bad -NoModifyPath } catch { $failed = $true }
    if (-not $failed) { throw 'Invalid engine source was accepted.' }
    if ((Get-FileHash -LiteralPath $current).Hash -ne $currentHash) { throw 'Invalid source replaced the installed engine.' }
    if ((Get-FileHash -LiteralPath $previous).Hash -ne $previousHash) { throw 'Invalid source changed the rollback slot.' }
  }
  if (@(Get-ChildItem -LiteralPath $env:MIAO_INSTALL_DIR -Directory -Filter '.engine-install-*').Count -ne 0) { throw 'Engine staging files leaked.' }
  if ([Environment]::GetEnvironmentVariable('Path', 'User') -ne $userPath) { throw '-NoModifyPath changed the user PATH.' }
  & (Join-Path $PSScriptRoot 'install-engine.ps1') -Rollback -InstallDirectory $env:MIAO_INSTALL_DIR
  if ((& $current --version) -ne 'miao-engine 1.0.0') { throw 'Dedicated rollback could not restore the product-installed engine.' }
  Write-Output 'WINDOWS-PRODUCT-ENGINE: PASS install/repair/upgrade/idempotence/protocol/version/failure/rollback'
} finally {
  $env:MIAO_INSTALL_DIR = $originalInstall
  $env:MIAO_ENGINE_BINARY = $originalEngine
  $env:Path = $originalPath
  Remove-Item -LiteralPath $root -Recurse -Force
}
