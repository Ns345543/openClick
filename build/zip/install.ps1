# openClick installer for Adobe Premiere Pro on Windows.
# Works for the current user without admin rights and without any third-party
# ZXP installer. Accepts either an unpacked "com.openclick2" folder or the
# "openClick.zxp" file placed next to this script.
#
#   install.ps1              install / update
#   install.ps1 -Uninstall   remove

param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$ExtensionId = 'com.openclick2'
$Retired     = @('com.openclick', 'com.openclick.probe')
$Here        = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say($text, $color) {
    if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
}

try {
    if (-not $env:APPDATA) { throw 'The APPDATA folder could not be found for this user.' }
    $ExtRoot = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
    $Dest    = Join-Path $ExtRoot $ExtensionId

    # Premiere locks extension files while it runs.
    $running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Adobe Premiere Pro*' }
    while ($running) {
        Say 'Adobe Premiere Pro is running. Close it, then press Enter to continue (or Ctrl+C to cancel).' Yellow
        [void](Read-Host)
        $running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Adobe Premiere Pro*' }
    }

    if ($Uninstall) {
        if (Test-Path -LiteralPath $Dest) {
            Remove-Item -LiteralPath $Dest -Recurse -Force
            Say "openClick removed from $Dest" Green
        } else {
            Say 'openClick is not installed for this user.' Yellow
        }
        exit 0
    }

    # Locate the extension files.
    $source  = $null
    $tempDir = $null
    $folder  = Join-Path $Here $ExtensionId
    if (Test-Path -LiteralPath (Join-Path $folder 'CSXS\manifest.xml')) {
        $source = $folder
    } else {
        $zxp = Get-ChildItem -LiteralPath $Here -Filter '*.zxp' -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $zxp) {
            throw "Neither a '$ExtensionId' folder nor an openClick .zxp file was found next to this installer."
        }
        $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('openClick-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tempDir | Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zxp.FullName, $tempDir)
        if (-not (Test-Path -LiteralPath (Join-Path $tempDir 'CSXS\manifest.xml'))) {
            throw "$($zxp.Name) does not contain a valid extension."
        }
        $source = $tempDir
    }

    if (-not (Test-Path -LiteralPath $ExtRoot)) {
        New-Item -ItemType Directory -Path $ExtRoot -Force | Out-Null
    }

    foreach ($old in $Retired) {
        $oldPath = Join-Path $ExtRoot $old
        if (Test-Path -LiteralPath $oldPath) {
            Remove-Item -LiteralPath $oldPath -Recurse -Force
            Say "Removed retired build: $old"
        }
    }

    if (Test-Path -LiteralPath $Dest) {
        Remove-Item -LiteralPath $Dest -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Dest | Out-Null
    Copy-Item -Path (Join-Path $source '*') -Destination $Dest -Recurse -Force

    # Files downloaded from the internet carry a "blocked" mark that can stop
    # Premiere from loading them.
    try { Get-ChildItem -LiteralPath $Dest -Recurse -File | Unblock-File } catch { }

    if ($tempDir) {
        try { Remove-Item -LiteralPath $tempDir -Recurse -Force } catch { }
    }

    # Allow the extension to load on every Premiere Pro version from 2022 on.
    # CSXS.11 = Premiere 2022-2024, CSXS.12 = 2025-2026; later keys are
    # included so future releases work without re-running this installer.
    foreach ($v in 9..16) {
        $key = "HKCU:\Software\Adobe\CSXS.$v"
        if (-not (Test-Path -LiteralPath $key)) {
            New-Item -Path $key | Out-Null
        }
        New-ItemProperty -LiteralPath $key -Name 'PlayerDebugMode' -Value '1' -PropertyType String -Force | Out-Null
    }

    if (-not (Test-Path -LiteralPath (Join-Path $Dest 'CSXS\manifest.xml'))) {
        throw 'Copy finished but the manifest is missing. Check antivirus or folder permissions.'
    }

    Say ''
    Say "openClick installed to $Dest" Green
    Say 'Start Premiere Pro and open Window > Extensions > openClick.'
    exit 0
}
catch {
    Say ''
    Say ('Installation failed: ' + $_.Exception.Message) Red
    exit 1
}
