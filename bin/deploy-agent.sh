#!/usr/bin/env bash
set -euo pipefail

# Build the Rust storage agent and ship it to the containers that run it,
# restarting each and gating on the version it reports back.
#
# These containers do not run sshd, so nothing here reaches them directly:
# every remote step goes through the container's virtualisation host with
# `pct push` / `pct exec`. Which host holds which container is pinned in the
# targets file, never inferred from a guest's name — a sibling script once
# inferred it, went stale, and would have booted a MAC/IP twin onto the wire.
#
# PREREQUISITE, and it lives in another repo: the tj-agent systemd unit must
# start `<agent home>/current/tj-agent`. Where the unit still names a fixed
# binary path, switching `current` changes nothing and the old build keeps
# running. The unit is managed by ansible; fix it there first. This script
# reads the unit before it writes anything and refuses (exit 3) if it still
# points at a literal path.
#
# Usage:
#   bin/deploy-agent.sh [--dev|--prod] [--apply] [--agent NAME] [-y] [-v]

usage() {
    cat <<'EOF'
Build the storage agent and ship it to the containers that run it.

Usage:
  bin/deploy-agent.sh [--dev|--prod] [--apply] [--agent NAME] [-y] [-v]

Reports what it would do and changes nothing unless --apply is given.

Fleet (default: --dev):
      --dev       The development pair.
      --prod      The production pair. Prompts before doing anything.

Options:
      --apply     Actually deploy. Without it this is a dry run that prints
                  every remote command it would run.
  -n, --dry-run   Dry run, the default. Accepted so it can be passed
                  explicitly by a caller that does not want to assume.
      --agent NAME
                  Deploy to one agent of the fleet instead of all of them.
      --keep N    Releases to keep on each container (default 5). The one
                  `current` points at is never pruned.
      --build-host
                  Fetch the binary from the build host named in the targets
                  file instead of building here. Implied when this machine
                  has no Rust toolchain or no agent/ checkout. This one does
                  reach the build host on a dry run, to read the revision and
                  the binary; no container is contacted either way.
      --rev REV   Override the revision the release is named and gated on.
                  Only useful with --build-host, whose binary this script
                  did not build.
  -y, --yes       Do not prompt. Required for --apply --prod when stdin is
                  not a terminal.
  -v, --verbose   Print each remote command as it runs.
  -h, --help      Print this help.

Targets come from .env.agents at the repo root (override with
AGENTS_FILE=...). It is gitignored: this repository is mirrored publicly, so
host names and addresses must not be committed. Copy deploy/agents.sample and
fill it in.

Layout on each container, under the agent home from the targets file:
  releases/<UTC stamp>-<short rev>/tj-agent   the build being shipped
  current -> releases/<that one>              what the unit runs
  agent.yaml, agent.env, hf-token             rendered by ansible; never
                                              read, written or backed up here

The binary is staged into a fresh release directory rather than written over
the running one, which would fail with ETXTBSY. Everything created lands as
the agent's numeric uid/gid: the model store is NFS with sec=sys, so the
server trusts the numbers on the wire.

After the restart, /api/v1/version is polled until it reports the revision
just shipped. If it does not, `current` is rolled back to the previous
release, the unit is restarted again, and the run exits 4.

Exit codes:
  0  deployed (or reported, on a dry run)
  1  a step failed
  2  bad usage
  3  a unit still names a literal binary path (see PREREQUISITE above)
  4  an agent did not come back on the new build; rolled back

Examples:
  bin/deploy-agent.sh                      # what a dev deploy would do
  bin/deploy-agent.sh --apply              # deploy the dev pair
  bin/deploy-agent.sh --prod --apply       # deploy production, with a prompt
  bin/deploy-agent.sh --agent NAME --apply # one agent only
EOF
}

FLEET=dev
APPLY=0
ASSUME_YES=0
VERBOSE=0
ONE_AGENT=""
KEEP=5
USE_BUILD_HOST=0
REV_OVERRIDE=""

