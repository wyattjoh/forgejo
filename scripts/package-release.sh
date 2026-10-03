#!/bin/sh
set -eu

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  printf '%s\n' "usage: scripts/package-release.sh <version> <staging-directory> <output-directory> [darwin_arm64|linux_amd64]" >&2
  exit 64
fi

version=$1
staging=$2
output=$3
case "$(uname -s)_$(uname -m)" in
  Darwin_arm64) host=darwin_arm64 ;;
  Linux_x86_64) host=linux_amd64 ;;
  *) host=unknown ;;
esac
os_arch=${4:-$host}
case "$os_arch" in
  darwin_arm64 | linux_amd64) ;;
  *)
    printf 'unsupported os_arch: %s\n' "$os_arch" >&2
    exit 64
    ;;
esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
archive="forgejo_${version}_${os_arch}.tar.gz"

if [ ! -f "$staging/forgejo" ]; then
  printf '%s\n' "missing executable: $staging/forgejo" >&2
  exit 1
fi
for completion in forgejo.bash _forgejo forgejo.fish; do
  if [ ! -f "$staging/completions/$completion" ]; then
    printf 'missing generated completion: %s\n' "$completion" >&2
    exit 1
  fi
done

package="$output/package-$os_arch"
rm -rf "$package"
mkdir -p "$package"
cp "$staging/forgejo" "$package/forgejo"
cp "$root/LICENSE" "$package/LICENSE"
cp -R "$staging/completions" "$package/completions"
(
  cd "$package"
  tar -czf "../$archive" forgejo LICENSE completions
)
rm -rf "$package"
printf '%s\n' "$output/$archive"
