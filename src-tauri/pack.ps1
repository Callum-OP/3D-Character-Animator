<#
.SYNOPSIS
  Package the built Tauri exe into an MSIX for the Microsoft Store.

.DESCRIPTION
  Stages character-animator.exe + the Store logo assets next to AppxManifest.xml and
  runs MakeAppx. By default produces an UNSIGNED MSIX (what you upload to Partner
  Center, which re-signs it). With -TestSign it self-signs with a throwaway cert so
  you can install it locally and run the Windows App Certification Kit (WACK).

.EXAMPLE
  ./pack.ps1                 # unsigned MSIX for Partner Center
  ./pack.ps1 -TestSign       # also self-sign for local install + WACK

.NOTES
  Run `npm run tauri:build` first. Trusting the test cert and installing the package
  require an elevated (admin) PowerShell - see the printed instructions / README.
#>
[CmdletBinding()]
param(
    [string]$Arch = "arm64",
    [string]$Version = "",
    [switch]$TestSign,
    [string]$TestPublisher = "CN=3D Character Animator Test Cert"
)

$ErrorActionPreference = "Stop"
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$icons = Join-Path $here "..\icons"

# Resolve the version from package.json unless one was passed explicitly.
. (Join-Path $here "version.ps1")
if (-not $Version) { $Version = Get-AppVersion -RepoRoot (Join-Path $here "..\..") }

# Resolve the exe for the requested arch. A cross-compiled build lands under
# target\<triple>\release; the default host build lands under target\release.
$triple = @{ "arm64" = "aarch64-pc-windows-msvc"; "x64" = "x86_64-pc-windows-msvc" }[$Arch]
if (-not $triple) { throw "Unsupported -Arch '$Arch' (use arm64 or x64)" }
$exe = @(
    (Join-Path $here "..\target\$triple\release\character-animator.exe"),
    (Join-Path $here "..\target\release\character-animator.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
    throw "No character-animator.exe for $Arch. Build first, e.g.: npm run tauri:build -- --target $triple"
}

# Locate MakeAppx / signtool (prefer the native arm64 build on this host, else x64)
function Find-Kit($name) {
    $bin = "C:\Program Files (x86)\Windows Kits\10\bin"
    $hit = Get-ChildItem "$bin\*\arm64\$name", "$bin\*\x64\$name" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $hit) { throw "$name not found under $bin (install the Windows SDK)" }
    return $hit.FullName
}
$makeappx = Find-Kit "makeappx.exe"

# Stage the package payload
$stage = Join-Path $here "..\target\msix-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage, (Join-Path $stage "Assets") | Out-Null
Copy-Item $exe (Join-Path $stage "character-animator.exe")
foreach ($a in "StoreLogo.png", "Square44x44Logo.png", "Square71x71Logo.png", "Square150x150Logo.png") {
    Copy-Item (Join-Path $icons $a) (Join-Path $stage "Assets\$a")
}

# Copy the manifest, adjusting arch (and publisher when test-signing, since the
# signing cert subject must match the manifest Publisher for the package to install)
$manifest = Get-Content (Join-Path $here "AppxManifest.xml") -Raw
$manifest = $manifest -replace 'ProcessorArchitecture="[^"]*"', "ProcessorArchitecture=`"$Arch`""
# Stamp the package identity version from package.json. The Store reads this and
# requires it to increase each submission, so it must track the real version.
# -creplace (case-sensitive) + lookbehind targets Identity's Version only, not the
# lowercase XML declaration or the MinVersion/MaxVersionTested attributes.
$manifest = $manifest -creplace '(?<![A-Za-z])Version="[^"]*"', "Version=`"$Version`""
if ($TestSign) {
    $manifest = $manifest -replace 'Publisher="CN=[^"]*"', "Publisher=`"$TestPublisher`""
}
Set-Content (Join-Path $stage "AppxManifest.xml") $manifest -Encoding UTF8

# Pack - per-arch MSIX go into release/packages (bundle inputs); bundle.ps1 combines
# them into a single release/*.msixbundle. release/ is separate from dist/ (the Vite
# frontend build output) so `tauri:clean` never touches the built frontend, and is
# gitignored and easy to find.
$outDir = Join-Path $here "..\..\release\packages"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$msix = Join-Path $outDir "3DCharacterAnimator_${Version}_$Arch.msix"
& $makeappx pack /d $stage /p $msix /o
if ($LASTEXITCODE -ne 0) { throw "makeappx failed (exit $LASTEXITCODE)" }
Write-Host "MSIX created: $msix" -ForegroundColor Green

if ($TestSign) {
    $signtool = Find-Kit "signtool.exe"
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $TestPublisher } | Select-Object -First 1
    if (-not $cert) {
        Write-Host "Creating self-signed test cert $TestPublisher ..."
        $cert = New-SelfSignedCertificate -Type Custom -Subject $TestPublisher `
            -KeyUsage DigitalSignature -FriendlyName "3D Character Animator Test" `
            -CertStoreLocation "Cert:\CurrentUser\My" `
            -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
    }
    & $signtool sign /fd SHA256 /a /sha1 $cert.Thumbprint $msix
    if ($LASTEXITCODE -ne 0) { throw "signtool failed (exit $LASTEXITCODE)" }
    Write-Host "Signed with test cert (thumbprint $($cert.Thumbprint))." -ForegroundColor Green
    Write-Host ""
    Write-Host "Next (elevated/admin PowerShell), trust the cert and install:" -ForegroundColor Yellow
    Write-Host "  Export-Certificate -Cert Cert:\CurrentUser\My\$($cert.Thumbprint) -FilePath `$env:TEMP\ca-test.cer"
    Write-Host "  Import-Certificate -FilePath `$env:TEMP\ca-test.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople"
    Write-Host "  Add-AppxPackage -Path `"$msix`""
    Write-Host "Then run WACK (see msix/README.md)."
}
