# 截屏工具：把当前主屏保存为 PNG（用于自证排版/光影，不需要人工看窗口）
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File scripts/screenshot.ps1 -Out "E:\...\shot.png"
param([Parameter(Mandatory = $true)][string]$Out)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host ("已保存：" + $Out + " (" + $bounds.Width + "x" + $bounds.Height + ")")
