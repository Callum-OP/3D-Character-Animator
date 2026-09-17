<#
.SYNOPSIS
  Combine the per-arch MSIX packages (dist/packages/*.msix) into one .msixbundle.

.DESCRIPTION
  A single multi-architecture file you upload to Partner Center (which signs it).
  Run the per-arch pack steps first, or just use `npm run build-store`, which
  builds, packs and bundles in one go.
#>
[CmdletBinding()]
param([string]$Version = "")

$ErrorActionPreference = "Stop"
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$release = Join-Path $here "..\..\release"
$pkgDir  = Join-Path $release "packages"

# Resolve the version from package.json unless one was passed explicitly.
. (Join-Path $here "version.ps1")
if (-not $Version) { $Version = Get-AppVersion -RepoRoot (Join-Path $here "..\..") }

if (-not (Get-ChildItem (Join-Path $pkgDir "*.msix") -ErrorAction SilentlyContinue)) {
    throw "No MSIX packages in $pkgDir - run the per-arch pack steps first (npm run build-store)."
}

function Find-Kit($name) {
    $bin = "C:\Program Files (x86)\Windows Kits\10\bin"
    $hit = Get-ChildItem "$bin\*\arm64\$name", "$bin\*\x64\$name" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $hit) { throw "$name not found under $bin (install the Windows SDK)" }
    return $hit.FullName
}
$makeappx = Find-Kit "makeappx.exe"

$bundle = Join-Path $release "Animare3DAnimator_$Version.msixbundle"
& $makeappx bundle /d $pkgDir /p $bundle /bv $Version /o
if ($LASTEXITCODE -ne 0) { throw "makeappx bundle failed (exit $LASTEXITCODE)" }
Write-Host "MSIX bundle created: $bundle" -ForegroundColor Green
