#!/usr/bin/env bash
set -euo pipefail

# Compile the `tj` CLI into standalone binaries, one per platform, each
# stamped with this checkout's release identity, plus a SHA256SUMS file.
#
# Usage:
#   bin/build-cli.sh [--out-dir DIR] [TARGET...]

ALL_TARGETS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64)
# What a deploy and a release carry when no target is named: each binary is
# ~60-110 MB, so only the platforms someone actually runs it on.
DEFAULT_TARGETS=(darwin-arm64)

usage() {
    cat <<EOF
Compile the tj CLI into standalone binaries, one per platform.

Usage:
  bin/build-cli.sh [--out-dir DIR] [TARGET...]

Each binary embeds the Bun runtime, so the machine running it needs nothing
installed. Binaries are named tj-<target> (tj-windows-x64.exe on Windows) and
listed with their hashes in DIR/SHA256SUMS. Their paths are printed to stdout.

Options:
  --out-dir DIR   Write the binaries here (default: build/cli). SHA256SUMS
                  there is rewritten to list only this run's binaries.
  -h, --help      Print this help

Targets (default: ${DEFAULT_TARGETS[*]}):
  ${ALL_TARGETS[*]}

The binaries report this checkout's commit from 'tj --version -v', and only
a clean checkout of a release tag builds binaries that don't say '(dev)'.
Where there is no checkout to ask, set TJ_COMMIT (and TJ_RELEASE, for a
release) in the environment and they are stamped with that instead.
EOF
}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$SCRIPT_DIR/..

OUT_DIR=$REPO_ROOT/build/cli
targets=()
while (($#)); do
    case $1 in
    -h | --help)
        usage
        exit 0
        ;;
    --out-dir)
        [[ -n ${2-} ]] || {
            echo "error: --out-dir needs a directory" >&2
            exit 2
        }
        OUT_DIR=$2
        shift 2
        ;;
    -*)
        echo "error: unknown option '$1'" >&2
        echo "Usage: bin/build-cli.sh [--out-dir DIR] [TARGET...]" >&2
        exit 2
        ;;
    *)
        if [[ " ${ALL_TARGETS[*]} " != *" $1 "* ]]; then
            echo "error: unknown target '$1' (one of: ${ALL_TARGETS[*]})" >&2
            exit 2
        fi
        targets+=("$1")
        shift
        ;;
    esac
done
((${#targets[@]})) || targets=("${DEFAULT_TARGETS[@]}")

# Resolve before the cd below, so a relative --out-dir means the caller's cwd.
mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)
cd "$REPO_ROOT"

# The release identity, by the rule bin/docker-build.sh, bin/deploy.sh and
# lib/version/app-version.ts share: the commit always, the tag only for a
# clean build of a tagged revision. Compiled in as literals, because a binary
# that asked git at run time would describe the user's cwd instead. A stamp
# already in the environment wins: the image build has no .git to ask, and
# is handed the same identity as the server it ships beside.
if [[ -z ${TJ_COMMIT-} ]]; then
    TJ_COMMIT=$(git rev-parse --short HEAD 2>/dev/null) || {
        echo "error: no git checkout here to stamp the binaries from; set TJ_COMMIT" >&2
        exit 1
    }
    TJ_RELEASE=""
    if [[ -z "$(git status --porcelain)" ]]; then
        TJ_RELEASE=$(git describe --tags --exact-match HEAD 2>/dev/null || true)
    fi
fi
TJ_RELEASE=${TJ_RELEASE-}
echo "stamping commit $TJ_COMMIT${TJ_RELEASE:+, release $TJ_RELEASE}" >&2

built=()
for target in "${targets[@]}"; do
    name=tj-$target
    [[ $target == windows-* ]] && name+=.exe
    built+=("$name")
    bun build --compile --target="bun-$target" \
        --define "process.env.TJ_COMMIT=\"$TJ_COMMIT\"" \
        --define "process.env.TJ_RELEASE=\"$TJ_RELEASE\"" \
        cli/index.ts --outfile "$OUT_DIR/$name" >&2
    # bun can exit 0 having written garbage: onto tmpfs it produced a file that
    # starts with zeros. Check for the platform's executable magic rather than
    # publish something that only fails on the machine that downloads it.
    case $target in
    linux-*) magic=7f454c46 ;;   # \x7fELF
    darwin-*) magic=cffaedfe ;;  # Mach-O 64-bit, little-endian
    windows-*) magic=4d5a ;;     # MZ
    esac
    head=$(od -An -tx1 -N$((${#magic} / 2)) "$OUT_DIR/$name" | tr -d ' \n')
    if [[ $head != "$magic" ]]; then
        echo "error: $OUT_DIR/$name is not a $target executable (starts $head)" >&2
        exit 1
    fi
    echo "$OUT_DIR/$name"
done

cd "$OUT_DIR"
if command -v sha256sum >/dev/null; then
    sha256sum "${built[@]}" >SHA256SUMS
else
    shasum -a 256 "${built[@]}" >SHA256SUMS
fi
