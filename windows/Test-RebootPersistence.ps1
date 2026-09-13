[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Prepare', 'Verify', 'Status')][string]$Phase,
    [string]$EvidenceDirectory = '',
    [string]$GatewayUrl = 'http://127.0.0.1:39391',
    [string]$WorkerUrl = 'http://127.0.0.1:39392',
    [int]$HealthTimeoutSeconds = 180,
    [switch]$RestartComputer
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $projectRoot 'config\windows.json'
if (-not $EvidenceDirectory) {
    if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) { throw "Configuration not found: $configFile" }
    $stateRoot = (Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json).stateRoot
    $EvidenceDirectory = Join-Path $stateRoot 'acceptance\reboot'
}
$EvidenceDirectory = [IO.Path]::GetFullPath($EvidenceDirectory)
$beforePath = Join-Path $EvidenceDirectory 'reboot-before.json'
$resultPath = Join-Path $EvidenceDirectory 'reboot-result.json'
$taskName = 'MusuRemoteMcpRebootAcceptance'

function Write-JsonFile {
    param([string]$Path, [object]$Value)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $temporary = "$Path.$PID.tmp"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-BootTimeUtc {
    return (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
}

function Get-ServiceEvidence {
    $values = foreach ($name in 'MusuRemoteMcpGateway', 'MusuRemoteMcpWorker') {
        $service = Get-Service -Name $name -ErrorAction Stop
        $cim = Get-CimInstance Win32_Service -Filter "Name='$name'"
        [ordered]@{ name = $name; status = [string]$service.Status; startMode = $cim.StartMode; processId = $cim.ProcessId }
    }
    return @($values)
}

function Test-Health {
    $deadline = [DateTime]::UtcNow.AddSeconds($HealthTimeoutSeconds)
    do {
        try {
            $gateway = Invoke-RestMethod -Uri ($GatewayUrl.TrimEnd('/') + '/health') -TimeoutSec 3
            $worker = Invoke-RestMethod -Uri ($WorkerUrl.TrimEnd('/') + '/health') -TimeoutSec 3
            if ($gateway.status -eq 'ok' -and $worker.status -eq 'ok') { return $true }
        } catch {}
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Test-DenyAcl {
    param([string]$Path, [string]$IdentitySuffix)
    return [bool]((Get-Acl -LiteralPath $Path).Access | Where-Object {
        $_.IdentityReference.Value.EndsWith($IdentitySuffix, [StringComparison]::OrdinalIgnoreCase) -and
        $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny
    })
}

if ($Phase -eq 'Status') {
    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) { throw "Reboot result not found: $resultPath" }
    Get-Content -LiteralPath $resultPath -Raw
    exit 0
}

$administrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $administrator) { throw 'Run PowerShell as Administrator for reboot acceptance.' }

if ($Phase -eq 'Prepare') {
    if (-not (Test-Health)) { throw 'Gateway and worker must be healthy before preparing reboot acceptance.' }
    $services = Get-ServiceEvidence
    if ($services.Where({ $_.status -ne 'Running' -or $_.startMode -ne 'Auto' }).Count -gt 0) {
        throw 'Both split services must be running with Automatic startup.'
    }
    $configuration = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    $before = [ordered]@{
        schemaVersion = 1
        preparedAtUtc = [DateTime]::UtcNow.ToString('o')
        bootTimeUtc = (Get-BootTimeUtc).ToString('o')
        gatewayUrl = $GatewayUrl.TrimEnd('/')
        workerUrl = $WorkerUrl.TrimEnd('/')
        services = $services
        editableRoots = @($configuration.editableRoots)
        stateRoot = $configuration.stateRoot
    }
    Write-JsonFile $beforePath $before
    $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Phase Verify -EvidenceDirectory "{1}" -GatewayUrl "{2}" -WorkerUrl "{3}" -HealthTimeoutSeconds {4}' -f $PSCommandPath, $EvidenceDirectory, $GatewayUrl, $WorkerUrl, $HealthTimeoutSeconds
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host "Reboot verifier prepared. Evidence: $beforePath"
    if ($RestartComputer) { Restart-Computer -Force }
    else { Write-Host 'Reboot the VM, then inspect the result with -Phase Status.' }
    exit 0
}

$errors = [Collections.Generic.List[string]]::new()
try {
    if (-not (Test-Path -LiteralPath $beforePath -PathType Leaf)) { throw "Pre-reboot evidence not found: $beforePath" }
    $before = Get-Content -LiteralPath $beforePath -Raw | ConvertFrom-Json
    $currentBoot = Get-BootTimeUtc
    if ($currentBoot -le [DateTime]::Parse($before.bootTimeUtc).ToUniversalTime()) { $errors.Add('Windows boot time did not advance.') }
    $healthy = Test-Health
    if (-not $healthy) { $errors.Add('Gateway or worker health did not recover before timeout.') }
    $services = Get-ServiceEvidence
    if ($services.Where({ $_.status -ne 'Running' -or $_.startMode -ne 'Auto' }).Count -gt 0) { $errors.Add('A split service is not running with Automatic startup.') }
    foreach ($root in @($before.editableRoots)) {
        if (-not (Test-DenyAcl $root 'MusuRemoteMcpGateway')) { $errors.Add("Gateway deny ACL is missing: $root") }
    }
    if (-not (Test-DenyAcl $before.stateRoot 'MusuRemoteMcpWorker')) { $errors.Add('Worker deny ACL is missing on gateway state.') }
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = @('MusuRemoteMcpGateway', 'MusuRemoteMcpWorker'); StartTime = $currentBoot } -ErrorAction SilentlyContinue | Select-Object -First 40 TimeCreated, Id, LevelDisplayName, ProviderName)
    if ($events.Count -lt 2) { $errors.Add('Gateway and worker startup lifecycle events were not both observed.') }
    $result = [ordered]@{
        schemaVersion = 1
        passed = $errors.Count -eq 0
        verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
        previousBootTimeUtc = $before.bootTimeUtc
        currentBootTimeUtc = $currentBoot.ToString('o')
        healthRecovered = $healthy
        services = $services
        errors = @($errors)
        lifecycleEvents = $events
    }
    Write-JsonFile $resultPath $result
    if (-not $result.passed) { throw ($errors -join ' ') }
    Write-Host "Reboot persistence passed: $resultPath"
} finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
