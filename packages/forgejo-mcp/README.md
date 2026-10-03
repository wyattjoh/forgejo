# Forgejo HTTP MCP

Run `bun run mcp` at the workspace root after configuring [.env.example](../../.env.example).
The server exposes stateless Streamable HTTP with JSON responses at `/mcp` and a minimal
`/healthz` endpoint. It uses the MCP TypeScript SDK's Web Standard HTTP transport on Bun.

The OAuth broker exposes protected-resource metadata and authorization-server metadata,
`/oauth/register`, `/oauth/authorize`, `/oauth/consent`, `/oauth/callback`, `/oauth/token`, and
`/oauth/revoke`. Forgejo provides the native user login and account authorization. The broker
provides MCP resource tokens and manages Forgejo token refresh server-side.

MCP access tokens expire after one hour. Refresh tokens rotate on every exchange and expire
after 30 days. Reusing a consumed refresh token invalidates its entire grant.
Authorization codes expire after one minute and are consumed atomically. Pending
browser login state expires after five minutes. All persisted OAuth state is encrypted with
AES-256-GCM; presented MCP tokens and codes are indexed by their hashes. Revoking a token removes
the associated grant and invalidates its other access and refresh tokens.

The SDK transport is stateless, but authorization needs persistent storage. This implementation
supports **one server process with its SQLite volume**. Run one replica. Multiple replicas require
a shared store and a distributed lock around Forgejo's rotating refresh-token exchange.

Read tools are always available to authorized clients. Writes require `MCP_READ_ONLY=false` and
the client's `forgejo:write` scope. Schemas derive from the core catalog; strict HTTP schemas
exclude local filesystem and host-selector fields. Full catalog refinements still run in core.
Tool responses include both JSON text and `structuredContent` with the shared `CommandOutcome`.

For a mutation, inspect `effects` and the `approve` step in `next_steps`. Repeat the identical
tool arguments with the returned grant in `_approval`. `_dry_run` previews mutation effects.
OAuth consent and command execution approval are separate decisions.

The server uses a dedicated encrypted database and rejects opening it with a different encryption
key, Forgejo host, OAuth application ID, or public issuer URL. Use a fresh database for a different
deployment. Keep the key with your deployment secrets and back it up alongside the database.

See [deployment and proxy setup](../../docs/mcp-deployment.md). Browser clients may require their
origin to be added to `MCP_ALLOWED_ORIGINS`. CLI and desktop MCP clients normally omit Origin.
