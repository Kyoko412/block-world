# traffic-guard.ps1 -- measure this machine's network throughput for a while and
# print it as MB/hour, so an unattended build session can prove it is not downloading.
#
# Read-only: it only queries adapter counters. No downloads, no writes outside $env:TEMP.
# ASCII-only on purpose (PowerShell 5.1 misreads non-ASCII literals in BOM-less files).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\app\tools\traffic-guard.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\app\tools\traffic-guard.ps1 -Seconds 60

param(
  [int]$Seconds = 20
)

$ErrorActionPreference = 'Stop'

function Snapshot() {
  $rows = @(Get-NetAdapterStatistics -ErrorAction SilentlyContinue |
    Where-Object { $_.ReceivedBytes -ne $null })
  $rx = 0L; $tx = 0L
  foreach ($r in $rows) {
    $rx += [int64]$r.ReceivedBytes
    $tx += [int64]$r.SentBytes
  }
  return @{ rx = $rx; tx = $tx; at = (Get-Date) }
}

$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' })
foreach ($a in $adapters) { Write-Output ("IF_UP=" + $a.Name + " " + $a.LinkSpeed) }

$a0 = Snapshot
Start-Sleep -Seconds $Seconds
$a1 = Snapshot

$elapsed = ($a1.at - $a0.at).TotalSeconds
$rxBytes = [int64]$a1.rx - [int64]$a0.rx
$txBytes = [int64]$a1.tx - [int64]$a0.tx
if ($rxBytes -lt 0) { $rxBytes = 0 }
if ($txBytes -lt 0) { $txBytes = 0 }

$rxPerHour = $rxBytes / 1MB / ($elapsed / 3600.0)
$txPerHour = $txBytes / 1MB / ($elapsed / 3600.0)

Write-Output ("SAMPLE_SECONDS=" + [math]::Round($elapsed, 1))
Write-Output ("RX_BYTES=" + $rxBytes + "  TX_BYTES=" + $txBytes)
Write-Output ("RX_RATE=" + [math]::Round($rxPerHour, 2) + " MB/hour")
Write-Output ("TX_RATE=" + [math]::Round($txPerHour, 2) + " MB/hour")
Write-Output ("TOTAL_RATE_MB_PER_HOUR=" + [math]::Round($rxPerHour + $txPerHour, 2))

# Also show which processes currently hold network sockets -- a quick "who is talking" list.
$conns = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue)
$byProc = $conns | Group-Object -Property OwningProcess | Sort-Object Count -Descending | Select-Object -First 6
foreach ($g in $byProc) {
  $p = Get-Process -Id $g.Name -ErrorAction SilentlyContinue
  Write-Output ("ESTABLISHED pid=" + $g.Name + " proc=" + $(if ($p) { $p.ProcessName } else { '?' }) + " conns=" + $g.Count)
}
if ($conns.Count -eq 0) { Write-Output "ESTABLISHED=0" }
