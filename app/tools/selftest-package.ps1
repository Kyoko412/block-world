# Re-run the acceptance scenario against the packaged (portable) build and
# report the real process exit code.
#
# Exit codes from the game executable:
#   0 = all assertions passed and no runtime errors
#   1 = some assertion failed (or an unexpected runtime error)
#   2 = the self-test never finished in time
#   3 = the bundled scenario file is missing
#
# Usage (from anywhere):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\app\tools\selftest-package.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\app\tools\selftest-package.ps1 -Guardian
#
# Notes on this machine: the executable lives under a folder whose name contains
# CJK characters, and PowerShell 5.1 misreads non-ASCII literals in scripts that
# are saved without a BOM. The path is therefore resolved by probing for the
# ASCII-named launcher instead of being written out literally. Everything else
# in this file stays ASCII.
#
# Acceptance-save isolation (phase 6 close-out):
#   Every run owns a fresh directory under artifacts/acceptance/<stamp>-<TAG>/.
#   BLOCKWORLD_SELFTEST_SAVES points the EXE at <run>/saves, so the main and the
#   guardian self-tests never share a save root. The player's portable saves/
#   folder is NEVER cleaned: it is only snapshotted (read-only) so the isolation
#   check can prove both runs left it untouched. stdout, stderr, the JSON report,
#   exit code, elapsed time and measured file hashes all live inside <run>/ and
#   are therefore immune to a later scenario deleting anything.

param(
  # Phase 5: -Guardian runs the separate guardian acceptance scenario from the same EXE.
  [switch]$Guardian,
  # Phase 7: -Route runs the normal survival route evidence scenario from the same EXE.
  [switch]$Route
)

$ErrorActionPreference = 'Stop'

# repo root = two levels above app\tools
$root = (Get-Item (Join-Path (Join-Path $PSScriptRoot '..') '..')).FullName

$launcher = Get-ChildItem -Path $root -Recurse -Depth 3 -Filter 'start-game.bat' -File |
  Select-Object -First 1
if (-not $launcher) { throw "start-game.bat not found under $root" }
$dir = $launcher.DirectoryName

$exe = Get-ChildItem -Path $dir -Filter '*.exe' -File | Select-Object -First 1
if (-not $exe) { throw "no executable found in $dir" }

$modeArg = if ($Guardian) { '--selftest-guardian' } elseif ($Route) { '--selftest-route' } else { '--selftest' }
$tag = if ($Guardian) { 'GUARDIAN' } elseif ($Route) { 'ROUTE' } else { 'MAIN' }

# Some host shells inject ELECTRON_RUN_AS_NODE / NODE_OPTIONS, which makes the
# EXE start as plain Node and fail to resolve the 'electron' built-in module.
# Clear them for this process only; the spawned game process inherits a clean
# environment. Normal double-click launches are unaffected.
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue

# ---- create this run's own, verified acceptance directory --------------------
$acceptRoot = Join-Path $root 'artifacts\acceptance'
New-Item -ItemType Directory -Path $acceptRoot -Force | Out-Null
$rootFull = [IO.Path]::GetFullPath($acceptRoot)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runFull = [IO.Path]::GetFullPath((Join-Path $acceptRoot ($stamp + '-' + $tag)))
# Never clean anything outside the acceptance root, and never delete an
# existing run: a same-second repeat gets a numbered sibling instead.
if (-not $runFull.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "unsafe run directory: $runFull"
}
$n = 0
while (Test-Path $runFull) {
  $n++
  $runFull = [IO.Path]::GetFullPath((Join-Path $acceptRoot ($stamp + '-' + $tag + '-' + $n)))
  if (-not $runFull.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "unsafe run directory: $runFull"
  }
}
New-Item -ItemType Directory -Path $runFull -Force | Out-Null
$runDir = $runFull
$saves = Join-Path $runDir 'saves'
New-Item -ItemType Directory -Path $saves -Force | Out-Null

