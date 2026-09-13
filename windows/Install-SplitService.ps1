[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string[]]$EditableRoot,
    [Parameter(Mandatory = $true)][string]$PublicUrl,
    [string]$DefaultCwd = '',
    [string]$StateRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'state'),
    [string]$BackupRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups'),
    [int]$Port = 39391,
    [int]$WorkerPort = 39392,
    [long]$MinFreeBytes = 10737418240,
    [switch]$TestFailAfterUpdate
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $projectRoot 'config\windows.json'
$previousConfig = if (Test-Path -LiteralPath $configFile -PathType Leaf) { [IO.File]::ReadAllBytes($configFile) } else { $null }
$installationComplete = $false
trap {
    if (-not $installationComplete) {
        if ($null -ne $previousConfig) { [IO.File]::WriteAllBytes($configFile, $previousConfig) }
        elseif (Test-Path -LiteralPath $configFile -PathType Leaf) { Remove-Item -LiteralPath $configFile -Force }
    }
    throw $_
}
$administrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $administrator) { throw 'Run PowerShell as Administrator to install split services.' }
if ($WorkerPort -eq $Port -or $WorkerPort -lt 1 -or $WorkerPort -gt 65535) { throw 'WorkerPort must be distinct and between 1 and 65535.' }
if (Get-Service -Name 'MusuRemoteMcp' -ErrorAction SilentlyContinue) {
    throw 'Remove the legacy MusuRemoteMcp service before installing the split gateway and worker.'
}

& (Join-Path $PSScriptRoot 'Install.ps1') -EditableRoot $EditableRoot -PublicUrl $PublicUrl -DefaultCwd $DefaultCwd -StateRoot $StateRoot -BackupRoot $BackupRoot -Port $Port -MinFreeBytes $MinFreeBytes
if ($LASTEXITCODE -ne 0) { throw "Base installation failed (exit $LASTEXITCODE)" }

$StateRoot = [IO.Path]::GetFullPath($StateRoot)
$workerStateRoot = "${StateRoot}-worker"
$brokerRoot = "${StateRoot}-broker"
$serviceRoot = Join-Path $PSScriptRoot 'service-split'
$gatewayExe = Join-Path $serviceRoot 'MusuRemoteMcpGateway.exe'
$workerExe = Join-Path $serviceRoot 'MusuRemoteMcpWorker.exe'
$gatewayXml = Join-Path $serviceRoot 'MusuRemoteMcpGateway.xml'
$workerXml = Join-Path $serviceRoot 'MusuRemoteMcpWorker.xml'
$winswUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$winswSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'
$node = (Get-Command node -ErrorAction Stop).Source
$icacls = (Get-Command icacls.exe -ErrorAction Stop).Source
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$configuration = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$configuration | Add-Member -NotePropertyName workerStateRoot -NotePropertyValue $workerStateRoot -Force
$configuration | Add-Member -NotePropertyName brokerRoot -NotePropertyValue $brokerRoot -Force
$configuration | Add-Member -NotePropertyName workerPort -NotePropertyValue $WorkerPort -Force
$configTemporary = "$configFile.$PID.split.tmp"
$configuration | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configTemporary -Encoding utf8NoBOM
Move-Item -LiteralPath $configTemporary -Destination $configFile -Force

function Invoke-CheckedNative {
    param([string]$Executable, [string]$FailureMessage, [string[]]$Arguments = @())
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$FailureMessage (exit $LASTEXITCODE)" }
}

function New-ServiceXml {
    param([string]$Id, [string]$DisplayName, [string]$Role, [string]$Executable, [string]$LogPath)
    $xml = [xml]'<service></service>'
    $serviceElement = $xml.DocumentElement
    foreach ($entry in @(
        @('id', $Id), @('name', $DisplayName), @('description', "Musu Remote MCP $Role"),
        @('executable', $node),
        @('arguments', ('"{0}" "{1}" "{2}"' -f (Join-Path $PSScriptRoot 'native-runtime.mjs'), $configFile, $Role)),
        @('workingdirectory', $projectRoot), @('startmode', 'Automatic'),
        @('delayedAutoStart', 'true'), @('stoptimeout', '20 sec'), @('logpath', $LogPath)
    )) {
        $element = $xml.CreateElement($entry[0]); $element.InnerText = $entry[1]; [void]$serviceElement.AppendChild($element)
    }
    $account = $xml.CreateElement('serviceaccount')
    $username = $xml.CreateElement('username'); $username.InnerText = "NT SERVICE\$Id"; [void]$account.AppendChild($username)
    [void]$serviceElement.AppendChild($account)
    $logging = $xml.CreateElement('log'); $logging.SetAttribute('mode', 'roll'); [void]$serviceElement.AppendChild($logging)
    $failure = $xml.CreateElement('onfailure'); $failure.SetAttribute('action', 'restart'); $failure.SetAttribute('delay', '10 sec'); [void]$serviceElement.AppendChild($failure)
    $xml.Save((Join-Path $serviceRoot "$Id.xml"))
}

