#!/usr/bin/env bash
set -euo pipefail

# Build Turbo Jumbo and ship it to its hosts as a new release of the systemd
# user units in deploy/: the Next app (turbo-jumbo.service) to DEPLOY_HOST, and
# the Rust storage agent (tj-agent.service) to each of AGENT_HOSTS.
#
# Usage:
#   bin/deploy.sh [-n] [--skip-build] [--app] [--agents]

usage() {
    cat <<'EOF'
Build Turbo Jumbo and ship it to its hosts as a new release.

Usage:
  bin/deploy.sh [-n] [--skip-build] [--app] [--agents]

Targets (default: whatever .env configures — the app if DEPLOY_HOST is set,
the agents if AGENT_HOSTS is set):
      --app       Deploy only the Next app to DEPLOY_HOST.
      --agents    Deploy only the storage agent to AGENT_HOSTS.

Options:
  -n, --dry-run   Build, then report what would be shipped without touching
                  any host.
      --skip-build
                  Ship the last build instead of building. The release is
                  still stamped with the current HEAD.
  -h, --help      Print this help.

Settings come from .env.prod at the repo root — so a plain run deploys
production. Any other fleet names its own file:

      ENV_FILE=.env.dev bin/deploy.sh --agents

See deploy/env.sample for every setting and its default.

The app (DEPLOY_HOST), under ~/<DEPLOY_DIR> (default tj):
  releases/<stamp>/   the bundle: Next's standalone server on bun
  current             symlink to the release being served
  config.yaml         the app config — yours to put there, never shipped
  tj.env              optional per-host overrides of the unit's environment

Each agent (a host in AGENT_HOSTS), under ~/<AGENT_DIR> (default tj-agent):
  releases/<stamp>/   the release dir holding the tj-agent binary
  current             symlink to the release being run
  agent.yaml          port, token, roots — yours to put there, never shipped
  agent.env           optional: the hf CLI's PATH/HF_TOKEN/Xet for downloads

Both install the unit, restart it, wait for /api/v1/version to report the
shipped commit, and keep the last DEPLOY_KEEP / AGENT_KEEP releases. To roll
back, point `current` at an older release and restart the unit.
EOF
}

DRY_RUN=0
SKIP_BUILD=0
DO_APP=0
DO_AGENTS=0
while (($#)); do
    case $1 in
    -h | --help)
        usage
        exit 0
        ;;
    -n | --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --app) DO_APP=1 ;;
    --agents) DO_AGENTS=1 ;;
    *)
        echo "error: unrecognized argument '$1'" >&2
        echo "Usage: bin/deploy.sh [-n] [--skip-build] [--app] [--agents]" >&2
        echo "For more information, try '--help'." >&2
        exit 2
        ;;
    esac
    shift
done

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
ENV_FILE=${ENV_FILE:-$REPO_ROOT/.env.prod}

# The env file alone decides which fleet a run targets, so whatever the
# surrounding shell exports — a direnv .envrc, most likely — is dropped first.
# Otherwise a key merely *missing* from .env.dev would quietly fall through to
# the ambient value and ship a dev deploy at production, which is exactly the
# mistake this split exists to prevent. Say so rather than doing it silently:
# an ignored value is surprising precisely when it used to be what worked.
DEPLOY_SETTINGS=(
    DEPLOY_HOST DEPLOY_DIR DEPLOY_PORT DEPLOY_KEEP
    AGENT_HOSTS AGENT_DIR AGENT_PORT AGENT_KEEP AGENT_TARGET
)
ignored=()
for setting in "${DEPLOY_SETTINGS[@]}"; do
    if [[ -n ${!setting:-} ]]; then
        ignored+=("$setting")
        unset "$setting"
    fi
