[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$serviceExecutable = Join-Path $PSScriptRoot 'service\MusuRemoteMcp.exe'
if (-not (Test-Path -LiteralPath $serviceExecutable -PathType Leaf)) { throw 'WinSW service executable was not found.' }
& $serviceExecutable stop
if ($LASTEXITCODE -ne 0) { throw "Windows service stop failed (exit $LASTEXITCODE)" }
& $serviceExecutable uninstall
if ($LASTEXITCODE -ne 0) { throw "Windows service uninstall failed (exit $LASTEXITCODE)" }
Write-Host 'Service registration removed. Configuration, state, backups, and source were retained.'
