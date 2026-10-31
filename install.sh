#!/usr/bin/env bash
# Ashy — One-Command Linux Installer & Updater (Orin-style)
# Usage:
#   curl -fsSL https://github.com/carlos-edu2367/ashy/releases/latest/download/install.sh | bash
#
# Options:
#   --version <ver>   Install a specific version (e.g. 1.0.0)
#   --uninstall       Remove Ashy from ~/.local/share/ashy and ~/.local/bin/ashy

set -euo pipefail

REPOSITORY="carlos-edu2367/ashy"
BASE_URL="${ASHY_RELEASE_BASE_URL:-https://github.com/${REPOSITORY}/releases}"
VERSION="latest"
UNINSTALL="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|-v)
      VERSION="${2:-latest}"
      shift 2
      ;;
    --uninstall|-u)
      UNINSTALL="true"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

INSTALL_DIR="${HOME}/.local/share/ashy"
BIN_DIR="${HOME}/.local/bin"
DESKTOP_DIR="${HOME}/.local/share/applications"
APPIMAGE_PATH="${INSTALL_DIR}/Ashy.AppImage"
SYMLINK_PATH="${BIN_DIR}/ashy"
DESKTOP_ENTRY="${DESKTOP_DIR}/ashy.desktop"

if [[ "${UNINSTALL}" == "true" ]]; then
  echo "🌙 Ashy — Removendo instalação local..."
  rm -f "${SYMLINK_PATH}" "${DESKTOP_ENTRY}"
  rm -rf "${INSTALL_DIR}"
  echo "✅ Ashy removida com sucesso."
  exit 0
fi

if [[ "${VERSION}" == "latest" || -z "${VERSION}" ]]; then
  DOWNLOAD_URL="${BASE_URL}/latest/download/Ashy-linux-x86_64.AppImage"
else
  NORMALIZED="${VERSION#v}"
  NORMALIZED="${NORMALIZED#V}"
  DOWNLOAD_URL="${BASE_URL}/download/v${NORMALIZED}/Ashy-linux-x86_64.AppImage"
fi

mkdir -p "${INSTALL_DIR}" "${BIN_DIR}" "${DESKTOP_DIR}"

TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/Ashy-XXXXXX.AppImage")"
trap 'rm -f "${TMP_FILE}"' EXIT

echo "✨ Ashy — Cozy Night Studio Installer (Linux)"
echo "⬇️  Baixando Ashy-linux-x86_64.AppImage de: ${DOWNLOAD_URL}"
curl -fsSL "${DOWNLOAD_URL}" -o "${TMP_FILE}"

mv "${TMP_FILE}" "${APPIMAGE_PATH}"
chmod +x "${APPIMAGE_PATH}"
ln -sf "${APPIMAGE_PATH}" "${SYMLINK_PATH}"

cat > "${DESKTOP_ENTRY}" <<EOF
[Desktop Entry]
Name=Ashy
Comment=Ashy — Local-first virtual companion with shared history and 2D stage
Exec=${APPIMAGE_PATH}
Terminal=false
Type=Application
Categories=Utility;
EOF

echo "✅ Ashy instalada em ${APPIMAGE_PATH}"
echo "🚀 Execute 'ashy' no terminal ou abra pelo lançador de aplicativos!"
