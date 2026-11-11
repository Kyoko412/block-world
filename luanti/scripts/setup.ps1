# 从 downloads/ 组装可运行目录，并应用 overrides.json 的映射。
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1 -Target "E:\MinecraftOffline\游戏\方块世界-Luanti"
param(
  [string]$Root = (Split-Path $PSScriptRoot -Parent),
  [Parameter(Mandatory = $true)][string]$Target
)
$ErrorActionPreference = 'Stop'
$lock = Get-Content -LiteralPath (Join-Path $Root 'dependencies.lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$downloads = Join-Path $Root 'downloads'

function Expand-Verified {
  param($Artifact, [string]$Destination)
  $zip = Join-Path $downloads $Artifact.file
  if (-not (Test-Path -LiteralPath $zip)) { throw ("缺少依赖包：" + $zip + "；先运行 scripts/fetch-deps.ps1") }
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $Artifact.sha256) { throw ("SHA256 不匹配：" + $Artifact.file) }
  $stage = Join-Path ([IO.Path]::GetTempPath()) ('mcbuild-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
    $inner = Join-Path $stage $Artifact.top
    if (-not (Test-Path -LiteralPath $inner -PathType Container)) {
      $candidates = Get-ChildItem -LiteralPath $stage -Directory
      if ($candidates.Count -eq 1) { $inner = $candidates[0].FullName }
      else { throw ("压缩包结构与预期不符：" + $Artifact.file) }
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -LiteralPath $inner -Force | Copy-Item -Destination $Destination -Recurse -Force
  } finally {
    $resolved = [IO.Path]::GetFullPath($stage)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

New-Item -ItemType Directory -Force -Path $Target | Out-Null
$engine = $lock.artifacts | Where-Object { $_.role -eq 'runtime' }
$game = $lock.artifacts | Where-Object { $_.role -eq 'game-source' }

if (-not (Test-Path -LiteralPath (Join-Path $Target 'bin\luanti.exe'))) {
  Write-Host '解压引擎…'
  Expand-Verified -Artifact $engine -Destination $Target
}
$gameDir = Join-Path $Target 'games\mineclonia'
if (-not (Test-Path -LiteralPath (Join-Path $gameDir 'game.conf'))) {
  Write-Host '解压游戏…'
  Expand-Verified -Artifact $game -Destination $gameDir
}

# 应用我们的源码与配置（src/ mods/ textures/ → 目标目录）
$mapFile = Join-Path $Root 'overrides.json'
if (Test-Path -LiteralPath $mapFile) {
  $mapping = Get-Content -LiteralPath $mapFile -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($entry in $mapping) {
    $source = [IO.Path]::GetFullPath((Join-Path $Root $entry.source))
    $destination = [IO.Path]::GetFullPath((Join-Path $Target $entry.target))
    if (-not (Test-Path -LiteralPath $source)) { throw ("映射源不存在：" + $source) }
    $sourceRoot = [IO.Path]::GetFullPath($Root) + [IO.Path]::DirectorySeparatorChar
    $targetRoot = [IO.Path]::GetFullPath($Target) + [IO.Path]::DirectorySeparatorChar
    if (-not $source.StartsWith($sourceRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '映射源越界' }
    if (-not $destination.StartsWith($targetRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '映射目标越界' }
    New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
    if (Test-Path -LiteralPath $source -PathType Container) {
      New-Item -ItemType Directory -Force -Path $destination | Out-Null
      Copy-Item -Path (Join-Path $source '*') -Destination $destination -Recurse -Force
    } else {
      Copy-Item -LiteralPath $source -Destination $destination -Force
    }
    Write-Host ("已应用：" + $entry.source + " → " + $entry.target)
  }
}

New-Item -ItemType Directory -Force -Path (Join-Path $Target 'worlds') | Out-Null
Write-Host ("组装完成：" + $Target)