$roots = @($EditableRoot | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
function Test-PathInside([string]$Root, [string]$Candidate) {
    $relative = [IO.Path]::GetRelativePath($Root, $Candidate)
    return $relative -eq '.' -or (-not $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar) -and $relative -ne '..' -and -not [IO.Path]::IsPathRooted($relative))
}
if ($roots | Where-Object { (Test-PathInside $_ $projectRoot) -or (Test-PathInside $projectRoot $_) }) {
    throw 'Split-service editable roots must not overlap the MCP installation source.'
}
New-Item -ItemType Directory -Force -Path $workerStateRoot, $brokerRoot, $serviceRoot, (Join-Path $StateRoot 'logs'), (Join-Path $workerStateRoot 'logs') | Out-Null
$internalKeyFile = Join-Path $brokerRoot 'internal-key.txt'
if (-not (Test-Path -LiteralPath $internalKeyFile -PathType Leaf)) {
    $key = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
    Set-Content -LiteralPath $internalKeyFile -Value $key -Encoding utf8NoBOM -NoNewline
}

foreach ($serviceExecutable in @($gatewayExe, $workerExe)) {
    if (-not (Test-Path -LiteralPath $serviceExecutable -PathType Leaf)) { Invoke-WebRequest -Uri $winswUrl -OutFile $serviceExecutable }
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $serviceExecutable).Hash
    if ($actualHash -ne $winswSha256) { throw "WinSW checksum mismatch: $serviceExecutable ($actualHash)" }
}

$previousXml = @{}
foreach ($xmlFile in @($gatewayXml, $workerXml)) {
    $previousXml[$xmlFile] = if (Test-Path -LiteralPath $xmlFile -PathType Leaf) { [IO.File]::ReadAllBytes($xmlFile) } else { $null }
}
$existingGateway = Get-Service -Name 'MusuRemoteMcpGateway' -ErrorAction SilentlyContinue
$existingWorker = Get-Service -Name 'MusuRemoteMcpWorker' -ErrorAction SilentlyContinue
$installed = [Collections.Generic.List[string]]::new()
$createdEventSources = [Collections.Generic.List[string]]::new()
$aclTargets = @($projectRoot, $StateRoot, $workerStateRoot, $brokerRoot, $BackupRoot) + $roots
$aclSnapshots = @{}
foreach ($target in ($aclTargets | Select-Object -Unique)) { $aclSnapshots[$target] = Get-Acl -LiteralPath $target }

