# 把 Luanti 窗口提到前台并只截这个窗口（即使被其他窗口遮挡）
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File scripts/capture-window.ps1 -Out shot.png [-TitlePrefix "Luanti"]
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$TitlePrefix = 'Luanti'
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like ($TitlePrefix + '*') } | Select-Object -First 1
if (-not $proc) { throw ("找不到窗口：" + $TitlePrefix) }
$h = $proc.MainWindowHandle
[Win32]::ShowWindow($h, 9) | Out-Null
[Win32]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 900

$rect = New-Object Win32+RECT
[Win32]::GetWindowRect($h, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left; $hh = $rect.Bottom - $rect.Top
if ($w -le 0 -or $hh -le 0) { throw '窗口尺寸异常' }
$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[Win32]::PrintWindow($h, $hdc, 2) | Out-Null   # 2 = PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc); $g.Dispose()
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host ("已截取窗口：" + $Out + " (" + $w + "x" + $hh + ") 标题=" + $proc.MainWindowTitle)
