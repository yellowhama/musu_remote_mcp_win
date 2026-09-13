[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$serviceExecutable = Join-Path $PSScriptRoot 'service\MusuRemoteMcp.exe'
if (-not (Test-Path -LiteralPath $serviceExecutable -PathType Leaf)) { throw 'WinSW service executable was not found.' }
& $serviceExecutable stop
& $serviceExecutable uninstall
Write-Host 'Service registration removed. Configuration, state, backups, and source were retained.'
