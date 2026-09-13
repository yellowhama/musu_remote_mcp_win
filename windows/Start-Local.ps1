[CmdletBinding()]
param(
    [string]$Config = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config\windows.json')
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 or newer is required for UTF-8-safe script execution.' }
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw "Configuration file not found: $Config" }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) { throw 'Dependencies are not installed. Run windows\Install.ps1 first.' }
& node (Join-Path $PSScriptRoot 'native-runtime.mjs') $Config
exit $LASTEXITCODE