done
if ((${#ignored[@]})); then
    echo "note: ignoring ${ignored[*]} from the environment — $(basename "$ENV_FILE") decides the fleet" >&2
fi

if [[ -f $ENV_FILE ]]; then
    # shellcheck source=/dev/null
    source "$ENV_FILE"
else
    echo "error: no $ENV_FILE (see deploy/env.sample)" >&2
    exit 1
fi

DEPLOY_DIR=${DEPLOY_DIR:-tj}
DEPLOY_PORT=${DEPLOY_PORT:-3000}
DEPLOY_KEEP=${DEPLOY_KEEP:-3}
UNIT=turbo-jumbo

AGENT_DIR=${AGENT_DIR:-tj-agent}
AGENT_PORT=${AGENT_PORT:-3900}
AGENT_KEEP=${AGENT_KEEP:-$DEPLOY_KEEP}
# Fully static by default so one binary runs on any of the storage boxes
# regardless of their libc; the agent has no TLS, so musl builds with no extra
# toolchain (rustup target add x86_64-unknown-linux-musl, once). Set
# AGENT_TARGET= (empty) to build for the host's native target instead.
AGENT_TARGET=${AGENT_TARGET-x86_64-unknown-linux-musl}

# Default targets: the app when a host is configured, the agents when hosts are.
# An explicit --app/--agents overrides.
if ((!DO_APP && !DO_AGENTS)); then
    [[ -n ${DEPLOY_HOST:-} ]] && DO_APP=1
    [[ -n ${AGENT_HOSTS:-} ]] && DO_AGENTS=1
fi
if ((!DO_APP && !DO_AGENTS)); then
    echo "error: nothing to deploy — set DEPLOY_HOST and/or AGENT_HOSTS in $ENV_FILE (see deploy/env.sample)" >&2
    exit 2
fi
((!DO_APP)) || : "${DEPLOY_HOST:?set DEPLOY_HOST in $ENV_FILE to deploy the app (see deploy/env.sample)}"
((!DO_AGENTS)) || : "${AGENT_HOSTS:?set AGENT_HOSTS in $ENV_FILE to deploy agents (see deploy/env.sample)}"

cd "$REPO_ROOT"

# The release identity, by the rule bin/docker-build.sh and
# lib/version/app-version.ts share: the commit always, the tag only for a
# clean build of a tagged revision. Shared by the app and the agent so a
# single deploy stamps both with the same commit.
TJ_COMMIT=$(git rev-parse --short HEAD)
TJ_RELEASE=""
if [[ -z "$(git status --porcelain)" ]]; then
    TJ_RELEASE=$(git describe --tags --exact-match HEAD 2>/dev/null || true)
fi
STAMP=$(date +%Y%m%d-%H%M%S)-$TJ_COMMIT

# ---- the app -------------------------------------------------------------

DIST=.next-deploy
STANDALONE=$DIST/standalone
BUNDLE=$DIST/release

build_app() {
    # A build into its own dist dir, so the developer's .next (and a dev server
    # reading it) is untouched. Next rewrites tsconfig.json on every build; put
    # back whatever it was, whether or not the build succeeds.
    #
    # What ships is an allow-list staged from the standalone output, not the
    # output wholesale: Next's file tracing pulls the repo root into it — the
    # developer's config.yaml and hf_token.txt included.
    local TSCONFIG_BEFORE
    TSCONFIG_BEFORE=$(mktemp)
    cp tsconfig.json "$TSCONFIG_BEFORE"
    restore_tsconfig() {
        if ! cmp -s tsconfig.json "$TSCONFIG_BEFORE"; then
            cp "$TSCONFIG_BEFORE" tsconfig.json
        fi
        rm -f "$TSCONFIG_BEFORE"
    }
    trap restore_tsconfig EXIT
    echo "Building app $STAMP…" >&2
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
}

deploy_app() {
    if ((!SKIP_BUILD)); then
        build_app
    elif [[ ! -f $BUNDLE/server.js ]]; then
        echo "Error: no app build to ship in $BUNDLE (run without --skip-build)" >&2
        exit 1
    fi
    printf 'TJ_COMMIT=%s\nTJ_RELEASE=%s\n' "$TJ_COMMIT" "$TJ_RELEASE" >"$BUNDLE/release.env"

    local REMOTE_RELEASE=$DEPLOY_DIR/releases/$STAMP
    if ((DRY_RUN)); then
        echo "Would ship $BUNDLE ($(du -sh "$BUNDLE" | cut -f1)) to $DEPLOY_HOST:$REMOTE_RELEASE/" >&2
        echo "Would install ~/.config/systemd/user/$UNIT.service, switch $DEPLOY_DIR/current, restart $UNIT, and keep the last $DEPLOY_KEEP releases." >&2
        echo "dry-run app $STAMP $DEPLOY_HOST"
        return
    fi

    # The unit, with the deploy dir substituted for its default.
    local UNIT_FILE
    UNIT_FILE=$(mktemp)
    sed "s|%h/tj/|%h/$DEPLOY_DIR/|g" deploy/$UNIT.service >"$UNIT_FILE"

    echo "Shipping app to $DEPLOY_HOST:$REMOTE_RELEASE/…" >&2
    ssh "$DEPLOY_HOST" "mkdir -p '$DEPLOY_DIR/releases' .config/systemd/user"
    rsync -a --delete "$BUNDLE/" "$DEPLOY_HOST:$REMOTE_RELEASE/"
    rsync -a "$UNIT_FILE" "$DEPLOY_HOST:.config/systemd/user/$UNIT.service"
    rm -f "$UNIT_FILE"

    echo "Switching $DEPLOY_DIR/current and restarting $UNIT…" >&2
    remote_activate "$DEPLOY_HOST" "$DEPLOY_DIR" "$UNIT" "$DEPLOY_PORT" "$DEPLOY_KEEP"
    echo "deployed app $STAMP $DEPLOY_HOST"
}

# ---- the agent -----------------------------------------------------------

agent_bin() {
    if [[ -n $AGENT_TARGET ]]; then
        echo "agent/target/$AGENT_TARGET/release/tj-agent"
    else
        echo "agent/target/release/tj-agent"
    fi
}

build_agent() {
    echo "Building agent $STAMP (${AGENT_TARGET:-native})…" >&2
    local args=(build --release --manifest-path agent/Cargo.toml)
    [[ -n $AGENT_TARGET ]] && args+=(--target "$AGENT_TARGET")
    TJ_AGENT_COMMIT=$TJ_COMMIT TJ_AGENT_RELEASE=$TJ_RELEASE cargo "${args[@]}" >&2
}

deploy_agent_to() {
    local host=$1
    local bin
    bin=$(agent_bin)
    if [[ ! -f $bin ]]; then
        echo "Error: no agent build at $bin (run without --skip-build)" >&2
        exit 1
    fi

    local REMOTE_RELEASE=$AGENT_DIR/releases/$STAMP
    if ((DRY_RUN)); then
        echo "Would ship $bin ($(du -h "$bin" | cut -f1)) to $host:$REMOTE_RELEASE/tj-agent" >&2
        echo "Would install ~/.config/systemd/user/tj-agent.service, switch $AGENT_DIR/current, restart tj-agent, and keep the last $AGENT_KEEP releases." >&2
        echo "dry-run agent $STAMP $host"
        return
    fi

    # The unit, with the agent dir substituted for its default. `%h/tj-agent`
    # has no trailing slash at WorkingDirectory, so match the bare prefix.
    local UNIT_FILE
    UNIT_FILE=$(mktemp)
    sed "s|%h/tj-agent|%h/$AGENT_DIR|g" deploy/tj-agent.service >"$UNIT_FILE"

    echo "Shipping agent to $host:$REMOTE_RELEASE/…" >&2
    ssh "$host" "mkdir -p '$REMOTE_RELEASE' .config/systemd/user"
    rsync -a "$bin" "$host:$REMOTE_RELEASE/tj-agent"
    rsync -a "$UNIT_FILE" "$host:.config/systemd/user/tj-agent.service"
    rm -f "$UNIT_FILE"

    echo "Switching $AGENT_DIR/current and restarting tj-agent on $host…" >&2
    remote_activate "$host" "$AGENT_DIR" tj-agent "$AGENT_PORT" "$AGENT_KEEP"
    echo "deployed agent $STAMP $host"
}

# ---- shared activation ---------------------------------------------------

# Switch `current`, restart the unit, wait for /api/v1/version to report the
# shipped commit, and prune old releases — one remote shell so a failure stops
# before the prune and reports the journal. Identical for the app and agents:
# both lay out releases/<stamp> + current and answer /api/v1/version.
remote_activate() {
    local host=$1 dir=$2 unit=$3 port=$4 keep=$5
    ssh "$host" bash -s -- "$dir" "$STAMP" "$unit" "$port" "$keep" "$TJ_COMMIT" <<'REMOTE'
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
}

# ---- run -----------------------------------------------------------------

if ((DO_APP)); then
    deploy_app
fi
if ((DO_AGENTS)); then
    ((SKIP_BUILD)) || build_agent
    for host in $AGENT_HOSTS; do
        deploy_agent_to "$host"
    done
fi
