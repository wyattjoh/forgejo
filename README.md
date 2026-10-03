# Forgejo

A Bun workspace with a reusable Forgejo library, a command-line client, and an HTTP MCP server.

This is an unofficial client. It is not affiliated with or endorsed by the
[Forgejo project](https://forgejo.org) or Codeberg e.V.

| Package                                                   | Purpose                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`@wyattjoh/forgejo`](packages/forgejo/README.md)         | Explicit-credential library and shared command runtime                  |
| [`@wyattjoh/forgejo-cli`](packages/forgejo-cli/README.md) | Human, Agent, and Request modes; local configuration and OS credentials |
| [`@wyattjoh/forgejo-mcp`](packages/forgejo-mcp/README.md) | Streamable HTTP at `/mcp`; per-user Forgejo OAuth login                 |

Use Bun 1.4.2 or later. The pinned Forgejo contract is 16.0.2; connections validate the selected
operations against the instance's advertised Swagger contract.

```sh
bun install --frozen-lockfile
bun run cli --version --agent
bun test
bun run typecheck
```

## Installing the CLI

The CLI and MCP server are published to npm and run on Bun:

```sh
bun add --global @wyattjoh/forgejo-cli # installs `forgejo`
bunx @wyattjoh/forgejo-mcp             # reads the environment described in .env.example
```

To run the CLI without installing it, use `bunx` with `-p`, because the executable name differs
from the package name. Pin an exact version so repeat runs come from Bun's global cache, and add
`--no-install` once it is cached so a cache miss fails instead of reaching npm:

<!-- x-release-please-start-version -->

```sh
bunx -p @wyattjoh/forgejo-cli@0.2.0 forgejo --version --agent      # downloads once
bunx --no-install -p @wyattjoh/forgejo-cli@0.2.0 forgejo issue list # cache only
```

<!-- x-release-please-end -->

The [agent skill](skills/forgejo/SKILL.md) uses the same pinned `bunx` invocation when `forgejo`
is not on `PATH`.

## HTTP MCP with Forgejo OAuth

The MCP deployment connects to one configured Forgejo instance. Users sign in and consent on
Forgejo; each MCP client receives separate tokens bound to this MCP deployment. The server stores
Forgejo access and refresh tokens encrypted in SQLite. MCP requests use the signed-in user's
Forgejo permissions. No shared personal access token is required.

1. Register a **confidential OAuth2 application** on your Forgejo instance under
   `/user/settings/applications`. Register one callback, for example
   `https://forgejo-mcp.example.com/oauth/callback`.
2. Copy [.env.example](.env.example) to `.env`. Set the instance URL, public MCP URL, application
   client ID and secret, and a persistent random 32-byte encryption key encoded as base64.
   The environment file and database are ignored by Git.
3. Run `bun run mcp`, or use the [Docker deployment instructions](docs/mcp-deployment.md).
4. Configure your MCP client to connect to `https://forgejo-mcp.example.com/mcp` and start its
   OAuth login flow. The server advertises OAuth discovery metadata and dynamic public-client
   registration. Each login includes consent, PKCE with S256, and validated redirects.

Forgejo OAuth tokens currently lack permission scopes. The server therefore enforces its own MCP
read/write policy. **Read-only is the default.** Set `MCP_READ_ONLY=false` to enable write tools;
clients must also request `forgejo:write`. Writes preserve the CLI's two-call approval protocol,
with MCP approval grants signed and bound to that user's OAuth grant and client.

The HTTP MCP exposes the remote repository, issue, pull-request, Actions, and dispatch commands.
CLI authentication, local Git/filesystem commands, diffs/logs/artifact delivery, and the raw `api`
escape hatch are excluded from HTTP tools. `repo create` and `repo fork` expose only their remote
fields. The complete CLI surface remains available in the CLI package.

## Validation and builds

```sh
bun test
bun run typecheck
bun run lint
bun run format:check
bun run check:generated
bun run check:paired-skill
bun run check:completions
bun run build:release
bun run build:mcp
```

Tests cover the CLI behavior and the OAuth/MCP HTTP flow with a fake Forgejo transport.
Real OAuth setup requires the registered application and a reachable callback URL.

Releases are cut by release-please from Conventional Commits; see [Releasing](docs/releasing.md).
