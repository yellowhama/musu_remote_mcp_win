[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$serviceRoot = Join-Path $PSScriptRoot 'service-split'
foreach ($name in @('MusuRemoteMcpGateway', 'MusuRemoteMcpWorker')) {
    $executable = Join-Path $serviceRoot "$name.exe"
    if (Test-Path -LiteralPath $executable -PathType Leaf) {
        & $executable stop
        if ($LASTEXITCODE -ne 0 -and (Get-Service -Name $name -ErrorAction SilentlyContinue)) { throw "$name stop failed (exit $LASTEXITCODE)" }
        & $executable uninstall
        if ($LASTEXITCODE -ne 0 -and (Get-Service -Name $name -ErrorAction SilentlyContinue)) { throw "$name uninstall failed (exit $LASTEXITCODE)" }
    }
    if ([Diagnostics.EventLog]::SourceExists($name)) { Remove-EventLog -Source $name }
}
Write-Host 'Split service registrations and Event Log sources removed. Configuration, state, broker key, backups, ACLs, and source were retained.'