while (($#)); do
    case $1 in
    -h | --help)
        usage
        exit 0
        ;;
    --dev) FLEET=dev ;;
    --prod) FLEET=prod ;;
    --apply) APPLY=1 ;;
    -n | --dry-run) APPLY=0 ;;
    --agent)
        ONE_AGENT=${2-}
        [[ -n $ONE_AGENT ]] || {
            echo "error: --agent needs a name" >&2
            exit 2
        }
        shift
        ;;
    --keep)
        KEEP=${2-}
        [[ $KEEP =~ ^[0-9]+$ ]] || {
            echo "error: --keep needs a number" >&2
            exit 2
        }
        shift
        ;;
    --build-host) USE_BUILD_HOST=1 ;;
    --rev)
        REV_OVERRIDE=${2-}
        [[ -n $REV_OVERRIDE ]] || {
            echo "error: --rev needs a revision" >&2
            exit 2
        }
        shift
        ;;
    -y | --yes) ASSUME_YES=1 ;;
    -v | --verbose) VERBOSE=1 ;;
    *)
        echo "error: unrecognized argument '$1'" >&2
        echo "Usage: bin/deploy-agent.sh [--dev|--prod] [--apply] [--agent NAME] [-y] [-v]" >&2
        echo "For more information, try '--help'." >&2
        exit 2
        ;;
    esac
    shift
done

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

# ---- targets -------------------------------------------------------------

AGENTS_FILE=${AGENTS_FILE:-$REPO_ROOT/.env.agents}
if [[ ! -f $AGENTS_FILE ]]; then
    echo "error: no $AGENTS_FILE — copy deploy/agents.sample and fill it in" >&2
    exit 1
fi
# shellcheck source=/dev/null
source "$AGENTS_FILE"

for required in TJ_AGENTS PVE_SSH_USER PVE_SSH_KEY AGENT_UID AGENT_GID AGENT_HOME; do
    if [[ -z ${!required:-} ]]; then
        echo "error: $AGENTS_FILE does not set $required (see deploy/agents.sample)" >&2
        exit 1
    fi
done
AGENT_PORT=${AGENT_PORT:-3900}
AGENT_UNIT=${AGENT_UNIT:-tj-agent}
AGENT_USER=${AGENT_USER:-tj}

# Rows of the targets table for this fleet, as "vmid name pve_host ct_ip".
targets() {
    local vmid name pve ip fleet
    for row in "${TJ_AGENTS[@]}"; do
        read -r vmid name pve ip fleet <<<"$row"
        [[ $fleet == "$FLEET" ]] || continue
        [[ -z $ONE_AGENT || $name == "$ONE_AGENT" ]] || continue
        echo "$vmid $name $pve $ip"
    done
}

if [[ -z $(targets) ]]; then
    if [[ -n $ONE_AGENT ]]; then
        echo "error: no agent named '$ONE_AGENT' in the $FLEET fleet" >&2
    else
        echo "error: no $FLEET agents in $AGENTS_FILE" >&2
    fi
    exit 1
fi

# ---- consent -------------------------------------------------------------

# Asked before the build, so a refusal costs nothing and a machine that cannot
# ask is told so rather than left waiting at a prompt nobody will answer.
if ((APPLY)) && [[ $FLEET == prod ]] && ((!ASSUME_YES)); then
    names=$(targets | awk '{print $2}' | paste -sd, -)
    if [[ ! -t 0 ]]; then
        echo "error: --apply --prod needs -y when stdin is not a terminal" >&2
        exit 2
    fi
    echo "About to deploy to PRODUCTION: $names" >&2
    read -r -p "Continue? [y/N] " reply
    case $reply in
    y | Y | yes | YES) ;;
    *)
        echo "Aborted." >&2
        exit 1
        ;;
    esac
fi

# ---- the build -----------------------------------------------------------

if ((!USE_BUILD_HOST)); then
    if ! command -v cargo >/dev/null 2>&1 || [[ ! -f agent/Cargo.toml ]]; then
        USE_BUILD_HOST=1
    fi
fi

BIN=""
REV=""
if ((USE_BUILD_HOST)); then
    [[ -n ${BUILD_HOST:-} && -n ${BUILD_CHECKOUT:-} ]] || {
        echo "error: --build-host needs BUILD_HOST and BUILD_CHECKOUT in $AGENTS_FILE" >&2
        exit 1
    }
    # The checkout belongs to another account on that host, so both the
    # revision and the binary come out through sudo rather than as this login.
    REV=${REV_OVERRIDE:-$(ssh "$BUILD_HOST" \
        "sudo git -C $BUILD_CHECKOUT rev-parse --short HEAD")}
    BIN=$(mktemp -t tj-agent.XXXXXX)
    trap 'rm -f "$BIN"' EXIT
    echo "Fetching tj-agent $REV from the build host…" >&2
    ssh "$BUILD_HOST" "sudo cat $BUILD_CHECKOUT/agent/target/release/tj-agent" >"$BIN"
    chmod 755 "$BIN"
