#!/usr/bin/env bash
set -euo pipefail

# Build Turbo Jumbo and ship it to a host as a new release of the systemd
# user unit in deploy/turbo-jumbo.service.
#
# Usage:
#   bin/deploy.sh [-n] [--skip-build]

usage() {
    cat <<'EOF'
Build Turbo Jumbo and ship it to a host as a new release.

Usage:
  bin/deploy.sh [-n] [--skip-build]

Options:
  -n, --dry-run   Build, then report what would be shipped without touching
                  the host.
      --skip-build
                  Ship the bundle from the last build instead of building.
                  The release is still stamped with the current HEAD.
  -h, --help      Print this help.

Settings come from .env at the repo root (or ENV_FILE=/path/to/env); see
deploy/env.sample. DEPLOY_HOST is required.

What a deploy does on the host, under ~/<DEPLOY_DIR> (default tj):
  releases/<stamp>/   the bundle: Next's standalone server on bun
  current             symlink to the release being served
  config.yaml         the app config — yours to put there, never shipped
  tj.env              optional per-host overrides of the unit's environment
It installs the unit, restarts it, waits for /api/v1/version to report the
shipped commit, and keeps the last DEPLOY_KEEP releases. To roll back, point
`current` at an older release and `systemctl --user restart turbo-jumbo`.
EOF
}

DRY_RUN=0
SKIP_BUILD=0
while (($#)); do
    case $1 in
    -h | --help)
        usage
        exit 0
        ;;
    -n | --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    *)
        echo "error: unrecognized argument '$1'" >&2
        echo "Usage: bin/deploy.sh [-n] [--skip-build]" >&2
        echo "For more information, try '--help'." >&2
        exit 2
        ;;
    esac
    shift
done

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
ENV_FILE=${ENV_FILE:-$REPO_ROOT/.env}
if [[ -f $ENV_FILE ]]; then
    # shellcheck source=/dev/null
    source "$ENV_FILE"
fi
: "${DEPLOY_HOST:?set DEPLOY_HOST in $ENV_FILE (see deploy/env.sample)}"
DEPLOY_DIR=${DEPLOY_DIR:-tj}
DEPLOY_PORT=${DEPLOY_PORT:-3000}
DEPLOY_KEEP=${DEPLOY_KEEP:-3}
UNIT=turbo-jumbo

cd "$REPO_ROOT"

# The release identity, by the rule bin/docker-build.sh and
# lib/version/app-version.ts share: the commit always, the tag only for a
# clean build of a tagged revision.
TJ_COMMIT=$(git rev-parse --short HEAD)
TJ_RELEASE=""
if [[ -z "$(git status --porcelain)" ]]; then
    TJ_RELEASE=$(git describe --tags --exact-match HEAD 2>/dev/null || true)
fi
STAMP=$(date +%Y%m%d-%H%M%S)-$TJ_COMMIT

# A build into its own dist dir, so the developer's .next (and a dev server
# reading it) is untouched. Next rewrites tsconfig.json on every build; put
# back whatever it was, whether or not the build succeeds.
#
# What ships is an allow-list staged from the standalone output, not the
# output wholesale: Next's file tracing pulls the repo root into it — the
# developer's config.yaml and hf_token.txt included.
DIST=.next-deploy
STANDALONE=$DIST/standalone
BUNDLE=$DIST/release
if ((!SKIP_BUILD)); then
    TSCONFIG_BEFORE=$(mktemp)
    cp tsconfig.json "$TSCONFIG_BEFORE"
    restore_tsconfig() {
        if ! cmp -s tsconfig.json "$TSCONFIG_BEFORE"; then
            cp "$TSCONFIG_BEFORE" tsconfig.json
        fi
        rm -f "$TSCONFIG_BEFORE"
    }
    trap restore_tsconfig EXIT
    echo "Building $STAMP…" >&2
    rm -rf "$DIST"
    NEXT_DIST_DIR=$DIST bun run build >&2
    restore_tsconfig
    trap - EXIT
    rm -rf "$BUNDLE"
    mkdir -p "$BUNDLE"
    cp -r "$STANDALONE/server.js" "$STANDALONE/package.json" \
        "$STANDALONE/node_modules" "$STANDALONE/$DIST" "$BUNDLE/"
    # The standalone server loads static assets and public/ from beside
    # itself; the build leaves them outside its output.
    cp -r "$DIST/static" "$BUNDLE/$DIST/static"
    cp -r public "$BUNDLE/public"
