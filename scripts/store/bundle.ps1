<#
.SYNOPSIS
  Combine the per-arch Store packages electron-builder produced into one multi-architecture .msixbundle.
#>
[CmdletBinding()]
param([string]$Version = "")

$ErrorActionPreference = "Stop"
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$root    = Join-Path $here "..\.."
$release = Join-Path $root "release"
$pkgDir  = Join-Path $release "packages"

. (Join-Path $here "version.ps1")
if (-not $Version) { $Version = Get-AppVersion -RepoRoot $root }

# Find built packages dynamically (supports both .msix and .appx outputs)
$packageFiles = Get-ChildItem (Join-Path $release "*.msix"), (Join-Path $release "*.appx") -ErrorAction SilentlyContinue | 
    Where-Object { $_.Name -notlike "*.msixbundle" -and $_.Name -notlike "*.appxbundle" }

if (-not $packageFiles) {
    throw "No package files found in $release - run your build script first."
}

if (Test-Path $pkgDir) { Remove-Item $pkgDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null

# Corrected loop syntax with proper spacing
foreach ($f in $packageFiles) {
    $cleanName = ($f.BaseName -replace '\s+', '') + $f.Extension
    Copy-Item $f.FullName (Join-Path $pkgDir $cleanName)
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
Write-Host "MSIX bundle created successfully: $bundle" -ForegroundColor Green