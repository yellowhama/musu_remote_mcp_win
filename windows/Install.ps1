[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$EditableRoot,
    [Parameter(Mandatory = $true)]
    [string]$PublicUrl,
    [string]$DefaultCwd = '',
    [string]$StateRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'state'),
    [string]$BackupRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups'),
    [int]$Port = 39391,
    [int]$ManifestDays = 30,
    [int]$JobDays = 30,
    [int]$ArchiveDays = 180,
    [int]$LogDays = 14,
    [long]$MinFreeBytes = 10737418240,
    [switch]$Service
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configDirectory = Join-Path $projectRoot 'config'
$configFile = Join-Path $configDirectory 'windows.json'
$serviceDirectory = Join-Path $PSScriptRoot 'service'
$serviceExecutable = Join-Path $serviceDirectory 'MusuRemoteMcp.exe'
$serviceConfig = Join-Path $serviceDirectory 'MusuRemoteMcp.xml'
$winswUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$winswSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'

if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 or newer is required.' }
$node = (Get-Command node -ErrorAction Stop).Source
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$npm = (Get-Command npm -ErrorAction Stop).Source
$icacls = (Get-Command icacls.exe -ErrorAction Stop).Source
function Invoke-CheckedNative {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$FailureMessage,
        [string[]]$Arguments = @()
    )
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$FailureMessage (exit $LASTEXITCODE)" }
}
$nodeVersion = [version]((& $node --version).TrimStart('v'))
if ($nodeVersion -lt [version]'22.13.0') { throw 'Node.js 22.13.0 or newer is required.' }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port must be between 1 and 65535.' }
foreach ($retentionDays in @($ManifestDays, $JobDays, $ArchiveDays, $LogDays)) {
    if ($retentionDays -lt 1 -or $retentionDays -gt 3650) { throw 'Retention days must be between 1 and 3650.' }
}
if ($MinFreeBytes -lt 0 -or $MinFreeBytes -gt 9007199254740991) { throw 'MinFreeBytes must be between 0 and 9007199254740991.' }
$uri = [Uri]$PublicUrl
if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback)) { throw 'PublicUrl must use HTTPS, except for a loopback-only installation.' }

$roots = @($EditableRoot | ForEach-Object {
    if (-not (Test-Path -LiteralPath $_ -PathType Container)) { throw "Editable root does not exist: $_" }
    (Resolve-Path -LiteralPath $_).Path
})
if (-not $DefaultCwd) { $DefaultCwd = $roots[0] }
$DefaultCwd = (Resolve-Path -LiteralPath $DefaultCwd).Path
$StateRoot = [IO.Path]::GetFullPath($StateRoot)
$BackupRoot = [IO.Path]::GetFullPath($BackupRoot)
function Test-PathInside([string]$Root, [string]$Candidate) {
    $relative = [IO.Path]::GetRelativePath($Root, $Candidate)
    return $relative -eq '.' -or (-not $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar) -and $relative -ne '..' -and -not [IO.Path]::IsPathRooted($relative))
}
if (-not ($roots | Where-Object { Test-PathInside $_ $DefaultCwd })) { throw 'DefaultCwd must be inside an editable root.' }
foreach ($protectedRoot in @($StateRoot, $BackupRoot)) {
    if ($roots | Where-Object { (Test-PathInside $_ $protectedRoot) -or (Test-PathInside $protectedRoot $_) }) {
        throw 'StateRoot and BackupRoot must not overlap editable roots.'
    }
}
if ((Test-PathInside $StateRoot $BackupRoot) -or (Test-PathInside $BackupRoot $StateRoot)) { throw 'StateRoot and BackupRoot must not overlap.' }
New-Item -ItemType Directory -Force -Path $configDirectory, $StateRoot, $BackupRoot | Out-Null

