$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node setup-state.mjs
if ($LASTEXITCODE -ne 0) { throw 'Authentication setup failed' }
docker compose up -d tunnel
if ($LASTEXITCODE -ne 0) { throw 'Tunnel failed to start' }
$ready = $false
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    $urlResult = node set-public-url.mjs --json 2>$null
    if ($LASTEXITCODE -eq 0) { $tunnelState = $urlResult | ConvertFrom-Json; $ready = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $ready) { throw 'No tunnel URL. Inspect docker compose logs tunnel.' }
$priorId = docker ps -q --filter 'name=^remote-dev-mcp$'
docker compose up -d mcp
if ($LASTEXITCODE -ne 0) { throw 'MCP failed to start' }
$currentId = docker ps -q --filter 'name=^remote-dev-mcp$'
if ($tunnelState.changed -and $priorId -and $priorId -eq $currentId) {
    docker compose restart mcp
    if ($LASTEXITCODE -ne 0) { throw 'MCP failed to reload the public URL' }
}
Write-Output ('MCP URL: ' + $tunnelState.publicUrl + '/mcp')
Write-Output 'Use OAuth in ChatGPT. Approval key: state/approval-key.txt (local file).'
