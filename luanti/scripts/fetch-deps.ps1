# 校验并下载依赖（只读上游，不做任何本地改动）
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-deps.ps1
param(
  [string]$Root = (Split-Path $PSScriptRoot -Parent)
)
$ErrorActionPreference = 'Stop'
$lock = Get-Content -LiteralPath (Join-Path $Root 'dependencies.lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$downloads = Join-Path $Root 'downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

foreach ($artifact in $lock.artifacts) {
  $target = Join-Path $downloads $artifact.file
  if (Test-Path -LiteralPath $target) {
    $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -eq $artifact.sha256) {
      Write-Host ("已存在且校验通过：" + $artifact.file)
      continue
    }
    Write-Host ("校验不符，重新下载：" + $artifact.file)
    Remove-Item -LiteralPath $target -Force
  }
  Write-Host ("下载 " + $artifact.url)
  Invoke-WebRequest -Uri $artifact.url -OutFile $target -UseBasicParsing
  $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $artifact.sha256) {
    Remove-Item -LiteralPath $target -Force
    throw ("SHA256 不匹配：" + $artifact.file + " 期望 " + $artifact.sha256 + " 实际 " + $hash)
  }
  Write-Host ("校验通过：" + $artifact.file)
}
Write-Host '依赖就绪。'