try {
    New-ServiceXml -Id 'MusuRemoteMcpGateway' -DisplayName 'Musu Remote MCP Gateway' -Role 'gateway' -Executable $gatewayExe -LogPath (Join-Path $StateRoot 'logs')
    New-ServiceXml -Id 'MusuRemoteMcpWorker' -DisplayName 'Musu Remote MCP Worker' -Role 'worker' -Executable $workerExe -LogPath (Join-Path $workerStateRoot 'logs')
    foreach ($source in @('MusuRemoteMcpGateway', 'MusuRemoteMcpWorker')) {
        if (-not [Diagnostics.EventLog]::SourceExists($source)) {
            New-EventLog -LogName Application -Source $source
            $createdEventSources.Add($source)
        }
    }
    foreach ($service in @(@($gatewayExe, $existingGateway), @($workerExe, $existingWorker))) {
        if ($service[1]) {
            Invoke-CheckedNative $service[0] 'Service stop failed' @('stop')
            # WinSW v2 reloads its adjacent XML when the wrapper process starts.
        } else {
            Invoke-CheckedNative $service[0] 'Service installation failed' @('install')
            $installed.Add($service[0])
        }
    }

    Invoke-CheckedNative $icacls 'Failed to protect gateway state' @($StateRoot, '/inheritance:r', '/grant:r', "${currentIdentity}:(OI)(CI)F", 'SYSTEM:(OI)(CI)F', 'NT SERVICE\MusuRemoteMcpGateway:(OI)(CI)M')
    Invoke-CheckedNative $icacls 'Failed to deny worker access to OAuth state' @($StateRoot, '/deny', 'NT SERVICE\MusuRemoteMcpWorker:(OI)(CI)F')
    Invoke-CheckedNative $icacls 'Failed to protect worker state' @($workerStateRoot, '/inheritance:r', '/grant:r', "${currentIdentity}:(OI)(CI)F", 'SYSTEM:(OI)(CI)F', 'NT SERVICE\MusuRemoteMcpWorker:(OI)(CI)M')
    Invoke-CheckedNative $icacls 'Failed to deny gateway access to worker state' @($workerStateRoot, '/deny', 'NT SERVICE\MusuRemoteMcpGateway:(OI)(CI)F')
    Invoke-CheckedNative $icacls 'Failed to protect broker key' @($brokerRoot, '/inheritance:r', '/grant:r', "${currentIdentity}:(OI)(CI)F", 'SYSTEM:(OI)(CI)F', 'NT SERVICE\MusuRemoteMcpGateway:(OI)(CI)R', 'NT SERVICE\MusuRemoteMcpWorker:(OI)(CI)R')
    Invoke-CheckedNative $icacls 'Failed to grant application read access' @($projectRoot, '/grant', 'NT SERVICE\MusuRemoteMcpGateway:(OI)(CI)RX', 'NT SERVICE\MusuRemoteMcpWorker:(OI)(CI)RX')
    foreach ($root in $roots) {
        Invoke-CheckedNative $icacls "Failed to grant worker access to $root" @($root, '/grant', 'NT SERVICE\MusuRemoteMcpWorker:(OI)(CI)M')
        Invoke-CheckedNative $icacls "Failed to deny gateway access to $root" @($root, '/deny', 'NT SERVICE\MusuRemoteMcpGateway:(OI)(CI)F')
    }
    Invoke-CheckedNative $icacls 'Failed to grant worker backup access' @($BackupRoot, '/grant', 'NT SERVICE\MusuRemoteMcpWorker:(OI)(CI)M')
    Invoke-CheckedNative $icacls 'Failed to deny gateway backup access' @($BackupRoot, '/deny', 'NT SERVICE\MusuRemoteMcpGateway:(OI)(CI)F')

    if ($TestFailAfterUpdate) { throw 'Injected upgrade failure after service XML and ACL update' }

    Invoke-CheckedNative $workerExe 'Worker start failed' @('start')
    Invoke-CheckedNative $gatewayExe 'Gateway start failed' @('start')
    $healthy = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            $gatewayHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
            $workerHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$WorkerPort/health" -TimeoutSec 2
            if ($gatewayHealth.status -eq 'ok' -and $workerHealth.status -eq 'ok') { $healthy = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $healthy) { throw 'Gateway and worker did not become healthy.' }
} catch {
    $failure = $_
    foreach ($serviceExecutable in @($gatewayExe, $workerExe)) { & $serviceExecutable stop 2>$null }
    foreach ($serviceExecutable in $installed) { & $serviceExecutable uninstall 2>$null }
    foreach ($xmlFile in $previousXml.Keys) {
        if ($null -ne $previousXml[$xmlFile]) { [IO.File]::WriteAllBytes($xmlFile, $previousXml[$xmlFile]) }
    }
    foreach ($target in $aclSnapshots.Keys) { try { Set-Acl -LiteralPath $target -AclObject $aclSnapshots[$target] } catch { Write-Warning "ACL rollback failed: $target" } }
    foreach ($source in $createdEventSources) { try { Remove-EventLog -Source $source } catch { Write-Warning "Event source rollback failed: $source" } }
    if ($existingWorker) { & $workerExe start 2>$null }
    if ($existingGateway) { & $gatewayExe start 2>$null }
    throw $failure
}

$installationComplete = $true
Write-Host "Gateway service: MusuRemoteMcpGateway (NT SERVICE\MusuRemoteMcpGateway)"
Write-Host "Worker service:  MusuRemoteMcpWorker (NT SERVICE\MusuRemoteMcpWorker)"
Write-Host "Approval key:   $(Join-Path $StateRoot 'approval-key.txt')"
Write-Host "Metrics key:    $(Join-Path $StateRoot 'metrics-key.txt')"
