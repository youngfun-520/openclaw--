#!/bin/bash
set -euo pipefail

# =============================================================================
# OpenClaw Fork Installer — youngfun-520/openclaw--
# =============================================================================
# This script installs OpenClaw from the fork repository (with dynamic prompt
# system and other enhancements) instead of the official npm package.
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/youngfun-520/openclaw--/main/install-fork.sh)
#
# Or download and run:
#   curl -fsSL -o install-fork.sh https://raw.githubusercontent.com/youngfun-520/openclaw--/main/install-fork.sh
#   bash install-fork.sh
#
# Options:
#   --branch <name>    Git branch to clone (default: main)
#   --dir <path>       Installation directory (default: ~/openclaw--)
#   --skip-build       Skip build step (use if already built)
#   --link             Create global symlink after build
#   --verbose          Show all output
#   NO_PROMPT=1        Skip interactive prompts
# =============================================================================

# Colors
BOLD='\033[1m'
ACCENT='\033[38;2;255;77;77m'
INFO='\033[38;2;136;146;176m'
SUCCESS='\033[38;2;0;229;204m'
WARN='\033[38;2;255;176;32m'
ERROR='\033[38;2;230;57;70m'
NC='\033[0m'

# Defaults
REPO="youngfun-520/openclaw--"
BRANCH="main"
INSTALL_DIR="$HOME/openclaw--"
SKIP_BUILD=0
CREATE_LINK=0
VERBOSE=0

TMPFILES=()
cleanup() {
    local f
    for f in "${TMPFILES[@]:-}"; do
        rm -rf "$f" 2>/dev/null || true
    done
}
trap cleanup EXIT

mktempf() {
    local f
    f="$(mktemp)"
    TMPFILES+=("$f")
    echo "$f"
}

# --- UI helpers ---
ui_info()    { echo -e "${INFO}[*]${NC} $*"; }
ui_success() { echo -e "${SUCCESS}[+]${NC} $*"; }
ui_warn()    { echo -e "${WARN}[!]${NC} $*"; }
ui_error()   { echo -e "${ERROR}[x]${NC} $*" >&2; }
ui_step()    { echo -e "\n${BOLD}${ACCENT}==>${NC} ${BOLD}$*${NC}"; }

# --- Parse arguments ---
for arg in "$@"; do
    case "$arg" in
        --branch=*)   BRANCH="${arg#*=}" ;;
        --dir=*)      INSTALL_DIR="${arg#*=}" ;;
        --skip-build) SKIP_BUILD=1 ;;
        --link)       CREATE_LINK=1 ;;
        --verbose)    VERBOSE=1 ;;
        -h|--help)
            head -25 "$0" | grep '^#' | sed 's/^# \?//'
            exit 0
            ;;
        *)
            ui_warn "Unknown option: $arg"
            ;;
    esac
done

banner() {
    echo -e "${ACCENT}${BOLD}"
    echo "  ___  ___ _       _ _    _ _        "
    echo " |  \\/  |(_)     (_) |  (_) |       "
    echo " | .  . | _  _ __  _| | ___| |_ ___  "
    echo " | |\\/| || || '_ \\| |/ / __| __/ __| "
    echo " | |  | || || | | |   <\\__ \\ |_\\__ \\ "
    echo " \\_|  |_/|_||_| |_|_|\\_\\___/\\__|___/ "
    echo -e "${NC}"
    echo -e "${INFO}Fork Build — youngfun-520/openclaw--${NC}"
    echo -e "${INFO}Dynamic Prompt System + Enhancements${NC}"
    echo ""
}

# --- Prerequisites ---
check_prereqs() {
    ui_step "Checking prerequisites"

    local missing=()

    if ! command -v node &>/dev/null; then
        missing+=("node")
    else
        local node_ver
        node_ver="$(node -v 2>/dev/null | sed 's/^v//' || true)"
        local node_major
        node_major="$(echo "$node_ver" | cut -d. -f1)"
        if [[ -n "$node_major" ]] && [[ "$node_major" -lt 22 ]]; then
            ui_error "Node.js >= 22.14 required (found v${node_ver})"
            ui_info  "Install via: https://nodejs.org/ or nvm install 24"
            exit 1
        fi
        ui_info "Node.js v${node_ver} found"
    fi

    if ! command -v git &>/dev/null; then
        missing+=("git")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        ui_error "Missing prerequisites: ${missing[*]}"
        exit 1
    fi

    # Check npm/pnpm/bun
    if command -v pnpm &>/dev/null; then
        PKG_MANAGER="pnpm"
    elif command -v npm &>/dev/null; then
        PKG_MANAGER="npm"
    else
        ui_error "No package manager found (npm or pnpm required)"
        exit 1
    fi
    ui_info "Package manager: ${PKG_MANAGER}"
}

