$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$service = Get-Service -Name 'MusuRemoteMcp' -ErrorAction SilentlyContinue
if ($service) {
    Stop-Service -Name 'MusuRemoteMcp'
    Write-Host 'MusuRemoteMcp service stopped.'
} else {
    Write-Host 'No MusuRemoteMcp Windows service is installed. Stop a foreground server with Ctrl+C.'
}
