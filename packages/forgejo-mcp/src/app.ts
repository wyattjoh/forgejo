import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpConfig } from "./config";
import { ForgejoOAuth } from "./oauth";
import { createMcpServer } from "./tools";

/** Fetch handler separated from the listening socket for protocol-level integration tests. */
export function createApp(config: McpConfig, oauth: ForgejoOAuth, serverFactory = createMcpServer) {
  const limits = new Map<string, { start: number; count: number }>();
  return async (request: Request, peer = "unknown"): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.host !== new URL(config.publicUrl).host ||
      (request.headers.get("host") &&
        request.headers.get("host") !== new URL(config.publicUrl).host)
    )
      return new Response("Invalid Host", { status: 421 });
    const origin = request.headers.get("origin");
    if (origin && !config.allowedOrigins.includes(origin))
      return new Response("Origin not allowed", { status: 403 });
    const respond = (response: Response) => {
      const headers = new Headers(response.headers);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Cache-Control", "no-store");
      if (origin) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Vary", "Origin");
        headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Protocol-Version");
      }
      return new Response(response.body, { status: response.status, headers });
    };
    if (request.method === "OPTIONS")
      return respond(
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers":
              "Authorization, Content-Type, Accept, MCP-Protocol-Version",
          },
        }),
      );
    if (url.pathname === "/healthz") return respond(Response.json({ status: "ok" }));
    // Bound registration/authorization abuse before it creates persistent rows. Forwarded IPs
    // are deliberately ignored; the caller supplies only its actual peer address.
    if (url.pathname.startsWith("/oauth/")) {
      const key = `${peer}:${url.pathname}`,
        now = Date.now();
      if (limits.size > 10_000)
        for (const [id, state] of limits) if (now - state.start > 60_000) limits.delete(id);
      const previous = limits.get(key),
        state = previous && now - previous.start < 60_000 ? previous : { start: now, count: 0 };
      state.count++;
      limits.set(key, state);
      if (state.count > 30)
        return respond(
          new Response("Rate limit exceeded", { status: 429, headers: { "Retry-After": "60" } }),
        );
    }
    if (request.method === "POST") {
      // Reading the bounded body here also protects the SDK's JSON parser and OAuth handlers.
      const reader = request.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 1024 * 1024) {
            await reader.cancel();
            return respond(new Response("Request too large", { status: 413 }));
          }
          chunks.push(next.value);
        }
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      request = new Request(request, { method: "POST", body });
    }
    const oauthResponse = await oauth.handle(request);
    if (oauthResponse) return respond(oauthResponse);
    if (url.pathname !== "/mcp") return respond(new Response("Not found", { status: 404 }));
    let user;
    try {
      user = await oauth.authenticate(request);
    } catch {
      return respond(oauth.challenge());
    }
    if (!user) return respond(oauth.challenge());
    if (!user.scopes.includes("forgejo:read") && !user.scopes.includes("forgejo:write"))
      return respond(new Response("Insufficient scope", { status: 403 }));
    if (request.method !== "POST")
      return respond(
        new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } }),
      );
    const server = serverFactory(config, user, request.signal);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      return respond(await transport.handleRequest(request));
    } finally {
      await server.close();
    }
  };
}
