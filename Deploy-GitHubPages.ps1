param(
    [string]$Repository,
    [switch]$CreatePublicRepository,
    [switch]$AllowPublicData,
    [switch]$RestartService,
    [switch]$Interactive
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if ($Interactive) {
    Write-Host 'GitHub Pages setup for the public READ-ONLY website.'
    Write-Host 'Git, GitHub CLI and Node.js 24+ must be installed. Sign in with gh auth login first.'
    if (-not $Repository) {
        $Repository = (Read-Host 'GitHub OWNER/REPOSITORY (Enter to use the repository already configured in .env)').Trim()
    }
    if (-not $AllowPublicData) {
        $answer = Read-Host 'Publish exported friend aliases, game accounts and match data PUBLICLY? [y/N]'
        if ($answer -notmatch '^(?i:y|yes)$') { Write-Host 'Cancelled. Nothing was deployed.'; return }
        $AllowPublicData = $true
    }
    if (-not $CreatePublicRepository) {
        $answer = Read-Host 'If the repository does not exist, allow creation of a new PUBLIC repository? [y/N]'
        $CreatePublicRepository = $answer -match '^(?i:y|yes)$'
    }
    if (-not $RestartService) {
        $answer = Read-Host 'After success, restart the local service to load the publication settings? [y/N]'
        $RestartService = $answer -match '^(?i:y|yes)$'
    }
}
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$bundledNode = Join-Path $PSScriptRoot '.desktop/runtime/node.exe'
$nodePath = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } elseif ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Install Node.js 24 or later first: https://nodejs.org/' }
$arguments = @((Join-Path $PSScriptRoot 'scripts/deploy-github-pages.mjs'))
if ($Repository) { $arguments += @('--repository', $Repository) }
if ($CreatePublicRepository) { $arguments += '--create-public-repository' }
if ($AllowPublicData) { $arguments += '--allow-public-data' }
if ($RestartService) { $arguments += '--restart-service' }
Write-Host 'Starting deployment. Progress and errors will appear below; network operations can take a while.'
& $nodePath @arguments
if ($LASTEXITCODE -ne 0) { throw 'Deployment did not complete. Read the error above; existing data was not cleared.' }
