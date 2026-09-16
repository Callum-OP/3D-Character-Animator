<#
.SYNOPSIS
  Resolve the app version from the root package.json (the single source of truth).

.DESCRIPTION
  Reads package.json "version" and normalises it to the 4-part
  Major.Minor.Build.Revision form that MSIX package identities require
  (e.g. "0.1.0" -> "0.1.0.0"). Dot-sourced by pack.ps1 and bundle.ps1 so the
  version only has to be bumped in one place.
#>
function Get-AppVersion {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $pkg   = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
    $parts = @($pkg.version -split '\.')
    while ($parts.Count -lt 4) { $parts += '0' }
    return ($parts[0..3] -join '.')
}
