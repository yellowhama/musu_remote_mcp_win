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
$nodeMajor = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required. Node.js 24 LTS is recommended.' }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port must be between 1 and 65535.' }
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
& npm ci --prefix (Join-Path $projectRoot 'vendor')
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
& npm run build --prefix (Join-Path $projectRoot 'vendor')
if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed' }
$rootModules = Join-Path $projectRoot 'node_modules'
$vendorModules = Join-Path $projectRoot 'vendor\node_modules'
if (-not (Test-Path -LiteralPath $rootModules)) {
    New-Item -ItemType Junction -Path $rootModules -Target $vendorModules | Out-Null
} else {
    $modulesItem = Get-Item -LiteralPath $rootModules
    if ($modulesItem.LinkType -ne 'Junction' -or [IO.Path]::GetFullPath([string]$modulesItem.Target) -ne [IO.Path]::GetFullPath($vendorModules)) {
        throw "Existing node_modules is not the expected vendor junction: $rootModules"
    }
}

$configuration = [ordered]@{
    version = 1
    publicUrl = $uri.AbsoluteUri.TrimEnd('/')
    editableRoots = $roots
    defaultCwd = $DefaultCwd
    stateRoot = $StateRoot
    backupRoot = $BackupRoot
    port = $Port
    defaultShell = $pwsh
}
$configuration | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configFile -Encoding utf8NoBOM
$env:MCP_STATE_ROOT = $StateRoot
& $node (Join-Path $projectRoot 'setup-state.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Authentication state initialization failed' }

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $StateRoot /inheritance:r /grant:r "${currentIdentity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to protect the state directory ACL' }

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
    & icacls.exe $projectRoot /grant 'LOCAL SERVICE:(OI)(CI)RX' | Out-Null
    foreach ($root in $roots) { & icacls.exe $root /grant 'LOCAL SERVICE:(OI)(CI)M' | Out-Null }
    & icacls.exe $StateRoot /grant 'LOCAL SERVICE:(OI)(CI)M' | Out-Null
    & icacls.exe $BackupRoot /grant 'LOCAL SERVICE:(OI)(CI)M' | Out-Null
    $existingService = Get-Service -Name 'MusuRemoteMcp' -ErrorAction SilentlyContinue
    if ($existingService) {
        & $serviceExecutable stop
        & $serviceExecutable refresh
        if ($LASTEXITCODE -ne 0) { throw 'Windows service refresh failed' }
    } else {
        & $serviceExecutable install
        if ($LASTEXITCODE -ne 0) { throw 'Windows service installation failed' }
    }
    & $serviceExecutable start
    if ($LASTEXITCODE -ne 0) { throw 'Windows service start failed' }
}

Write-Host "Configuration: $configFile"
Write-Host "Approval key:  $(Join-Path $StateRoot 'approval-key.txt')"
Write-Host 'The approval key content was not printed.'
