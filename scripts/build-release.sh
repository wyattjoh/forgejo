#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  printf '%s\n' "usage: scripts/build-release.sh <staging-directory> [darwin-arm64|linux-x64]" >&2
  exit 64
fi

staging=$1
# The target defaults to this host, so a local build is the one this machine can run.
case "$(uname -s)_$(uname -m)" in
  Darwin_arm64) host=darwin-arm64 ;;
  Linux_x86_64) host=linux-x64 ;;
  *) host=unknown ;;
esac
target=${2:-$host}
case "$target" in
  darwin-arm64 | linux-x64) ;;
  *)
    printf 'unsupported target: %s\n' "$target" >&2
    exit 64
    ;;
esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Stamp the binary with the commit it was built on. Two builds cut from the same unreleased
# version report the same version, so the commit is the only thing that tells a current install
# from a stale one. A dirty tree says so, since its commit does not describe what was compiled.
commit=$(cd "$root" && git rev-parse --short=12 HEAD 2>/dev/null || true)
if [ -n "$commit" ] && ! (cd "$root" && git diff --quiet HEAD 2>/dev/null); then
  commit="$commit-dirty"
fi
FORGEJO_BUILD_COMMIT=$commit
FORGEJO_BUILD_SOURCE=${FORGEJO_BUILD_SOURCE:-dev}
export FORGEJO_BUILD_COMMIT FORGEJO_BUILD_SOURCE

rm -rf "$staging"
mkdir -p "$staging"
bun "$root/scripts/generate-completions.ts" --output "$staging/completions"
# `--env` with a prefix inlines exactly these two readings at compile time and nothing else, so
# the stamp is fixed when the binary is built and no runtime environment can restate it. Bun
# cross-compiles every target from any host; a darwin binary built on Linux is ad-hoc signed.
bun build --compile --target="bun-$target" --env='FORGEJO_BUILD_*' \
  "$root/packages/forgejo-cli/src/main.ts" --outfile "$staging/forgejo"
