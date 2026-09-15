#!/usr/bin/env bash
# =============================================================================
# Smoke-test the packed npm tarball before publishing.
#
# Verifies the artifact a user installs:
#   1. Builds Pix.
#   2. Packs it into a tarball via npm pack.
#   3. Installs the tarball in an isolated temp directory.
#   4. Runs non-interactive Pix CLI commands from the installed package.
#   5. Confirms the external pi-tools-suite payload is present.
#
# Usage:
#   bash scripts/smoke-test-package.sh
#   npm run smoke-test
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SMOKE_TMPDIR="${SMOKE_TMPDIR:-}"

if [[ -t 1 ]]; then
	GREEN='\033[0;32m'; RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
else
	GREEN=''; RED=''; BOLD=''; RESET=''
fi

pass() { echo -e "  ${GREEN}✓${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1" >&2; }
banner() { echo -e "\n${BOLD}$1${RESET}"; }

WORK_DIR=""
TARBALL=""
cleanup() {
	if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
		rm -rf "$WORK_DIR"
	fi
	if [[ -n "$TARBALL" && -f "$REPO_ROOT/$TARBALL" ]]; then
		rm -f "$REPO_ROOT/$TARBALL"
	fi
}
trap cleanup EXIT

banner "Step 1/5: Building Pix..."
cd "$REPO_ROOT"
npm run build:pix

banner "Step 2/5: Packing tarball..."
TARBALL=$(npm pack --pack-destination "$REPO_ROOT" 2>&1 | tail -n1)
if [[ ! -f "$REPO_ROOT/$TARBALL" ]]; then
	fail "npm pack did not produce expected tarball (got: $TARBALL)"
	exit 1
fi
pass "Created $TARBALL"

banner "Step 3/5: Installing tarball in temp directory..."
if [[ -n "$SMOKE_TMPDIR" ]]; then
	WORK_DIR="$SMOKE_TMPDIR/pi-ui-extend-smoke-$$"
	mkdir -p "$WORK_DIR"
else
	WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pi-ui-extend-smoke-XXXXXX")
fi

cat > "$WORK_DIR/package.json" <<'PKGJSON'
{ "name": "pix-smoke-test-sandbox", "private": true, "version": "0.0.0" }
PKGJSON

npm install --prefix "$WORK_DIR" "$REPO_ROOT/$TARBALL" --ignore-scripts --no-save 2>&1
pass "Installed tarball in $WORK_DIR"

PKG_ROOT="$WORK_DIR/node_modules/pi-ui-extend"
ENTRY_JS="$PKG_ROOT/bin/pix.mjs"
BIN_PIX="$WORK_DIR/node_modules/.bin/pix"

if [[ ! -f "$ENTRY_JS" ]]; then
	fail "Pix entry point not found: $ENTRY_JS"
	exit 1
fi

if [[ ! -f "$PKG_ROOT/dist/main.js" ]]; then
	fail "Built renderer entry not found: $PKG_ROOT/dist/main.js"
	exit 1
fi

PIX_BIN_TARGET=$(node -e 'const fs = require("fs"); const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(pkg.bin?.pix ?? "");' "$PKG_ROOT/package.json")
LEGACY_BIN_TARGET=$(node -e 'const fs = require("fs"); const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(pkg.bin?.["pi-ui-extend"] ?? "");' "$PKG_ROOT/package.json")
if [[ "$PIX_BIN_TARGET" != "bin/pix.mjs" || "$LEGACY_BIN_TARGET" != "bin/pix.mjs" ]]; then
	fail "Packed package has invalid CLI bin metadata: pix=$PIX_BIN_TARGET pi-ui-extend=$LEGACY_BIN_TARGET"
	exit 1
fi
if [[ ! -x "$BIN_PIX" ]]; then
	fail "Installed Pix CLI shim not found or not executable: $BIN_PIX"
	exit 1
fi

banner "Step 4/5: Checking bundled payload..."
REQUIRED_FILES=(
	"$PKG_ROOT/dist/bundled-extensions/question/index.js"
	"$PKG_ROOT/dist/bundled-extensions/session-title/index.js"
	"$PKG_ROOT/dist/bundled-extensions/terminal-bell/index.js"
	"$PKG_ROOT/external/pi-tools-suite/index.ts"
	"$PKG_ROOT/external/pi-tools-suite/src/index.ts"
	"$PKG_ROOT/external/pi-tools-suite/package.json"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa.md"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser.md"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-auth.md"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-playwright.md"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-chrome-devtools.md"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui.md"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui-pty.md"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui-native-terminal.md"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop.md"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-macos.md"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-windows.md"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-linux.md"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/scripts/ui-qa-runner.mjs"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/browser/scripts/browser-qa-runner.mjs"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/browser/vendor/fflate.mjs"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/browser/vendor/fflate.LICENSE"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/browser/examples/qa-auth.example.jsonc"
	"$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/browser/examples/qa-flow.example.jsonc"
)

for required_file in "${REQUIRED_FILES[@]}"; do
	if [[ ! -f "$required_file" ]]; then
		fail "Missing package file: ${required_file#$PKG_ROOT/}"
		exit 1
	fi
done

GUIDE_OUTPUT=$(node "$PKG_ROOT/external/pi-tools-suite/src/async-subagents/agents/ui-qa/scripts/ui-qa-runner.mjs" guide --backend browser)
GUIDE_HEADER=${GUIDE_OUTPUT%%$'\n'*}
GUIDE_HEADER=${GUIDE_HEADER%$'\r'}
if [[ "$GUIDE_HEADER" != "# Browser backend router" ]] || [[ "$GUIDE_OUTPUT" == *"QA_AUTH_UPDATE_REQUIRED"* ]]; then
	fail "Packaged UI-QA runner did not return the isolated browser guide"
	exit 1
fi
pass "Renderer extensions, pi-tools-suite payload, and progressive UI-QA guides are present and runnable"

banner "Step 5/5: Running non-interactive Pix commands..."
ERRORS=0

smoke() {
	local desc="$1"; shift
	if "$@" 2>&1; then
		pass "$desc"
	else
		fail "$desc"
		((ERRORS++)) || true
	fi
}

smoke "installed pix shim --help" "$BIN_PIX" --help
smoke "pix update --help" node "$ENTRY_JS" update --help
smoke "pix install --help" node "$ENTRY_JS" install --help
smoke "pix update --check (offline)" env PI_OFFLINE=1 node "$ENTRY_JS" update --check

echo ""
if [[ $ERRORS -eq 0 ]]; then
	echo -e "${GREEN}${BOLD}All smoke tests passed.${RESET}"
	exit 0
else
	echo -e "${RED}${BOLD}$ERRORS smoke test(s) FAILED. Do NOT publish.${RESET}" >&2
	exit 1
fi
