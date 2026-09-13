[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Begin', 'End', 'Status')][string]$Phase,
    [string]$GatewayUrl = 'http://127.0.0.1:39391',
    [string]$StateRoot = '',
    [string]$SessionPath = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $projectRoot 'config\windows.json'
if (-not $StateRoot) {
    if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) { throw "Configuration not found: $configFile" }
    $StateRoot = (Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json).stateRoot
}
$StateRoot = [IO.Path]::GetFullPath($StateRoot)
$evidenceRoot = Join-Path $StateRoot 'acceptance\chatgpt'
if (-not $SessionPath) { $SessionPath = Join-Path $evidenceRoot 'compatibility-session.json' }
$resultPath = Join-Path $evidenceRoot 'compatibility-result.json'
$metricsKeyFile = Join-Path $StateRoot 'metrics-key.txt'

function Write-JsonFile {
    param([string]$Path, [object]$Value)
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = "$Path.$PID.tmp"
    $json = $Value | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Read-MetricValue {
    param([string]$Text, [string]$MetricPattern)
    $match = [regex]::Match($Text, "(?m)^$MetricPattern\s+([0-9]+(?:\.[0-9]+)?)$")
    if (-not $match.Success) { return 0 }
    return [double]::Parse($match.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
}

function Get-MetricsSnapshot {
    if (-not (Test-Path -LiteralPath $metricsKeyFile -PathType Leaf)) {
        throw "Metrics key not found: $metricsKeyFile. Re-run the current installer before capture."
    }
    $metricsKey = [IO.File]::ReadAllText($metricsKeyFile).Trim()
    if ($metricsKey.Length -lt 32) { throw 'Metrics key is invalid.' }
    $headers = @{ Authorization = "Bearer $metricsKey" }
    $response = Invoke-WebRequest -Uri ($GatewayUrl.TrimEnd('/') + '/metrics') -Headers $headers -TimeoutSec 10
    $text = $response.Content
    return [ordered]@{
        capturedAtUtc = [DateTime]::UtcNow.ToString('o')
        cimdSuccess = Read-MetricValue $text 'musu_oauth_client_resolution_total\{method="cimd",outcome="success"\}'
        cimdFailure = Read-MetricValue $text 'musu_oauth_client_resolution_total\{method="cimd",outcome="failure"\}'
        dcrSuccess = Read-MetricValue $text 'musu_oauth_client_resolution_total\{method="dcr",outcome="success"\}'
        dcrFailure = Read-MetricValue $text 'musu_oauth_client_resolution_total\{method="dcr",outcome="failure"\}'
        mcp2xx = Read-MetricValue $text 'musu_http_requests_total\{route="mcp",status_class="2xx"\}'
        oauth2xx = Read-MetricValue $text 'musu_http_requests_total\{route="oauth",status_class="2xx"\}'
    }
}

if ($Phase -eq 'Status') {
    if (Test-Path -LiteralPath $resultPath -PathType Leaf) { Get-Content -LiteralPath $resultPath -Raw }
    elseif (Test-Path -LiteralPath $SessionPath -PathType Leaf) { Get-Content -LiteralPath $SessionPath -Raw }
    else { throw 'No ChatGPT compatibility capture exists.' }
    exit 0
}

if ($Phase -eq 'Begin') {
    if ((Test-Path -LiteralPath $SessionPath -PathType Leaf) -and -not $Force) {
        throw "Capture already exists: $SessionPath. Use -Force to start a new compatibility window."
    }
    $session = [ordered]@{
        schemaVersion = 1
        gatewayUrl = $GatewayUrl.TrimEnd('/')
        baseline = Get-MetricsSnapshot
        instructions = 'Create a fresh ChatGPT MCP app, complete OAuth approval, scan tools, and make at least one MCP tool call before running End.'
    }
    Write-JsonFile $SessionPath $session
    Write-Host "Baseline saved: $SessionPath"
    Write-Host $session.instructions
    exit 0
}

if (-not (Test-Path -LiteralPath $SessionPath -PathType Leaf)) { throw "Capture baseline not found: $SessionPath" }
$session = Get-Content -LiteralPath $SessionPath -Raw | ConvertFrom-Json
if ($session.gatewayUrl -ne $GatewayUrl.TrimEnd('/')) { throw 'GatewayUrl differs from the baseline capture.' }
$final = Get-MetricsSnapshot
$delta = [ordered]@{}
foreach ($name in 'cimdSuccess', 'cimdFailure', 'dcrSuccess', 'dcrFailure', 'mcp2xx', 'oauth2xx') {
    $delta[$name] = [double]$final[$name] - [double]$session.baseline.$name
}
$method = if ($delta.cimdSuccess -gt 0 -and $delta.dcrSuccess -eq 0) { 'cimd' }
    elseif ($delta.dcrSuccess -gt 0 -and $delta.cimdSuccess -eq 0) { 'dcr' }
    elseif ($delta.dcrSuccess -gt 0 -and $delta.cimdSuccess -gt 0) { 'mixed' }
    else { 'none' }
$compatible = $method -ne 'none' -and $delta.mcp2xx -gt 0
$result = [ordered]@{
    schemaVersion = 1
    passed = $compatible
    selectedMethod = $method
    baseline = $session.baseline
    final = $final
    delta = $delta
    interpretation = if ($compatible) { "Fresh ChatGPT connection resolved through $method and completed an MCP request." } else { 'No complete fresh ChatGPT OAuth plus MCP flow was observed in this window.' }
}
Write-JsonFile $resultPath $result
Write-Host "Result saved: $resultPath"
$result | ConvertTo-Json -Depth 8
if (-not $compatible) { exit 1 }