# ---- read-only snapshot of the player's portable saves ----------------------
$normalSaves = Join-Path $dir 'saves'
$snapshot = @()
if (Test-Path $normalSaves) {
  $snapshot = @(Get-ChildItem -Path $normalSaves -File | ForEach-Object {
    [pscustomobject]@{
      name   = $_.Name
      bytes  = $_.Length
      sha256 = (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash
    }
  })
}

# ---- hash the code this run actually measures -------------------------------
$hashFiles = @(
  $exe.FullName,
  (Join-Path $dir 'resources\app\main.js'),
  (Join-Path $dir 'resources\app\server.js'),
  (Join-Path $dir 'resources\app\selftest\e2e-scenario.js'),
  (Join-Path $dir 'resources\app\selftest\guardian-scenario.js'),
  (Join-Path $dir 'resources\app\renderer\js\gfx\painters.js'),
  (Join-Path $dir 'resources\app\renderer\js\world\mesher.js'),
  (Join-Path $dir 'resources\app\renderer\js\world\mobs.js'),
  (Join-Path $dir 'resources\app\renderer\js\core\recipes.js')
)
$hashes = @()
foreach ($f in $hashFiles) {
  if (Test-Path $f) {
    $hashes += [pscustomobject]@{
      file   = $f.Substring($root.Length).TrimStart('\', '/')
      bytes  = (Get-Item $f).Length
      sha256 = (Get-FileHash -Path $f -Algorithm SHA256).Hash
    }
  }
}
$gitHead = ''
try { $gitHead = (& git -C $root rev-parse HEAD 2>$null | Select-Object -First 1) } catch { $gitHead = '' }
if (-not $gitHead) { $gitHead = 'unavailable' }

# ---- run -------------------------------------------------------------------
$env:BLOCKWORLD_SELFTEST_SAVES = $saves
$outFile = Join-Path $runDir 'stdout.txt'
$errFile = Join-Path $runDir 'stderr.txt'
$startedAt = (Get-Date).ToString('o')
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $exe.FullName `
  -ArgumentList $modeArg `
  -WorkingDirectory $dir `
  -Wait -PassThru `
  -RedirectStandardOutput $outFile `
  -RedirectStandardError $errFile
$sw.Stop()
$finishedAt = (Get-Date).ToString('o')
Remove-Item Env:\BLOCKWORLD_SELFTEST_SAVES -ErrorAction SilentlyContinue

Write-Output ("FOLDER=" + $dir)
Write-Output ("EXE_BYTES=" + $exe.Length)
Write-Output ("MODE=" + $tag)
Write-Output ("RUN_DIR=" + $runDir)
Write-Output ("SAVE_ROOT=" + $saves)
Write-Output ("EXITCODE=" + $p.ExitCode)
Write-Output ("ELAPSED_MS=" + $sw.ElapsedMilliseconds)

$out = @()
if (Test-Path $outFile) { $out = Get-Content $outFile }
# Keep this script ASCII-only: match the "passed n/n" summary line by its digit pattern.
$passLine = $out | Select-String -Pattern '\d+/\d+' | Select-Object -Last 1
if ($passLine) { Write-Output ("RESULT_LINE=" + $passLine.Line) }
$cross = [string][char]0x2717
$failed = @($out | Where-Object { $_ -like ("*" + $cross + "*") })
Write-Output ("FAILED_LINES=" + $failed.Count)
Write-Output ("STDERR_BYTES=" + ((Get-Item $errFile -ErrorAction SilentlyContinue).Length))

$reportName = if ($Guardian) { 'guardian-report.json' } elseif ($Route) { 'route-report.json' } else { 'selftest-report.json' }
$report = Join-Path $saves $reportName
Write-Output ("REPORT=" + $report)
$reportPass = $null
$reportTotal = $null
$reportErrors = $null
if (Test-Path $report) {
  $r = Get-Content $report -Raw -Encoding UTF8 | ConvertFrom-Json
  $reportPass = [int]$r.pass
  $reportTotal = [int]$r.total
  $reportErrors = @($r.errors).Count
  Write-Output ("PASS=" + $r.pass + "/" + $r.total + "  ERRORS=" + @($r.errors).Count)
  $bad = @($r.steps | Where-Object { -not $_.pass })
  if ($bad.Count -gt 0) {
    foreach ($b in $bad) { Write-Output ("FAILED_STEP: " + $b.name + "  " + $b.info) }
  }
  # Keep a copy next to stdout/stderr: a later run cannot remove this one.
  Copy-Item -Path $report -Destination (Join-Path $runDir 'report.json') -Force
}

$meta = [ordered]@{
  tag            = $tag
  modeArg        = $modeArg
  startedAt      = $startedAt
  finishedAt     = $finishedAt
  elapsedMs      = $sw.ElapsedMilliseconds
  exitCode       = [int]$p.ExitCode
  exe            = $exe.FullName
  runDir         = $runDir
  saveRoot       = $saves
  report         = $report
  reportCopy     = (Join-Path $runDir 'report.json')
  pass           = $reportPass
  total          = $reportTotal
  errors         = $reportErrors
  failedLines    = $failed.Count
  stderrBytes    = ((Get-Item $errFile -ErrorAction SilentlyContinue).Length)
  gitHead        = $gitHead
  normalSaves    = $normalSaves
  normalSnapshot = $snapshot
  hashes         = $hashes
}
$metaJson = $meta | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $runDir 'meta.json'), $metaJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("META=" + (Join-Path $runDir 'meta.json'))

exit [int]$p.ExitCode
