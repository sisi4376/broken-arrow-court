$ErrorActionPreference = 'Stop'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'BrokenArrowCourt.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    $shellObject = New-Object -ComObject WScript.Shell
    $shortcut = $shellObject.CreateShortcut($shortcutPath)
    if (-not $shortcut.Arguments.Contains((Join-Path $PSScriptRoot 'Start.ps1'))) { throw 'Shortcut belongs to another checkout; it was not removed.' }
    Remove-Item -LiteralPath $shortcutPath
}
Write-Output 'Autostart removed. Existing data and running service are unchanged.'
