<#
.SYNOPSIS
One-line Ashy installer: downloads AshySetup.exe (or uses local release build) and installs silently.

.DESCRIPTION
Usage:
    irm https://github.com/carlos-edu2367/ashy/releases/latest/download/install.ps1 | iex

Local usage:
    .\install.ps1
    .\install.ps1 -Version "1.0.0"
    .\install.ps1 -NoDesktopShortcut
    .\install.ps1 -NoLaunch
    .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [switch]$NoDesktopShortcut,
    [switch]$NoLaunch,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$repository = 'carlos-edu2367/ashy'
$base = if ($env:ASHY_RELEASE_BASE_URL) {
    $env:ASHY_RELEASE_BASE_URL.TrimEnd('/')
} else {
    "https://github.com/$repository/releases"
}

if ($Uninstall) {
    Write-Host "[Ashy] Searching for local uninstaller..." -ForegroundColor Cyan
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Ashy\Uninstall Ashy.exe'),
        (Join-Path $env:ProgramFiles 'Ashy\Uninstall Ashy.exe')
    )
    $uninstaller = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $uninstaller) {
        Write-Warning "Ashy uninstaller was not found in '$env:LOCALAPPDATA\Programs\Ashy' or '$env:ProgramFiles\Ashy'."
        return
    }
    Write-Host "[Ashy] Running silent uninstall: $uninstaller /S" -ForegroundColor Yellow
    $proc = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -Wait -NoNewWindow -PassThru
    if ($proc.ExitCode -ne 0) {
        throw "Ashy uninstaller failed (exit code $($proc.ExitCode))."
    }
    Write-Host "[Ashy] Uninstalled successfully." -ForegroundColor Green
    return
}

if ([string]::IsNullOrWhiteSpace($Version) -or $Version -eq 'latest') {
    $downloadUrl = "$base/latest/download/AshySetup.exe"
} else {
    $normalized = $Version.Trim().TrimStart('v', 'V')
    if ($normalized -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
        throw 'Version must use semantic version format, for example 1.0.0.'
    }
    $downloadUrl = "$base/download/v$normalized/AshySetup.exe"
}

$setup = Join-Path ([System.IO.Path]::GetTempPath()) "AshySetup-$PID.exe"

try {
    Write-Host "[Ashy] Cozy Night Studio Installer" -ForegroundColor Magenta
    $localReleaseSetup = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'apps\desktop\release\AshySetup.exe' } else { $null }
    $localDesktopPkg = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'apps\desktop\package.json' } else { $null }

    if ($localReleaseSetup -and (Test-Path -LiteralPath $localReleaseSetup) -and -not $env:ASHY_RELEASE_BASE_URL) {
        Write-Host "[Ashy] Using local compiled installer: $localReleaseSetup" -ForegroundColor Cyan
        Copy-Item -LiteralPath $localReleaseSetup -Destination $setup -Force
    } else {
        $downloaded = $false
        try {
            Write-Host "[Ashy] Downloading AshySetup.exe from $downloadUrl ..." -ForegroundColor Cyan
            Invoke-WebRequest -Uri $downloadUrl -OutFile $setup -MaximumRedirection 5 -UseBasicParsing
            $downloaded = $true
        } catch {
            if ($localDesktopPkg -and (Test-Path -LiteralPath $localDesktopPkg) -and -not $env:ASHY_RELEASE_BASE_URL) {
                Write-Host "[Ashy] Release asset not found online; building AshySetup.exe locally via pnpm dist:win ..." -ForegroundColor Yellow
                Push-Location $PSScriptRoot
                try {
                    & pnpm dist:win
                    if ($LASTEXITCODE -ne 0) {
                        throw "Local build 'pnpm dist:win' failed with exit code $LASTEXITCODE."
                    }
                } finally {
                    Pop-Location
                }
                if (Test-Path -LiteralPath $localReleaseSetup) {
                    Copy-Item -LiteralPath $localReleaseSetup -Destination $setup -Force
                    $downloaded = $true
                }
            }
            if (-not $downloaded) {
                throw "Could not download the Ashy installer from $downloadUrl ($($_.Exception.Message))."
            }
        }
    }

    if (-not (Test-Path -LiteralPath $setup)) {
        throw "Installer file was not found at '$setup'."
    }

    Write-Host "[Ashy] Installing Ashy silently (/S)..." -ForegroundColor Cyan
    $process = Start-Process -FilePath $setup -ArgumentList @('/S') -Wait -NoNewWindow -PassThru
    if ($process.ExitCode -ne 0) {
        throw "AshySetup.exe failed (exit code $($process.ExitCode))."
    }

    if ($NoDesktopShortcut) {
        $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Ashy.lnk'
        if (Test-Path -LiteralPath $desktopShortcut) {
            Remove-Item -LiteralPath $desktopShortcut -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Host "[Ashy] Installed successfully! Look for 'Ashy' in your Start Menu or Desktop." -ForegroundColor Green

    if (-not $NoLaunch -and -not $env:ASHY_RELEASE_BASE_URL) {
        $installedExe = Join-Path $env:LOCALAPPDATA 'Programs\Ashy\Ashy.exe'
        if (Test-Path -LiteralPath $installedExe) {
            Write-Host "[Ashy] Launching Ashy..." -ForegroundColor Cyan
            Start-Process -FilePath $installedExe
        }
    }
} finally {
    if (Test-Path -LiteralPath $setup) {
        Remove-Item -LiteralPath $setup -Force -ErrorAction SilentlyContinue
    }
}
