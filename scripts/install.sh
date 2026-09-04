#!/usr/bin/env sh
# Cube CLI - macOS & Linux Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/<owner>/cube-releases/main/install.sh | bash

set -eu

# Formatting helpers
RESET='\033[0m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
GRAY='\033[0;90m'
WHITE='\033[1;37m'

print_header() {
    printf "\n"
    printf "${CYAN}   _______   ${RESET}\n"
    printf "${CYAN}  /\\      \\  ${RESET}\n"
    printf "${CYAN} /  \\      \\ ${RESET}\n"
    printf "${CYAN}/    \\______\\${RESET}\n"
    printf "${CYAN}\\    /      /${RESET}\n"
    printf "${CYAN} \\  /      / ${RESET}\n"
    printf "${CYAN}  \\/______/  ${RESET}\n"
    printf "  ${WHITE}Cube CLI Installer${RESET} ${GRAY}[macOS/Linux]${RESET}\n\n"
}

log_info() {
    printf "  ${CYAN}•${RESET} ${GRAY}%s${RESET}\n" "$1"
}

log_success() {
    printf "  ${GREEN}✔${RESET} ${WHITE}%s${RESET}\n" "$1"
}

log_warn() {
    printf "  ${YELLOW}⚠${RESET} ${YELLOW}%s${RESET}\n" "$1"
}

log_error() {
    printf "  ${RED}✖${RESET} ${RED}%s${RESET}\n" "$1" >&2
    exit 1
}

print_header

# 1. Detect OS and Architecture
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Darwin)
        TARGET_OS="darwin"
        ;;
    Linux)
        TARGET_OS="linux"
        ;;
    *)
        log_error "Unsupported operating system: $OS"
        ;;
esac

case "$ARCH" in
    x86_64|amd64)
        TARGET_ARCH="x64"
        ;;
    arm64|aarch64)
        TARGET_ARCH="arm64"
        ;;
    *)
        log_error "Unsupported CPU architecture: $ARCH"
        ;;
esac

log_info "Detected platform: $TARGET_OS-$TARGET_ARCH"

# 2. Check Node.js prerequisite
log_info "Checking system prerequisites..."
if command -v node >/dev/null 2>&1; then
    NODE_VER="$(node -v)"
    log_success "Found Node.js ($NODE_VER)"
else
    log_warn "Node.js (>= 22.0.0) is recommended to run Cube."
    log_warn "Please install Node.js from https://nodejs.org/"
fi

# 3. Directories & Package configuration
REPO="${CUBE_REPO:-your-username/cube-releases}"
VERSION="${CUBE_VERSION:-latest}"
INSTALL_DIR="$HOME/.cube"
BIN_DIR="$INSTALL_DIR/bin"
PACKAGE_NAME="cube-${TARGET_OS}-${TARGET_ARCH}.tar.gz"

if [ -n "${CUBE_BASE_URL:-}" ]; then
    DOWNLOAD_URL="${CUBE_BASE_URL}/${PACKAGE_NAME}"
elif [ "$VERSION" = "latest" ]; then
    DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${PACKAGE_NAME}"
else
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${PACKAGE_NAME}"
fi

mkdir -p "$BIN_DIR"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

log_info "Downloading Cube package from:"
printf "    ${GRAY}%s${RESET}\n" "$DOWNLOAD_URL"

# 4. Download and extract
if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_DIR/$PACKAGE_NAME" || log_error "Failed to download package with curl."
elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TEMP_DIR/$PACKAGE_NAME" "$DOWNLOAD_URL" || log_error "Failed to download package with wget."
else
    log_error "Neither curl nor wget is available on this system."
fi
log_success "Download completed"

log_info "Extracting files to $BIN_DIR..."
tar -xzf "$TEMP_DIR/$PACKAGE_NAME" -C "$BIN_DIR" || log_error "Failed to extract archive."
chmod +x "$BIN_DIR/cube"
log_success "Extracted and granted execute permissions"

# 5. Shell PATH setup
setup_path() {
    RC_FILE=""
    if [ -n "${ZSH_VERSION:-}" ] || [ -f "$HOME/.zshrc" ]; then
        RC_FILE="$HOME/.zshrc"
    elif [ -n "${BASH_VERSION:-}" ] || [ -f "$HOME/.bashrc" ]; then
        RC_FILE="$HOME/.bashrc"
    elif [ -f "$HOME/.profile" ]; then
        RC_FILE="$HOME/.profile"
    fi

    EXPORT_LINE='export PATH="$HOME/.cube/bin:$PATH"'
    if [ -n "$RC_FILE" ] && [ -f "$RC_FILE" ]; then
        if ! grep -q '\.cube/bin' "$RC_FILE"; then
            printf "\n# Cube CLI\n%s\n" "$EXPORT_LINE" >> "$RC_FILE"
            log_success "Added Cube to PATH in $RC_FILE"
        else
            log_success "PATH is already configured in $RC_FILE"
        fi
    fi
}

setup_path

# 6. Finish
printf "\n"
printf "${CYAN}╭─────────────────────────────────────────────────────────────╮${RESET}\n"
printf "${CYAN}│${RESET}  ${WHITE}🎉 Cube CLI has been installed successfully!              ${RESET}${CYAN}│${RESET}\n"
printf "${CYAN}│${RESET}                                                             ${CYAN}│${RESET}\n"
printf "${CYAN}│${RESET}  ${GRAY}👉 Restart your terminal or run:                           ${RESET}${CYAN}│${RESET}\n"
printf "${CYAN}│${RESET}     ${GREEN}cube                                                    ${RESET}${CYAN}│${RESET}\n"
printf "${CYAN}╰─────────────────────────────────────────────────────────────╯${RESET}\n\n"
