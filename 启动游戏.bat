@echo off
rem Launch the bundled Luanti build.
rem ASCII-only: cmd codepage must not matter. Skips artifacts/ (test runtimes).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$roots = Get-ChildItem -Directory | Where-Object { $_.Name -notmatch '^(artifacts|\.|dsh|docs|luanti)' }; $found = @(); foreach ($r in $roots) { $e = Join-Path $r.FullName 'bin\luanti.exe'; if (Test-Path $e) { $found += $e }; foreach ($s in (Get-ChildItem -Path $r.FullName -Directory -ErrorAction SilentlyContinue)) { $e2 = Join-Path $s.FullName 'bin\luanti.exe'; if (Test-Path $e2) { $found += $e2 } } }; $exe = $found | Select-Object -First 1; if (-not $exe) { Write-Host 'luanti.exe not found'; pause; exit 1 }; $root = Split-Path (Split-Path $exe -Parent) -Parent; Start-Process -FilePath $exe -WorkingDirectory $root -ArgumentList @('--config', (Join-Path $root 'minetest.conf'))"
