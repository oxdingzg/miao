# Run on Windows: real executable fixtures, no release publication or compiler
# work on the workstation. An isolated install directory keeps daily tools safe.
$ErrorActionPreference = 'Stop'
$Root = Join-Path ([IO.Path]::GetTempPath()) ('engine-install-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Root | Out-Null
try {
    $First = Join-Path $Root 'first.exe'
    $Second = Join-Path $Root 'second.exe'
    # Use the installed Framework compiler so fixtures work under both
    # Windows PowerShell 5.1 and PowerShell 7 (whose Add-Type cannot emit a
    # console application).
    $Compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $FirstSource = Join-Path $Root 'first.cs'
    $SecondSource = Join-Path $Root 'second.cs'
    Set-Content -LiteralPath $FirstSource -Value 'public class EngineFirst { public static void Main() { System.Console.WriteLine("miao-engine 1.0.0"); } }'
    Set-Content -LiteralPath $SecondSource -Value 'public class EngineSecond { public static void Main() { System.Console.WriteLine("miao-engine 1.0.1"); } }'
    & $Compiler /nologo /target:exe "/out:$First" $FirstSource
    if ($LASTEXITCODE -ne 0) { throw 'First fixture compilation failed.' }
    & $Compiler /nologo /target:exe "/out:$Second" $SecondSource
    if ($LASTEXITCODE -ne 0) { throw 'Second fixture compilation failed.' }
    $Install = Join-Path $Root 'installed'
    $Installer = Join-Path $PSScriptRoot 'install-engine.ps1'
    & $Installer -Binary $First -InstallDirectory $Install
    $Current = Join-Path $Install 'miao-engine.exe'
    $Previous = Join-Path $Install 'miao-engine.prev.exe'
    if ((& $Current --version) -ne 'miao-engine 1.0.0') { throw 'First install failed.' }
    & $Installer -Binary $Second -InstallDirectory $Install
    if ((& $Current --version) -ne 'miao-engine 1.0.1') { throw 'Upgrade failed.' }
    if ((& $Previous --version) -ne 'miao-engine 1.0.0') { throw 'Previous executable was not preserved.' }
    & $Installer -Rollback -InstallDirectory $Install
    if ((& $Current --version) -ne 'miao-engine 1.0.0') { throw 'Rollback failed.' }
    if ((& $Previous --version) -ne 'miao-engine 1.0.1') { throw 'Rollback lost the displaced version.' }
    $Hash = (Get-FileHash $Current).Hash
    $Failed = $false
    try { & $Installer -Binary (Join-Path $Root 'missing.exe') -InstallDirectory $Install } catch { $Failed = $true }
    if (!$Failed -or (Get-FileHash $Current).Hash -ne $Hash) { throw 'Invalid source changed the installation.' }
    Write-Output 'WINDOWS-ENGINE-INSTALL: PASS install/upgrade/rollback/invalid-source'
} finally {
    Remove-Item -LiteralPath $Root -Recurse -Force
}
