<#
.SYNOPSIS
  Sync src-tauri/Cargo.toml's [package] version to the root package.json version.

.DESCRIPTION
  package.json is the single source of truth for the app version. tauri.conf.json
  reads it directly ("version": "../package.json") and the MSIX scripts derive from
  it too, but Cargo can't reference package.json, so the Rust crate version is the
  one spot that would otherwise drift. This patches it. Run as the first step of
  build-store so released builds are internally consistent. Cosmetic-only (the crate
  version doesn't affect the app/installer version) but keeps the logs honest.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkg       = Get-Content (Join-Path $here "..\..\package.json") -Raw | ConvertFrom-Json
$ver       = $pkg.version
$cargoPath = Join-Path $here "..\Cargo.toml"

# Only the [package] version sits at column 0; dependency versions are inline
# ({ version = "..." }) or bare ("3"), so an anchored match won't touch them.
$cargo   = Get-Content $cargoPath -Raw
$updated = [regex]::Replace($cargo, '(?m)^version\s*=\s*"[^"]*"', "version = `"$ver`"")

if ($updated -ne $cargo) {
    # Write UTF-8 without BOM (PowerShell 5.1's Set-Content -Encoding UTF8 adds one,
    # which can upset TOML parsers).
    [System.IO.File]::WriteAllText($cargoPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Cargo.toml version -> $ver" -ForegroundColor Green
} else {
    Write-Host "Cargo.toml already at $ver" -ForegroundColor Green
}
