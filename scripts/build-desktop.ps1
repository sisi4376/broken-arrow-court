param([string]$NodePath, [string]$Output = 'BrokenArrowCourt.exe')
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $root
if (-not $NodePath) {
    $command = Get-Command node -ErrorAction SilentlyContinue
    $NodePath = if ($command) { $command.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
}
if (-not (Test-Path -LiteralPath $NodePath)) { throw 'Node.js 24+ is required to build the desktop package.' }
$nodeVersion = (& $NodePath --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'Node.js 24+ is required.' }
if ((& $NodePath -p 'process.arch').Trim() -ne 'x64') { throw 'This Windows package requires a Windows x64 Node.js runtime.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The .NET Framework C# compiler is not installed.' }
$outputPath = [IO.Path]::GetFullPath((Join-Path $root $Output))
if (-not $outputPath.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Build output must remain inside the project directory.' }
$build = Join-Path $root ('.cache/desktop-build/' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $build -Force | Out-Null
$files = @{}
foreach ($folder in @('src', 'scripts', 'public', 'readonly', 'test')) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root $folder) -File -Recurse) {
        if ($file.Extension -notin @('.mjs', '.ps1', '.js', '.css', '.svg', '.html') -and $file.Name -ne 'LUCIDE-LICENSE') { continue }
        $relative = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
        $files[$relative] = $file.FullName
    }
}
foreach ($relative in @(
    'vendor/sqljs/sql-wasm.js', 'vendor/sqljs/sql-wasm.wasm', 'vendor/sqljs/LICENSE', 'vendor/sqljs/package.json',
    'desktop/Manager.cs', 'desktop/app.manifest', 'desktop/NODE-LICENSE.txt',
    'README.md', 'package.json', '.env.example', '.gitignore', 'Start.ps1', 'Stop.ps1',
    'Install-Autostart.ps1', 'Uninstall-Autostart.ps1', 'Deploy-GitHubPages.ps1', 'Deploy-GitHubPages.cmd', 'Publish.ps1', 'Publish.cmd'
)) { $files[$relative] = Join-Path $root $relative }
$files['__runtime/node.exe'] = [IO.Path]::GetFullPath($NodePath)
$files['__runtime/NODE-LICENSE.txt'] = Join-Path $root 'desktop/NODE-LICENSE.txt'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = Join-Path $build 'court-bundle.zip'
$stream = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew)
$zip = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
$manifestFiles = @()
try {
    foreach ($relative in ($files.Keys | Sort-Object)) {
        if ($relative -match '(^|/)(data|site|\.git|\.cache|\.desktop)(/|$)' -or $relative -eq '.env') { throw ('Private path in package: ' + $relative) }
        $source = $files[$relative]
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw ('Missing package source: ' + $relative) }
        if ((Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Refusing to package a symbolic link: ' + $relative) }
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $source, $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        $manifestFiles += [ordered]@{ path = $relative; sha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
} finally { $zip.Dispose(); $stream.Dispose() }
$manifest = [ordered]@{ format = 'court-desktop-bundle-v1'; node = $nodeVersion; files = $manifestFiles }
$manifestPath = Join-Path $build 'bundle-manifest.json'
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
$temporaryExe = Join-Path $build 'BrokenArrowCourt.exe'
$arguments = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
    ('/out:' + $temporaryExe), ('/win32manifest:' + (Join-Path $root 'desktop/app.manifest')),
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll',
    '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
    ('/resource:' + $archivePath + ',court.bundle'), ('/resource:' + $manifestPath + ',court.manifest'),
    (Join-Path $root 'desktop/Manager.cs'))
Write-Output 'Compiling the desktop application with its bundled Node.js runtime...'
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'Desktop compilation failed.' }
New-Item -ItemType Directory -Path (Split-Path -Parent $outputPath) -Force | Out-Null
Move-Item -LiteralPath $temporaryExe -Destination $outputPath -Force
Write-Output ('Built: ' + $outputPath)
Write-Output ('Size: ' + [Math]::Round((Get-Item -LiteralPath $outputPath).Length / 1MB, 1) + ' MiB')
Write-Output ('Package manifest: ' + $manifestPath)
