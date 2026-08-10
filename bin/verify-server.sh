#!/usr/bin/env bash
set -euo pipefail

# The isolated dev server used for e2e verification and UI captures — never
# the user's own `bun dev`. Runs through direnv so .envrc env (HF_TOKEN, Xet)
# reaches the `hf` CLI the app spawns, with the dev-tools bubble hidden and a
# separate dist dir so the user's server is untouched. Runs in the foreground;
# stop it with Ctrl-C (or TaskStop). On exit it removes its own dist dir and
# puts back the tsconfig.json that `next dev` rewrites on every start.
#
# Usage:
#   bin/verify-server.sh [port]   # default port 3998

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$SCRIPT_DIR/..
cd "$REPO_ROOT"

PORT=${1:-3998}

# A dist dir per port, under the gitignored parent. Two verify servers on
# different ports then build into different places, and cleanup can only ever
# delete the build belonging to this run.
DIST=.next-verify/$PORT

# Refuse an occupied port before anything destructive is armed. This used to
# fall through to the cleanup trap, which deleted the dist dir of the server
# already on that port — out from under a process still serving from it.
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    echo "error: port $PORT is already in use." >&2
    echo "       Stop that server, or pass a different port." >&2
    exit 1
fi

# Keep tsconfig.json exactly as it stands now, whatever that is. Restoring the
# committed version instead would discard an uncommitted tsconfig change that
# was the user's own and nothing to do with this script.
TSCONFIG_BEFORE=$(mktemp)
cp tsconfig.json "$TSCONFIG_BEFORE"

cleanup() {
    rm -rf "$DIST"
    # Only when this run left it empty: a server still on another port owns it.
    rmdir .next-verify 2>/dev/null || true
    if ! cmp -s tsconfig.json "$TSCONFIG_BEFORE"; then
        cp "$TSCONFIG_BEFORE" tsconfig.json
    fi
    rm -f "$TSCONFIG_BEFORE"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

NEXT_DEV_INDICATORS=0 NEXT_DIST_DIR=$DIST direnv exec . \
    bunx next dev --port "$PORT"
