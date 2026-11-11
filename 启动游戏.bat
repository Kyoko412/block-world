@echo off
rem Launch the Luanti build bundled under this folder.
rem ASCII-only on purpose: cmd codepage must not matter for Chinese folder names.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$e = Get-ChildItem -LiteralPath (Get-Location) -Recurse -Filter luanti.exe -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $e) { Write-Host 'luanti.exe not found under'; Write-Host (Get-Location); pause; exit 1 }; $root = Split-Path $e.DirectoryName -Parent; Start-Process -FilePath $e.FullName -WorkingDirectory $root -ArgumentList @('--config', (Join-Path $root 'minetest.conf'))"