# --- Clone or update ---
clone_repo() {
    ui_step "Fetching source code"

    if [[ -d "$INSTALL_DIR/.git" ]]; then
        ui_info "Existing checkout found at ${INSTALL_DIR}"
        cd "$INSTALL_DIR"
        git fetch origin "$BRANCH"
        git checkout "$BRANCH"
        git pull origin "$BRANCH"
        ui_success "Repository updated"
    else
        ui_info "Cloning ${REPO} (branch: ${BRANCH})..."
        git clone --branch "$BRANCH" --depth 1 "https://github.com/${REPO}.git" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
        ui_success "Repository cloned to ${INSTALL_DIR}"
    fi
}

# --- Install dependencies ---
install_deps() {
    ui_step "Installing dependencies"

    if [[ "$VERBOSE" == "1" ]]; then
        case "$PKG_MANAGER" in
            pnpm) pnpm install ;;
            npm)  npm install ;;
        esac
    else
        case "$PKG_MANAGER" in
            pnpm) pnpm install --silent 2>&1 | tail -5 ;;
            npm)  npm install --silent 2>&1 | tail -5 ;;
        esac
    fi

    ui_success "Dependencies installed"
}

# --- Build ---
build_project() {
    if [[ "$SKIP_BUILD" == "1" ]]; then
        ui_info "Skipping build (--skip-build)"
        return 0
    fi

    ui_step "Building OpenClaw (this may take a few minutes)"

    # Build UI first if available
    if grep -q '"ui:build"' package.json 2>/dev/null; then
        ui_info "Building UI..."
        case "$PKG_MANAGER" in
            pnpm) pnpm ui:build 2>&1 | tail -3 ;;
            npm)  npm run ui:build 2>&1 | tail -3 ;;
        esac
    fi

    # Main build
    if [[ "$VERBOSE" == "1" ]]; then
        case "$PKG_MANAGER" in
            pnpm) pnpm build ;;
            npm)  npm run build ;;
        esac
    else
        local log
        log="$(mktempf)"
        case "$PKG_MANAGER" in
            pnpm) pnpm build >"$log" 2>&1 ;;
            npm)  npm run build >"$log" 2>&1 ;;
        esac
        if [[ $? -ne 0 ]]; then
            ui_error "Build failed! Last 20 lines:"
            tail -20 "$log"
            exit 1
        fi
    fi

    ui_success "Build complete"
}

# --- Global link ---
global_link() {
    if [[ "$CREATE_LINK" == "1" ]]; then
        ui_step "Creating global symlink"
        case "$PKG_MANAGER" in
            pnpm)
                # pnpm link --global
                cd "$INSTALL_DIR"
                pnpm link --global 2>/dev/null || npm link
                ;;
            npm)
                cd "$INSTALL_DIR"
                npm link
                ;;
        esac
        ui_success "Global 'openclaw' command available"
    fi
}

# --- Verify ---
verify_install() {
    ui_step "Verifying installation"

    cd "$INSTALL_DIR"
    if [[ -f "openclaw.mjs" ]]; then
        ui_info "Entry point: openclaw.mjs"
    fi
    if [[ -d "dist" ]]; then
        ui_info "Build output: dist/ ($(find dist -name '*.js' 2>/dev/null | wc -l | tr -d ' ') JS files)"
    fi

    echo ""
    ui_success "Installation complete!"
    echo ""
    echo -e "${BOLD}Next steps:${NC}"
    echo ""
    echo -e "  ${INFO}1. cd ${INSTALL_DIR}${NC}"
    echo -e "  ${INFO}2. pnpm openclaw onboard --install-daemon${NC}    # First-time setup"
    echo -e "  ${INFO}3. pnpm openclaw gateway --port 18789${NC}        # Start gateway"
    echo -e "  ${INFO}4. pnpm openclaw agent --message \"Hello\"${NC}    # Test agent"
    echo ""
    echo -e "  ${INFO}Or use globally (with --link):${NC}"
    echo -e "  ${INFO}  openclaw onboard --install-daemon${NC}"
    echo ""
    echo -e "  ${WARN}Note: To enable Dynamic Prompt System, add to openclaw.json:${NC}"
    echo -e "  ${WARN}{ \"features\": { \"dynamicPrompt\": { \"enabled\": true } } }${NC}"
    echo ""

    # Dev loop hint
    echo -e "  ${INFO}Dev loop (auto-reload on source changes):${NC}"
    echo -e "  ${INFO}  pnpm gateway:watch${NC}"
    echo ""
}

# --- Main ---
main() {
    banner
    check_prereqs
    clone_repo
    install_deps
    build_project
    global_link
    verify_install
}

main "$@"
