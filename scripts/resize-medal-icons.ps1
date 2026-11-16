$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$medalWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$medalSourceRoot = Join-Path $medalWorkspace '.cache/medal-icons/source'
$medalOutputRoot = Join-Path $medalWorkspace 'public/medal-icons'
New-Item -ItemType Directory -Path $medalOutputRoot -Force | Out-Null
foreach ($medalFile in Get-ChildItem -LiteralPath $medalSourceRoot -File) {
    if ($medalFile.Name -notmatch '^[A-Za-z0-9_-]+\.png$') { throw 'Invalid medal filename' }
    $medalImage = [Drawing.Image]::FromFile($medalFile.FullName)
    $medalBitmap = New-Object Drawing.Bitmap 64,64
    $medalGraphics = [Drawing.Graphics]::FromImage($medalBitmap)
    try {
        $medalGraphics.Clear([Drawing.Color]::Transparent)
        $medalGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $medalGraphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $medalRatio = [Math]::Min(64.0 / $medalImage.Width, 64.0 / $medalImage.Height)
        $medalWidth = [int][Math]::Round($medalImage.Width * $medalRatio)
        $medalHeight = [int][Math]::Round($medalImage.Height * $medalRatio)
        $medalRectangle = New-Object Drawing.Rectangle ([int]((64 - $medalWidth) / 2)),([int]((64 - $medalHeight) / 2)),$medalWidth,$medalHeight
        $medalGraphics.DrawImage($medalImage, $medalRectangle)
        $medalBitmap.Save((Join-Path $medalOutputRoot $medalFile.Name), [Drawing.Imaging.ImageFormat]::Png)
    } finally { $medalGraphics.Dispose(); $medalBitmap.Dispose(); $medalImage.Dispose() }
}
Get-ChildItem -LiteralPath $medalOutputRoot -File | Measure-Object -Property Length -Sum | Select-Object Count,Sum
