# Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please). Every
push to `main` updates an open release PR from the [Conventional Commits](https://www.conventionalcommits.org/)
since the last tag: `feat:` bumps the minor version and `fix:` the patch version while the project
is pre-1.0, and breaking changes bump the minor version. The release PR bumps every workspace
`package.json`, then a follow-up job regenerates `bun.lock`, `nix/dependencies.json`, the paired
skill, and completions on the same branch so `main` stays in sync after the merge.

Merging the release PR tags `vX.Y.Z`, creates the GitHub release, and runs the publish job in
`.github/workflows/release.yml`. That job reruns every check against the tag, builds the
`darwin_arm64` and `linux_amd64` archives as release builds, and attaches them with a `SHA256SUMS`
manifest. Archives upload first and `SHA256SUMS` last, so a release without the manifest is
incomplete. A rerun leaves a complete release alone. It refuses to upload over a partial one,
because rebuilt archives are not byte-identical; delete the partial assets by hand, then rerun.

## Local builds

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run format:check
bun run lint
bun run check:generated
bun run check:paired-skill
bun run check:completions
bun run build:release
bun run accept:release
```

`build:release` stages a standalone `dist/staging/forgejo` executable with shell completions.
`accept:release` packages and checks an archive for the current machine. The executable is compiled
with Bun and does not need Bun on the user's PATH. Build both supported platforms with
`bun run build:release:all`; Apple Silicon macOS and x86-64 Linux are supported.

Each archive contains `forgejo`, `LICENSE`, and Bash, Zsh, and Fish completion scripts under
`completions/`. The macOS executable is ad-hoc signed by Bun, without Developer ID signing or
notarization.

CLI tokens use `Bun.secrets` under `dev.wyattjoh.forgejo-cli.token`, keyed by the Forgejo deployment
URL. On macOS this uses the login Keychain. Linux requires libsecret, a reachable session D-Bus and
an unlocked Secret Service provider. CLI login configures Git's osxkeychain helper on macOS; on
Linux it leaves Git credential configuration alone.

The MCP server uses its own encrypted OAuth storage, documented in [MCP deployment](mcp-deployment.md).
