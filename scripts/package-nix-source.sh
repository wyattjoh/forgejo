#!/usr/bin/env bash
set -euo pipefail
# Run from the workspace root with GNU tar (gtar on macOS). Produces only
# build source, never credentials, databases, node_modules or Git metadata.
destination=${1:?usage: scripts/package-nix-source.sh /absolute/output.tar.gz}
tar_command=${FORGEJO_GNU_TAR:-tar}
"$tar_command" --version | head -n 1 | grep -q 'GNU tar'
bun run check:nix
"$tar_command" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  --exclude=node_modules --exclude=.git --exclude=data --exclude='.DS_Store' \
  --exclude='.env*' --exclude='*.sqlite*' --exclude='*.db*' \
  --transform='s,^,forgejo-tools/,' \
  -cf - packages package.json bun.lock tsconfig.json default.nix nix LICENSE \
  | gzip -n > "$destination"