Write-Host 'Installing exact npm dependencies and building TypeScript...'
Invoke-CheckedNative -Executable $npm -FailureMessage 'npm ci failed' -Arguments @('ci', '--prefix', $projectRoot)
Invoke-CheckedNative -Executable $npm -FailureMessage 'TypeScript build failed' -Arguments @('run', 'build', '--prefix', $projectRoot)

$configuration = [ordered]@{
    version = 1
    publicUrl = $uri.AbsoluteUri.TrimEnd('/')
    editableRoots = $roots
    defaultCwd = $DefaultCwd
    stateRoot = $StateRoot
    backupRoot = $BackupRoot
    port = $Port
    defaultShell = $pwsh
    retention = [ordered]@{
        manifestDays = $ManifestDays
        jobDays = $JobDays
        archiveDays = $ArchiveDays
        logDays = $LogDays
        minFreeBytes = $MinFreeBytes
    }
}
$previousConfig = if (Test-Path -LiteralPath $configFile -PathType Leaf) { [IO.File]::ReadAllBytes($configFile) } else { $null }
$previousServiceConfig = if (Test-Path -LiteralPath $serviceConfig -PathType Leaf) { [IO.File]::ReadAllBytes($serviceConfig) } else { $null }
$existingService = if ($Service) { Get-Service -Name 'MusuRemoteMcp' -ErrorAction SilentlyContinue } else { $null }
$serviceWasRunning = $existingService -and $existingService.Status -eq 'Running'
$installedNewService = $false
$aclSnapshots = @{}
$aclTargets = @($StateRoot)
if ($Service) { $aclTargets += @($projectRoot) + $roots + @($BackupRoot) }
foreach ($target in ($aclTargets | Select-Object -Unique)) { $aclSnapshots[$target] = Get-Acl -LiteralPath $target }

