# Builds dist\openClick.zxp (signed, timestamped) and dist\openClick.zip.
#
#   build.ps1 [-Password <cert password>] [-SignTool <path to ZXPSignCmd.exe>]
#
# ZXPSignCmd.exe is Adobe's free signing tool:
#   https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD
# Put ZXPSignCmd.exe in this "build" folder (or on PATH), or pass -SignTool.

param(
    [string]$Password,
    [string]$SignTool
)

$ErrorActionPreference = 'Stop'
$BuildDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root       = Split-Path -Parent $BuildDir
$ExtSrc     = Join-Path $Root 'extension'
$Installer  = Join-Path $Root 'installer'
$Dist       = Join-Path $Root 'dist'
$Cert       = Join-Path $BuildDir 'cert.p12'
$ExtensionId = 'com.openclick2'
$Tsa = @('http://timestamp.digicert.com', 'http://timestamp.sectigo.com', 'http://timestamp.globalsign.com/tsa/r6advanced1')

# Windows PowerShell 5.1 turns native stderr into terminating errors when
# ErrorActionPreference is Stop, so the signing tool runs with Continue.
function Run-Tool {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $text = & $script:Tool @args 2>&1 | Out-String }
    finally { $ErrorActionPreference = $saved }
    return $text
}
function Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Fail($t) { Write-Host ''; Write-Host "BUILD FAILED: $t" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- sign tool
Step 'Locating ZXPSignCmd.exe'
$candidates = @()
if ($SignTool) { $candidates += $SignTool }
$candidates += (Join-Path $BuildDir 'ZXPSignCmd.exe')
$candidates += (Join-Path $Root 'ZXPSignCmd.exe')
$cmd = Get-Command 'ZXPSignCmd.exe' -ErrorAction SilentlyContinue
if ($cmd) { $candidates += $cmd.Path }
$script:Tool =$candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $Tool) {
    Write-Host 'ZXPSignCmd.exe was not found.' -ForegroundColor Yellow
    Write-Host 'Download the win64 ZXPSignCmd.exe from'
    Write-Host '  https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD'
    Write-Host "and save it as: $(Join-Path $BuildDir 'ZXPSignCmd.exe')"
    Fail 'signing tool missing'
}
Write-Host "Using $Tool"

# ---------------------------------------------------------------- password
if (-not $Password) {
    $secure = Read-Host -AsSecureString -Prompt 'Certificate password (a new certificate is created if build\cert.p12 is missing)'
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $Password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $Password) { Fail 'a certificate password is required' }

# ---------------------------------------------------------------- certificate
if (-not (Test-Path -LiteralPath $Cert)) {
    Step 'Creating self-signed certificate (valid 10 years)'
    Write-Host (Run-Tool -selfSignedCert IN Rajasthan openClick openClick $Password $Cert -validityDays 3650).Trim()
    if (-not (Test-Path -LiteralPath $Cert)) { Fail 'certificate could not be created' }
}

# ---------------------------------------------------------------- stage
Step 'Staging extension files'
$Stage = Join-Path $BuildDir 'stage'
$StageExt = Join-Path $Stage $ExtensionId
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $StageExt -Force | Out-Null
Copy-Item -Path (Join-Path $ExtSrc '*') -Destination $StageExt -Recurse -Force
# Never ship debug or OS clutter files.
Get-ChildItem -LiteralPath $StageExt -Recurse -Force -File |
    Where-Object { $_.Name -in @('.debug', 'Thumbs.db', 'desktop.ini', '.DS_Store') -or $_.Extension -in @('.bak', '.tmp', '.log') } |
    Remove-Item -Force
foreach ($required in @('CSXS\manifest.xml', 'index.html', 'js\main.js', 'jsx\host.jsx', 'jsx\OpenClickLayerDonor.xml', 'presets\Transform(openClick).prfpset')) {
    if (-not (Test-Path -LiteralPath (Join-Path $StageExt $required))) { Fail "missing extension file: $required" }
}
$manifest = [xml](Get-Content -LiteralPath (Join-Path $StageExt 'CSXS\manifest.xml') -Raw)
$Version = $manifest.ExtensionManifest.ExtensionBundleVersion
Write-Host "Extension $ExtensionId version $Version"

if (-not (Test-Path -LiteralPath $Dist)) { New-Item -ItemType Directory -Path $Dist | Out-Null }

# ---------------------------------------------------------------- sign
Step 'Signing ZXP'
$Zxp = Join-Path $Dist 'openClick.zxp'
$signed = $false
foreach ($url in ($Tsa + @(''))) {
    if (Test-Path -LiteralPath $Zxp) { Remove-Item -LiteralPath $Zxp -Force }
    if ($url) {
        Write-Host "Timestamp server: $url"
        $out = Run-Tool -sign $StageExt $Zxp $Cert $Password -tsa $url
    } else {
        Write-Host 'No timestamp server reachable; signing without a timestamp.' -ForegroundColor Yellow
        $out = Run-Tool -sign $StageExt $Zxp $Cert $Password
    }
    Write-Host $out.Trim()
    if ((Test-Path -LiteralPath $Zxp) -and ($out -match 'Signed successfully')) { $signed = $true; break }
}
if (-not $signed) { Fail 'signing failed (wrong certificate password?)' }

Step 'Verifying signature'
$verify = Run-Tool -verify $Zxp -certInfo
Write-Host $verify.Trim()
if ($verify -notmatch 'Signature verified successfully') { Fail 'signature verification failed' }

# ---------------------------------------------------------------- installers next to the zxp
Copy-Item -LiteralPath (Join-Path $Installer 'install.ps1') -Destination $Dist -Force
Copy-Item -LiteralPath (Join-Path $Installer 'Install openClick.cmd') -Destination $Dist -Force
Copy-Item -LiteralPath (Join-Path $Installer 'Uninstall openClick.cmd') -Destination $Dist -Force

# ---------------------------------------------------------------- manual zip
Step 'Building manual-install ZIP'
$ZipDir = Join-Path $BuildDir 'zip'
if (Test-Path -LiteralPath $ZipDir) { Remove-Item -LiteralPath $ZipDir -Recurse -Force }
New-Item -ItemType Directory -Path $ZipDir | Out-Null
Copy-Item -LiteralPath $StageExt -Destination $ZipDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $Installer 'INSTALL.txt') -Destination $ZipDir -Force
Copy-Item -LiteralPath (Join-Path $Installer 'install.ps1') -Destination $ZipDir -Force
Copy-Item -LiteralPath (Join-Path $Installer 'Install openClick.cmd') -Destination $ZipDir -Force
Copy-Item -LiteralPath (Join-Path $Installer 'Uninstall openClick.cmd') -Destination $ZipDir -Force

$Zip = Join-Path $Dist 'openClick.zip'
if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($ZipDir, $Zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

Remove-Item -LiteralPath $Stage -Recurse -Force

Step 'Done'
Write-Host "  $Zxp"
Write-Host "  $Zip"
Write-Host "  $(Join-Path $Dist 'Install openClick.cmd')  (installs the .zxp without a third-party installer)"
exit 0