else
    REV=${REV_OVERRIDE:-$(git rev-parse --short HEAD)}
    echo "Building tj-agent $REV…" >&2
    # Stamped, because the version gate below is the whole point: an unstamped
    # build reports a null commit and could never be told from any other.
    TJ_AGENT_COMMIT=$REV cargo build --release --manifest-path agent/Cargo.toml >&2
    BIN=agent/target/release/tj-agent
fi

[[ -s $BIN ]] || {
    echo "error: no agent binary at $BIN" >&2
    exit 1
}
STAMP=$(date -u +%Y%m%d-%H%M%S)-$REV
RELEASE=$AGENT_HOME/releases/$STAMP

# ---- remote plumbing -----------------------------------------------------

# Every remote step is rendered before it runs, so a dry run is a transcript
# an operator can read and paste rather than a description of one. The string
# shown is the string handed to ssh, not a prettier retelling of it.
show() { echo "    $*" >&2; }

# Single-quote a command for the shell inside the container. Nothing built
# here contains a single quote; the escape is there so a hand-edited targets
# file cannot quietly change what runs.
sq() {
    if [[ $1 == *"'"* ]]; then
        printf '%q' "$1"
    else
        printf "'%s'" "$1"
    fi
}

# Double-quote a command for display, escaping only what a double-quoted shell
# word would otherwise eat. The result is what an operator would type, and
# pasting it runs exactly what this script runs.
dq() {
    local s=$1
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    s=${s//\$/\\\$}
    s=${s//\`/\\\`}
    printf '"%s"' "$s"
}

pve_ssh() { # pve_ssh <pve host> <command string>
    local host=$1 cmd=$2
    show "ssh $PVE_SSH_USER@$host $(dq "$cmd")"
    ((APPLY)) || return 0
    ssh -i "$PVE_SSH_KEY" -o BatchMode=yes "$PVE_SSH_USER@$host" "$cmd"
}

# Run a command inside the container as the agent's own account. The unit is a
# *user* unit with linger on, so /run/user/<uid> exists with nobody logged in —
# but there is no session bus unless XDG_RUNTIME_DIR says where it is.
ct_exec() { # ct_exec <pve host> <vmid> <shell command>
    local host=$1 vmid=$2 inner=$3
    pve_ssh "$host" "sudo pct exec $vmid -- su - $AGENT_USER -c $(sq "$inner")"
}

as_agent() { # wrap a command with the user-bus environment the unit needs
    echo "XDG_RUNTIME_DIR=/run/user/$AGENT_UID $1"
}

# A dry run reaches nothing at all, not even for a read: whether to touch a
# lab machine is the operator's call, and --apply is where she makes it.
version_of() { # version_of <ct ip> -> the /api/v1/version body, or empty
    ((APPLY)) || return 0
    curl -sf --max-time 5 "http://$1:$AGENT_PORT/api/v1/version" 2>/dev/null || true
}

# ---- preflight -----------------------------------------------------------

# The unit has to run the release the symlink points at, or shipping one is
# theatre. Read what it actually starts and refuse on the literal path.
check_execstart() { # check_execstart <pve host> <vmid> <name>
    local host=$1 vmid=$2 name=$3
    local cmd
    cmd=$(as_agent "systemctl --user show -p ExecStart --value $AGENT_UNIT")
    if ((!APPLY)); then
        ct_exec "$host" "$vmid" "$cmd"
        show "# refuses here unless ExecStart is $AGENT_HOME/current/tj-agent"
        return 0
    fi
    local out
    out=$(ct_exec "$host" "$vmid" "$cmd") || {
        echo "Error: could not read the $AGENT_UNIT unit on $name" >&2
        exit 1
    }
    if [[ $out != *"$AGENT_HOME/current/tj-agent"* ]]; then
        cat >&2 <<EOF
Error: $name still starts a fixed path, so switching \`current\` would change
       nothing and the old build would keep running.

       ExecStart is: ${out:-<empty>}
       it must be:   $AGENT_HOME/current/tj-agent

       The unit is managed by ansible in the infra repo — fix it there and
       re-run. Nothing has been written to $name.
EOF
        exit 3
    fi
}

# ---- deploy one agent ----------------------------------------------------

deploy_one() { # deploy_one <vmid> <name> <pve host> <ct ip>
    local vmid=$1 name=$2 host=$3 ip=$4
    echo "== $name (container $vmid on $host)" >&2

    check_execstart "$host" "$vmid" "$name"

    local before previous
    if ((APPLY)); then
        before=$(version_of "$ip")
        echo "  before: ${before:-<no answer on :$AGENT_PORT>}" >&2
    else
        show "curl http://$ip:$AGENT_PORT/api/v1/version    # before"
    fi

    # What to fall back to if the new build does not come up.
    previous=""
    if ((APPLY)); then
        previous=$(ct_exec "$host" "$vmid" \
            "readlink $AGENT_HOME/current 2>/dev/null || true") || true
        previous=${previous##*/}
    else
        ct_exec "$host" "$vmid" "readlink $AGENT_HOME/current"
    fi

    # pct push writes a file and only a file: the directory has to exist, and
    # making it as the agent is what gives it the right owner.
    ct_exec "$host" "$vmid" "mkdir -p $RELEASE"

    local staged=/tmp/tj-agent-$STAMP
    show "scp $BIN $PVE_SSH_USER@$host:$staged"
    if ((APPLY)); then
        scp -q -i "$PVE_SSH_KEY" -o BatchMode=yes "$BIN" "$PVE_SSH_USER@$host:$staged"
    fi
    # Numeric ids, deliberately: the container's id map punches these exact
    # numbers through, and the NFS server trusts them on the wire. Names here
    # would resolve against the wrong passwd file.
    pve_ssh "$host" "sudo pct push $vmid $staged $RELEASE/tj-agent \
--perms 755 --user $AGENT_UID --group $AGENT_GID && rm -f $staged"

    ct_exec "$host" "$vmid" \
        "$(as_agent "ln -sfn $RELEASE $AGENT_HOME/current && systemctl --user restart $AGENT_UNIT")"

    # Oldest first, and never what `current` resolves to — which is why the
    # live release is read back here rather than assumed to be this one.
    local prune="cd $AGENT_HOME/releases && live=\$(readlink ../current) && live=\${live##*/} && ls -1 | sort | head -n -$KEEP | while read -r old; do [ \"\$old\" = \"\$live\" ] || rm -rf \"\$old\"; done"

    # Poll rather than sleep: the agent is up when it says so.
    if ((!APPLY)); then
        show "# then poll http://$ip:$AGENT_PORT/api/v1/version for commit $REV"
        show "# on failure, roll current back to the previous release and restart"
        ct_exec "$host" "$vmid" "$prune"
        # Same shape on stdout as a real run, so a plan diffs against a result.
        echo "dry-run agent $STAMP $name"
        return 0
    fi

    local after=""
    for _ in $(seq 1 30); do
        after=$(version_of "$ip")
        [[ $after == *"\"commit\":\"$REV\""* ]] && break
        after=""
        sleep 1
    done

    if [[ -z $after ]]; then
        echo "Error: $name did not report commit $REV within 30s" >&2
        if [[ -n $previous ]]; then
            echo "Rolling $name back to $previous…" >&2
            ct_exec "$host" "$vmid" \
                "$(as_agent "ln -sfn $AGENT_HOME/releases/$previous $AGENT_HOME/current && systemctl --user restart $AGENT_UNIT")" || true
            echo "  rolled back: $(version_of "$ip")" >&2
        else
            echo "  no previous release to roll back to; $name is left on $STAMP" >&2
        fi
        exit 4
    fi

    echo "  after:  $after" >&2
    ct_exec "$host" "$vmid" "$prune"
    echo "deployed agent $STAMP $name"
}

# ---- go ------------------------------------------------------------------

((APPLY)) || echo "Dry run — nothing will be changed. Add --apply to deploy." >&2
echo "Fleet: $FLEET · release: $STAMP" >&2

while read -r vmid name host ip; do
    deploy_one "$vmid" "$name" "$host" "$ip"
done < <(targets)