try {
    $configTemporary = "$configFile.$PID.tmp"
    $configuration | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configTemporary -Encoding utf8NoBOM
    Move-Item -LiteralPath $configTemporary -Destination $configFile -Force
    $env:MCP_STATE_ROOT = $StateRoot
    Invoke-CheckedNative -Executable $node -FailureMessage 'Authentication state initialization failed' -Arguments @((Join-Path $projectRoot 'setup-state.mjs'))

    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    Invoke-CheckedNative -Executable $icacls -FailureMessage 'Failed to protect the state directory ACL' -Arguments @($StateRoot, '/inheritance:r', '/grant:r', "${currentIdentity}:(OI)(CI)F", 'SYSTEM:(OI)(CI)F')

    if ($Service) {
    $administrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $administrator) { throw 'Run PowerShell as Administrator when using -Service.' }
    if ($node.StartsWith($env:USERPROFILE, [StringComparison]::OrdinalIgnoreCase) -or $pwsh.StartsWith($env:USERPROFILE, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Service mode requires system-wide Node.js and PowerShell 7 installations outside the user profile.'
    }
    New-Item -ItemType Directory -Force -Path $serviceDirectory, (Join-Path $serviceDirectory 'logs') | Out-Null
    if (-not (Test-Path -LiteralPath $serviceExecutable)) {
        Invoke-WebRequest -Uri $winswUrl -OutFile $serviceExecutable
    }
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $serviceExecutable).Hash
    if ($actualHash -ne $winswSha256) { throw "WinSW checksum mismatch: $actualHash" }
    $xml = [xml]'<service></service>'
    foreach ($entry in @(
        @('id', 'MusuRemoteMcp'),
        @('name', 'Musu Remote MCP'),
        @('description', 'Windows-native remote development MCP server'),
        @('executable', $node),
        @('arguments', ('"{0}" "{1}"' -f (Join-Path $PSScriptRoot 'native-runtime.mjs'), $configFile)),
        @('workingdirectory', $projectRoot),
        @('startmode', 'Automatic'),
        @('delayedAutoStart', 'true'),
        @('stoptimeout', '15 sec'),
        @('logpath', (Join-Path $serviceDirectory 'logs'))
    )) {
        $nodeElement = $xml.CreateElement($entry[0]); $nodeElement.InnerText = $entry[1]; [void]$xml.service.AppendChild($nodeElement)
    }
    $account = $xml.CreateElement('serviceaccount')
    $username = $xml.CreateElement('username'); $username.InnerText = 'NT AUTHORITY\LocalService'; [void]$account.AppendChild($username)
    [void]$xml.service.AppendChild($account)
    $logging = $xml.CreateElement('log'); $logging.SetAttribute('mode', 'roll'); [void]$xml.service.AppendChild($logging)
    $failure = $xml.CreateElement('onfailure'); $failure.SetAttribute('action', 'restart'); $failure.SetAttribute('delay', '10 sec'); [void]$xml.service.AppendChild($failure)
    $xml.Save($serviceConfig)
    Invoke-CheckedNative -Executable $icacls -FailureMessage 'Failed to grant service read access to the application' -Arguments @($projectRoot, '/grant', 'LOCAL SERVICE:(OI)(CI)RX')
    foreach ($root in $roots) {
        Invoke-CheckedNative -Executable $icacls -FailureMessage "Failed to grant service modify access to $root" -Arguments @($root, '/grant', 'LOCAL SERVICE:(OI)(CI)M')
    }
    Invoke-CheckedNative -Executable $icacls -FailureMessage 'Failed to grant service access to state' -Arguments @($StateRoot, '/grant', 'LOCAL SERVICE:(OI)(CI)M')
    Invoke-CheckedNative -Executable $icacls -FailureMessage 'Failed to grant service access to backups' -Arguments @($BackupRoot, '/grant', 'LOCAL SERVICE:(OI)(CI)M')
    if ($existingService) {
        Invoke-CheckedNative -Executable $serviceExecutable -FailureMessage 'Windows service stop failed' -Arguments @('stop')
        Invoke-CheckedNative -Executable $serviceExecutable -FailureMessage 'Windows service refresh failed' -Arguments @('refresh')
    } else {
        Invoke-CheckedNative -Executable $serviceExecutable -FailureMessage 'Windows service installation failed' -Arguments @('install')
        $installedNewService = $true
    }
    Invoke-CheckedNative -Executable $serviceExecutable -FailureMessage 'Windows service start failed' -Arguments @('start')
    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
            if ($health.status -eq 'ok') { $healthy = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $healthy) { throw 'Windows service did not become healthy within 30 attempts' }
    }
} catch {
    $failure = $_
    if ($configTemporary -and (Test-Path -LiteralPath $configTemporary -PathType Leaf)) {
        Remove-Item -LiteralPath $configTemporary -Force
    }
    if ($Service -and (Test-Path -LiteralPath $serviceExecutable -PathType Leaf)) {
        if ($installedNewService) {
            & $serviceExecutable stop 2>$null
            & $serviceExecutable uninstall 2>$null
        } elseif ($existingService) {
            if ($null -ne $previousServiceConfig) { [IO.File]::WriteAllBytes($serviceConfig, $previousServiceConfig) }
            & $serviceExecutable refresh 2>$null
            if ($serviceWasRunning) { & $serviceExecutable start 2>$null }
        }
    }
    if ($null -ne $previousConfig) { [IO.File]::WriteAllBytes($configFile, $previousConfig) }
    elseif (Test-Path -LiteralPath $configFile -PathType Leaf) { Remove-Item -LiteralPath $configFile -Force }
    foreach ($target in $aclSnapshots.Keys) {
        try { Set-Acl -LiteralPath $target -AclObject $aclSnapshots[$target] } catch { Write-Warning "Failed to restore ACL for ${target}: $($_.Exception.Message)" }
    }
    throw $failure
}

Write-Host "Configuration: $configFile"
Write-Host "Approval key:  $(Join-Path $StateRoot 'approval-key.txt')"
Write-Host 'The approval key content was not printed.'
