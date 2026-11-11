$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$cache = Join-Path $root '.tmp-audio/music-source'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
Push-Location $root
try {
  $sources = (& node --input-type=module -e "import {SOURCES} from './app/tools/music-audio/recordings.mjs';process.stdout.write(JSON.stringify(SOURCES));") | ConvertFrom-Json
  foreach ($source in $sources) {
    $file = Join-Path $cache $source.file
    if (-not (Test-Path -LiteralPath $file)) { Invoke-WebRequest -Uri $source.url -OutFile $file -UseBasicParsing -TimeoutSec 60 }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $source.sha256) { throw ('Sample SHA-256 mismatch: ' + $source.file) }
  }
  Write-Output ('Prepared ' + $sources.Count + ' CC0 instrument recordings')
} finally { Pop-Location }
