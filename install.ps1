# Ashy — One-Command Windows Installer & Updater (Orin-style)
# Usage:
#   irm https://github.com/carlos-edu2367/ashy/releases/latest/download/install.ps1 | iex
#
# Parameters (when invoked as script):
#   .\install.ps1 -Version "1.0.0"
#   .\install.ps1 -NoDesktopShortcut
#   .\install.ps1 -Uninstall

param(
  [string]$Version = 'latest',
  [switch]$NoDesktopShortcut,
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
  Write-Host "🌙 Ashy — Procurando desinstalador local..." -ForegroundColor Cyan
  $candidates = @(
    Join-Path $env:LOCALAPPDATA "Programs\Ashy\Uninstall Ashy.exe"
    Join-Path $env:ProgramFiles "Ashy\Uninstall Ashy.exe"
  )
  $uninstaller = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $uninstaller) {
    Write-Warning "Desinstalador da Ashy não encontrado em '$env:LOCALAPPDATA\Programs\Ashy' ou '$env:ProgramFiles\Ashy'."
    return
  }
  Write-Host "Executando desinstalação silenciosa: $uninstaller /S" -ForegroundColor Yellow
  $proc = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -Wait -NoNewWindow -PassThru
  if ($proc.ExitCode -ne 0) {
    throw "Falha ao desinstalar a Ashy (ExitCode: $($proc.ExitCode))."
  }
  Write-Host "✅ Ashy removida com sucesso." -ForegroundColor Green
  return
}

$downloadUrl = if ([string]::IsNullOrWhiteSpace($Version) -or $Version -eq 'latest') {
  "$base/latest/download/AshySetup.exe"
} else {
  $normalized = $Version.TrimStart('v', 'V')
  "$base/download/v$normalized/AshySetup.exe"
}

$setup = Join-Path $env:TEMP "AshySetup-$PID.exe"

try {
  Write-Host "✨ Ashy — Cozy Night Studio Installer" -ForegroundColor Magenta
  Write-Host "⬇️  Baixando AshySetup.exe de: $downloadUrl" -ForegroundColor Cyan
  Invoke-WebRequest -Uri $downloadUrl -OutFile $setup -UseBasicParsing

  if (-not (Test-Path $setup)) {
    throw "O instalador não foi salvo em '$setup'."
  }

  Write-Host "🚀 Instalando Ashy silenciosamente (/S)..." -ForegroundColor Cyan
  $proc = Start-Process -FilePath $setup -ArgumentList @('/S') -Wait -NoNewWindow -PassThru
  if ($proc.ExitCode -ne 0) {
    throw "O instalador AshySetup.exe falhou com código de saída $($proc.ExitCode)."
  }

  if ($NoDesktopShortcut) {
    $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Ashy.lnk'
    if (Test-Path $desktopShortcut) {
      Remove-Item -Path $desktopShortcut -Force -ErrorAction SilentlyContinue
    }
  }

  Write-Host "✅ Ashy instalada com sucesso! Procure por 'Ashy' no Menu Iniciar ou Área de Trabalho." -ForegroundColor Green
} finally {
  if (Test-Path $setup) {
    Remove-Item -Path $setup -Force -ErrorAction SilentlyContinue
  }
}
