#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf '%s\n' "usage: scripts/accept-release-artifact.sh <release-archive>" >&2
  exit 64
fi

archive=$1
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT INT TERM

for path in forgejo LICENSE completions/forgejo.bash completions/_forgejo completions/forgejo.fish; do
  if ! tar -tzf "$archive" | grep -Fx "$path" >/dev/null; then
    printf '%s\n' "release archive is missing: $path" >&2
    exit 1
  fi
done

# A cross-compiled archive cannot run here, so only the archive built for this host gets the
# smoke run. The others are accepted on their contents alone.
case "$(uname -s)_$(uname -m)" in
  Darwin_arm64) host=darwin_arm64 ;;
  Linux_x86_64) host=linux_amd64 ;;
  *) host=unknown ;;
esac
case "$(basename -- "$archive")" in
  *"_$host.tar.gz") ;;
  *)
    printf 'accepted %s on contents only; it does not target %s\n' "$archive" "$host" >&2
    exit 0
    ;;
esac

tar -xzf "$archive" -C "$scratch"
task_home=$scratch/home
mkdir -p "$task_home"
# Bun stays off the binary's PATH so the check proves the compiled executable is self-contained.
bun=$(command -v bun)
printf '%s\n' '{"schema_version":1,"request_id":"release-smoke","input":{"value":"release-smoke"}}' \
  | PATH="/usr/bin:/bin" HOME="$task_home" "$scratch/forgejo" smoke echo --input-output json --dry-run \
  | "$bun" -e '
const outcome = JSON.parse(await Bun.stdin.text());
if (
  outcome.command !== "smoke echo" ||
  outcome.status !== "success" ||
  outcome.effects?.[0]?.state !== "planned"
) process.exit(1);
'
