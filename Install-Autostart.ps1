$ErrorActionPreference = 'Stop'
$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDirectory 'BrokenArrowCourt.lnk'
$shellObject = New-Object -ComObject WScript.Shell
$shortcut = $shellObject.CreateShortcut($shortcutPath)
if ((Test-Path -LiteralPath $shortcutPath) -and -not $shortcut.Arguments.Contains((Join-Path $PSScriptRoot 'Start.ps1'))) { throw 'An autostart shortcut for another checkout already exists; it was not overwritten.' }
$shortcut.TargetPath = (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe')
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'Start.ps1') + '" -NoBrowser'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.Description = 'Start the private Broken Arrow match archive after Windows sign-in.'
$shortcut.Save()
Write-Output ('Autostart installed: ' + $shortcutPath)
