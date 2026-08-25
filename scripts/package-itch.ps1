$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$archive = Join-Path $root '3d-character-animator-itch.zip'

if (-not (Test-Path (Join-Path $dist 'index.html'))) {
  throw "dist/index.html was not found. Run npm run build first."
}

if (Test-Path $archive) {
  Remove-Item $archive -Force
}

# Archive the contents of dist, not the dist folder itself, so index.html is at
# the ZIP root as required by itch.io HTML5 uploads.
Compress-Archive -Path (Join-Path $dist '*') -DestinationPath $archive -CompressionLevel Optimal
Write-Host "Created $archive"