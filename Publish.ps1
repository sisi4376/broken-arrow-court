$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$bundledNode = Join-Path $PSScriptRoot '.desktop/runtime/node.exe'
$nodePath = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } elseif ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js 24 or later is required.' }
Write-Host 'Publishing the latest read-only snapshot. Progress and errors will appear below.'
& $nodePath (Join-Path $PSScriptRoot 'scripts/publish-site.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Publication failed. Read the error above; existing data was not cleared.' }