elif [[ ! -f $BUNDLE/server.js ]]; then
    echo "Error: no build to ship in $BUNDLE (run without --skip-build)" >&2
    exit 1
fi
printf 'TJ_COMMIT=%s\nTJ_RELEASE=%s\n' "$TJ_COMMIT" "$TJ_RELEASE" >"$BUNDLE/release.env"

# The unit, with the deploy dir substituted for its default.
UNIT_FILE=$(mktemp)
trap 'rm -f "$UNIT_FILE"' EXIT
sed "s|%h/tj/|%h/$DEPLOY_DIR/|g" deploy/$UNIT.service >"$UNIT_FILE"

REMOTE_RELEASE=$DEPLOY_DIR/releases/$STAMP
if ((DRY_RUN)); then
    echo "Would ship $BUNDLE ($(du -sh "$BUNDLE" | cut -f1)) to $DEPLOY_HOST:$REMOTE_RELEASE/" >&2
    echo "Would install ~/.config/systemd/user/$UNIT.service, switch $DEPLOY_DIR/current, restart $UNIT, and keep the last $DEPLOY_KEEP releases." >&2
    echo "dry-run $STAMP $DEPLOY_HOST"
    exit 0
fi

echo "Shipping to $DEPLOY_HOST:$REMOTE_RELEASE/…" >&2
ssh "$DEPLOY_HOST" "mkdir -p '$DEPLOY_DIR/releases' .config/systemd/user"
rsync -a --delete "$BUNDLE/" "$DEPLOY_HOST:$REMOTE_RELEASE/"
rsync -a "$UNIT_FILE" "$DEPLOY_HOST:.config/systemd/user/$UNIT.service"

echo "Switching $DEPLOY_DIR/current and restarting $UNIT…" >&2
# One remote shell for the switch, restart, health check and prune, so a
# failure stops before the prune and reports the journal.
ssh "$DEPLOY_HOST" bash -s -- "$DEPLOY_DIR" "$STAMP" "$UNIT" "$DEPLOY_PORT" "$DEPLOY_KEEP" "$TJ_COMMIT" <<'REMOTE'
set -euo pipefail
dir=$1 stamp=$2 unit=$3 port=$4 keep=$5 commit=$6
cd "$dir"
# An atomic switch: build the new link beside the old one, then rename over it.
ln -sfn "releases/$stamp" current.new
mv -T current.new current
systemctl --user daemon-reload
systemctl --user enable "$unit" >/dev/null 2>&1
systemctl --user restart "$unit"
for _ in $(seq 1 30); do
    if body=$(curl -sf "http://localhost:$port/api/v1/version" 2>/dev/null) \
        && [[ $body == *"\"commit\":\"$commit\""* ]]; then
        echo "$body"
        # Prune: oldest first, never the one now serving.
        ls -1 releases | sort | head -n "-$keep" | while read -r old; do
            [[ $old == "$stamp" ]] || rm -rf "releases/$old"
        done
        exit 0
    fi
    sleep 1
done
echo "Error: $unit did not report commit $commit on :$port within 30s" >&2
systemctl --user status "$unit" --no-pager >&2 || true
journalctl --user -u "$unit" -n 30 --no-pager >&2 || true
exit 1
REMOTE
echo "deployed $STAMP $DEPLOY_HOST"
