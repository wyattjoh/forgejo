# Deploying the HTTP MCP server

Register a confidential OAuth2 application under the configured Forgejo instance's
`/user/settings/applications`. Use the exact redirect URI
`https://YOUR-MCP-HOST/oauth/callback`. Save the client ID and secret in `.env` or your deployment's
secret store. No credentials are committed to this workspace.

Set `MCP_PUBLIC_URL` to the external HTTPS origin, and `FORGEJO_HOST` to the one Forgejo deployment.
Generate `MCP_ENCRYPTION_KEY` once with `openssl rand -base64 32`. Preserve this key and the database
across updates. Set `MCP_ALLOWED_USERS` if the deployment should accept only selected usernames.
Read-only tools are enabled by default; set `MCP_READ_ONLY=false` to expose mutations.

```sh
docker compose up --build -d
```

Compose binds the server on loopback port 3000 and mounts a persistent named volume for SQLite.
Put an HTTPS reverse proxy in front of it. Forward the original public `Host` header; the server
validates it against `MCP_PUBLIC_URL`. Do not cache OAuth endpoints or MCP responses. Apply proxy
request timeouts appropriate to the `run watch` and `pr checks` durations you use. MCP requests
use JSON responses, so SSE buffering settings are not required.

Example Caddy configuration:

```caddy
forgejo-mcp.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Connect clients to `https://forgejo-mcp.example.com/mcp`. An unauthenticated request returns HTTP
401 with a `WWW-Authenticate` discovery challenge. Compatible clients register themselves and
open the OAuth consent/login flow. This server uses dynamic public-client registration; clients
must support that flow or allow preconfiguring a registered client ID and exact redirect URI.
For browser MCP clients, add the browser application's origin to `MCP_ALLOWED_ORIGINS`.

The application rate-limits each OAuth route by its actual socket peer. Behind a reverse proxy
all clients may share the proxy's address, so proxy-level limits are useful for public exposure.
The application intentionally does not trust forwarded-IP headers.

Run one replica. SQLite provides persistent OAuth state, and upstream refresh deduplication is
local to that process. Scaling requires replacing the store and introducing a distributed lock.
Back up the SQLite database consistently and retain its encryption key separately. Deleting the
database ends all MCP sessions; users can sign in again.

The local test suite exercises the protocol against a fake Forgejo host. Before wider use,
complete a real login with your deployed callback and target MCP client, confirm refresh and
logout behavior, and verify the intended read/write policy.

## Native Nix packaging

`default.nix` builds the CLI and MCP adapters from the same core library. Pass the deployment's
pinned `pkgs`; the build fetches npm archives by their lockfile integrity hashes and bundles
offline. No install step runs when the service starts. `nix/dependencies.json` is the generated
production closure of `bun.lock`; run `bun run check:nix` to detect drift. To update it, run
`bun run generate:nix` and save the generated JSON as `nix/dependencies.json`.

`scripts/package-nix-source.sh` creates a deterministic, build-source-only archive for deployments
that cannot fetch the repository directly. Run it with GNU tar from the workspace root, supplying
an explicit output path. It excludes dependencies, Git metadata, credentials and databases.
Pin the unpacked Nix source hash in the deployment; keep the archive and pin in the same change.

The Nix package also contains the CLI. On a host that also runs a Forgejo server, use the
package's explicit path rather than replacing the server's administrative executable, which is
also named `forgejo`.
