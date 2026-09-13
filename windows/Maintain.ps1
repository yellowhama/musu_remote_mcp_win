[CmdletBinding()]
param(
    [string]$Config = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config\windows.json'),
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw "Configuration file not found: $Config" }
$configuration = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
if ($Apply) {
    $service = Get-Service -Name 'MusuRemoteMcp' -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped') { throw 'Stop the MusuRemoteMcp service before applying retention.' }
    $listener = Get-NetTCPConnection -LocalPort $configuration.port -State Listen -ErrorAction SilentlyContinue
    if ($listener) { throw "Port $($configuration.port) is listening. Stop the foreground MCP server before applying retention." }
}
$arguments = @((Join-Path $projectRoot 'adapter\dist\maintenance.mjs'), $Config)
if ($Apply) { $arguments += '--apply' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "Retention command failed (exit $LASTEXITCODE)" }
