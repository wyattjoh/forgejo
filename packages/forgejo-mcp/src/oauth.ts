import { createHash, timingSafeEqual } from "node:crypto";
import type { ActiveIdentity, FetchAdapter } from "@wyattjoh/forgejo";
import type { McpConfig } from "./config";
import { hash, OAuthStore, randomToken } from "./store";

type Client = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
};
type Login = {
  clientId: string;
  redirectUri: string;
  state: string | undefined;
  challenge: string;
  scopes: string[];
  browser: string;
  verifier: string;
};
type UpstreamTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
};
type UserGrant = {
  clientId: string;
  identity: ActiveIdentity;
  upstream: UpstreamTokens;
  upstreamExpires: number;
  scopes: string[];
};
type Code = { login: Login; grantId: string };
type Token = { grantId: string; clientId: string; scopes: string[] };
export type AuthenticatedUser = {
  grantId: string;
  clientId: string;
  scopes: string[];
  identity: ActiveIdentity;
  forgejoToken: string;
};

const accessLifetime = 3600;
const grantLifetime = 30 * 24 * 3600_000;
const shortLifetime = 5 * 60_000;
const challengeFor = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");
const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
class OAuthFailure extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}

/** Fixed upstream Forgejo application, independent MCP client registration and resource tokens. */
export class ForgejoOAuth {
  private readonly refreshes = new Map<string, Promise<UserGrant>>();
  constructor(
    readonly config: McpConfig,
    readonly store: OAuthStore,
    private readonly fetchAdapter: FetchAdapter = fetch,
  ) {
    const deployment = JSON.stringify([config.forgejoHost, config.publicUrl, config.clientId]);
    const previous = store.get<string>("metadata", "deployment");
    if (previous && previous !== deployment)
      throw new Error("OAuth database belongs to a different deployment; use a new database");
    if (!previous) store.put("metadata", "deployment", deployment, Number.MAX_SAFE_INTEGER);
  }
  get resource(): string {
    return `${this.config.publicUrl}/mcp`;
  }
  get resourceMetadataUrl(): string {
    return `${this.config.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  }
  private get callback(): string {
    return `${this.config.publicUrl}/oauth/callback`;
  }
  challenge(): Response {
    return Response.json(
      { error: "unauthorized" },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${this.resourceMetadataUrl}"`,
          "Cache-Control": "no-store",
        },
      },
    );
  }
  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const routes = [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/oauth/register",
      "/oauth/authorize",
      "/oauth/consent",
      "/oauth/callback",
      "/oauth/token",
      "/oauth/revoke",
    ];
    if (!routes.includes(url.pathname)) return undefined;
    try {
      let response: Response;
      switch (url.pathname) {
        case "/.well-known/oauth-protected-resource":
        case "/.well-known/oauth-protected-resource/mcp":
          this.method(request, "GET");
          response = Response.json({
            resource: this.resource,
            authorization_servers: [this.config.publicUrl],
            scopes_supported: this.supportedScopes(),
            bearer_methods_supported: ["header"],
          });
          break;
        case "/.well-known/oauth-authorization-server":
          this.method(request, "GET");
          response = Response.json({
            issuer: this.config.publicUrl,
            authorization_endpoint: `${this.config.publicUrl}/oauth/authorize`,
            token_endpoint: `${this.config.publicUrl}/oauth/token`,
            registration_endpoint: `${this.config.publicUrl}/oauth/register`,
            revocation_endpoint: `${this.config.publicUrl}/oauth/revoke`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: this.supportedScopes(),
            authorization_response_iss_parameter_supported: true,
          });
          break;
        case "/oauth/register":
          response = await this.register(request);
          break;
        case "/oauth/authorize":
          response = this.authorize(request, url);
          break;
        case "/oauth/consent":
          response = await this.consent(request);
          break;
        case "/oauth/callback":
          response = await this.completeLogin(request, url);
          break;
        case "/oauth/token":
          response = await this.token(request);
          break;
        case "/oauth/revoke":
          response = await this.revoke(request);
          break;
        default:
          return undefined;
      }
      response.headers.set("Cache-Control", "no-store");
      // Form POSTs need a real Origin for CSRF validation; hide the authorization query.
      response.headers.set(
        "Referrer-Policy",
        url.pathname === "/oauth/authorize" ? "strict-origin" : "no-referrer",
      );
      return response;
    } catch (error) {
      return Response.json(
        { error: error instanceof OAuthFailure ? error.code : "server_error" },
        {
          status: error instanceof OAuthFailure ? error.status : 500,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  }
  private supportedScopes(): string[] {
    return this.config.readOnly ? ["forgejo:read"] : ["forgejo:read", "forgejo:write"];
  }
  private method(request: Request, expected: string): void {
    if (request.method !== expected) throw new OAuthFailure("invalid_request", 405);
  }
  private client(id: string | null): Client {
    const client = id ? this.store.get<Client>("client", id) : undefined;
    if (!client) throw new OAuthFailure("invalid_client");
    return client;
  }
  private checkResource(resource: string | null): void {
    if (resource !== this.resource) throw new OAuthFailure("invalid_target");
  }
  private async form(request: Request): Promise<URLSearchParams> {
    this.method(request, "POST");
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded"))
      throw new OAuthFailure("invalid_request");
    const form = new URLSearchParams(await request.text());
    for (const key of form.keys())
      if (form.getAll(key).length !== 1) throw new OAuthFailure("invalid_request");
    return form;
  }
  private async register(request: Request): Promise<Response> {
    this.method(request, "POST");
    let input: Record<string, unknown>;
    try {
      input = (await request.json()) as Record<string, unknown>;
    } catch {
      throw new OAuthFailure("invalid_client_metadata");
    }
    if (
      !input ||
      !Array.isArray(input.redirect_uris) ||
      input.redirect_uris.length < 1 ||
      input.redirect_uris.length > 10
    )
      throw new OAuthFailure("invalid_redirect_uri");
    const redirectUris = input.redirect_uris.map((value) => {
      if (typeof value !== "string" || value.length > 2048)
        throw new OAuthFailure("invalid_redirect_uri");
      let uri: URL;
      try {
        uri = new URL(value);
      } catch {
        throw new OAuthFailure("invalid_redirect_uri");
      }
      if (
        uri.hash ||
        uri.username ||
        uri.password ||
        (uri.protocol !== "https:" &&
          !(uri.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(uri.hostname)))
      )
        throw new OAuthFailure("invalid_redirect_uri");
      return value;
    });
    if (
      input.token_endpoint_auth_method !== undefined &&
      input.token_endpoint_auth_method !== "none"
    )
      throw new OAuthFailure("invalid_client_metadata");
    if (
      input.response_types !== undefined &&
      (!Array.isArray(input.response_types) ||
        input.response_types.some((value) => value !== "code"))
    )
      throw new OAuthFailure("invalid_client_metadata");
    if (
      input.grant_types !== undefined &&
      (!Array.isArray(input.grant_types) ||
        input.grant_types.some(
          (value) => value !== "authorization_code" && value !== "refresh_token",
        ))
    )
      throw new OAuthFailure("invalid_client_metadata");
    const client: Client = {
      client_id: randomToken(),
      client_name:
        typeof input.client_name === "string" ? input.client_name.slice(0, 100) : "MCP client",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    this.store.put("client", client.client_id, client, Date.now() + 365 * 24 * 3600_000);
    return Response.json(client, { status: 201 });
  }
  private authorize(request: Request, url: URL): Response {
    this.method(request, "GET");
    const parameters = url.searchParams;
    for (const key of parameters.keys())
      if (parameters.getAll(key).length !== 1) throw new OAuthFailure("invalid_request");
    const client = this.client(parameters.get("client_id"));
    const redirectUri = parameters.get("redirect_uri");
    if (!redirectUri || !client.redirect_uris.includes(redirectUri))
      throw new OAuthFailure("invalid_redirect_uri");
    this.checkResource(parameters.get("resource"));
    if (
      parameters.get("response_type") !== "code" ||
      parameters.get("code_challenge_method") !== "S256"
    )
      throw new OAuthFailure("invalid_request");
    const challenge = parameters.get("code_challenge");
    if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
      throw new OAuthFailure("invalid_request");
    const scopes = (parameters.get("scope") ?? "forgejo:read").split(" ").filter(Boolean);
    if (!scopes.length || scopes.some((scope) => !this.supportedScopes().includes(scope)))
      throw new OAuthFailure("invalid_scope");
    const transaction = randomToken(),
      browser = randomToken();
    const login: Login = {
      clientId: client.client_id,
      redirectUri,
      state: parameters.get("state") ?? undefined,
      challenge,
      scopes,
      browser,
      verifier: randomToken(),
    };
    this.store.put("consent", hash(transaction), login, Date.now() + shortLifetime);
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect to Forgejo</title><body><h1>Connect ${escapeHtml(client.client_name)} to Forgejo</h1><p>Forgejo instance: ${escapeHtml(this.config.forgejoHost)}</p><p>Return address: <code>${escapeHtml(redirectUri)}</code></p><p>Requested MCP access: ${escapeHtml(scopes.join(", "))}. Write tools require a separate mutation approval.</p><p>Forgejo OAuth grants the server your full Forgejo permissions. The MCP tool policy restricts what this client can do.</p><form method="post" action="/oauth/consent"><input type="hidden" name="transaction" value="${transaction}"><button name="decision" value="allow">Continue to Forgejo</button> <button name="decision" value="deny">Cancel</button></form></body></html>`;
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "Set-Cookie": this.cookie(transaction, browser),
      },
    });
  }
  private cookieName(transaction: string): string {
    return `forgejo_oauth_${hash(transaction).slice(0, 16)}`;
  }
  private cookie(transaction: string, browser: string, clear = false): string {
    return `${this.cookieName(transaction)}=${browser}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 300}${this.config.publicUrl.startsWith("https:") ? "; Secure" : ""}`;
  }
  private checkBrowser(request: Request, transaction: string, login: Login): void {
    const cookies = new Map(
      (request.headers.get("cookie") ?? "").split(";").map((cookie) => {
        const [key, ...value] = cookie.trim().split("=");
        return [key, value.join("=")] as const;
      }),
    );
    if (!safeEqual(cookies.get(this.cookieName(transaction)) ?? "", login.browser))
      throw new OAuthFailure("invalid_request");
  }
  private async consent(request: Request): Promise<Response> {
    const form = await this.form(request),
      transaction = form.get("transaction") ?? "";
    const login = this.store.get<Login>("consent", hash(transaction));
    if (!login) throw new OAuthFailure("invalid_request");
    this.checkBrowser(request, transaction, login);
    if (request.headers.get("origin") !== new URL(this.config.publicUrl).origin)
      throw new OAuthFailure("invalid_request");
    if (form.get("decision") !== "allow" && form.get("decision") !== "deny")
      throw new OAuthFailure("invalid_request");
    this.store.take("consent", hash(transaction));
    if (form.get("decision") === "deny")
      return this.clientRedirect(login, { error: "access_denied" });
    this.store.put("login", hash(transaction), login, Date.now() + shortLifetime);
    const authorize = new URL(`${this.config.forgejoHost}/login/oauth/authorize`);
    authorize.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.callback,
      response_type: "code",
      state: transaction,
      code_challenge: challengeFor(login.verifier),
      code_challenge_method: "S256",
    }).toString();
    return Response.redirect(authorize.toString(), 302);
  }
  private clientRedirect(login: Login, result: Record<string, string>): Response {
    const target = new URL(login.redirectUri);
    for (const [key, value] of Object.entries(result)) target.searchParams.set(key, value);
    if (login.state !== undefined) target.searchParams.set("state", login.state);
    target.searchParams.set("iss", this.config.publicUrl);
    return new Response(null, { status: 302, headers: { Location: target.toString() } });
  }
  private async completeLogin(request: Request, url: URL): Promise<Response> {
    this.method(request, "GET");
    for (const key of url.searchParams.keys())
      if (url.searchParams.getAll(key).length !== 1) throw new OAuthFailure("invalid_request");
    const transaction = url.searchParams.get("state") ?? "";
    const login = this.store.get<Login>("login", hash(transaction));
    if (!login) throw new OAuthFailure("invalid_request");
    this.checkBrowser(request, transaction, login);
    if (!this.store.take("login", hash(transaction))) throw new OAuthFailure("invalid_request");
    if (url.searchParams.has("error"))
      return this.clientRedirect(login, { error: "access_denied" });
    const code = url.searchParams.get("code");
    if (!code) throw new OAuthFailure("invalid_request");
    const upstream = await this.upstreamTokens({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.callback,
      code_verifier: login.verifier,
    });
    const identity = await this.identity(upstream.access_token);
    if (this.config.allowedUsers.length && !this.config.allowedUsers.includes(identity.login))
      return this.clientRedirect(login, { error: "access_denied" });
    const grantId = randomToken();
    const grant: UserGrant = {
      clientId: login.clientId,
      identity,
      scopes: login.scopes,
      upstream,
      upstreamExpires: Date.now() + upstream.expires_in * 1000,
    };
    this.store.put("grant", grantId, grant, Date.now() + grantLifetime);
    const downstreamCode = randomToken();
    this.store.put(
      "code",
      hash(downstreamCode),
      { login, grantId } satisfies Code,
      Date.now() + 60_000,
    );
    const response = this.clientRedirect(login, { code: downstreamCode });
    response.headers.set("Set-Cookie", this.cookie(transaction, "", true));
    return response;
  }
  private async upstreamTokens(values: Record<string, string>): Promise<UpstreamTokens> {
    const response = await this.fetchAdapter(
      `${this.config.forgejoHost}/login/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        body: new URLSearchParams({
          ...values,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new OAuthFailure("invalid_grant");
    }
    const tokens = (await this.boundedJson(response)) as UpstreamTokens;
    if (
      typeof tokens.access_token !== "string" ||
      !tokens.access_token ||
      typeof tokens.refresh_token !== "string" ||
      !tokens.refresh_token ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0 ||
      tokens.token_type?.toLowerCase() !== "bearer"
    )
      throw new OAuthFailure("server_error", 502);
    return tokens;
  }
  private async identity(token: string): Promise<ActiveIdentity> {
    const response = await this.fetchAdapter(`${this.config.forgejoHost}/api/v1/user`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new OAuthFailure("access_denied", 403);
    }
    const user = (await this.boundedJson(response)) as { id: unknown; login: unknown };
    if (!/^\d+$/.test(String(user.id)) || typeof user.login !== "string" || !user.login)
      throw new OAuthFailure("server_error", 502);
    return { id: String(user.id), login: user.login };
  }
  private async boundedJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new OAuthFailure("server_error", 502);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        throw new OAuthFailure("server_error", 502);
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new OAuthFailure("server_error", 502);
    }
  }
  private async token(request: Request): Promise<Response> {
    const form = await this.form(request),
      client = this.client(form.get("client_id"));
    this.checkResource(form.get("resource"));
    let token: Token;
    if (form.get("grant_type") === "authorization_code") {
      const codeHash = hash(form.get("code") ?? ""),
        code = this.store.get<Code>("code", codeHash);
      const verifier = form.get("code_verifier") ?? "";
      if (
        !code ||
        code.login.clientId !== client.client_id ||
        code.login.redirectUri !== form.get("redirect_uri") ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        !safeEqual(challengeFor(verifier), code.login.challenge)
      )
        throw new OAuthFailure("invalid_grant");
      if (!this.store.take("code", codeHash)) throw new OAuthFailure("invalid_grant");
      token = { grantId: code.grantId, clientId: client.client_id, scopes: code.login.scopes };
    } else if (form.get("grant_type") === "refresh_token") {
      const refreshHash = hash(form.get("refresh_token") ?? ""),
        existing = this.store.get<Token>("refresh", refreshHash);
      if (!existing) {
        const replay = this.store.get<Token>("used_refresh", refreshHash);
        if (replay?.clientId === client.client_id) this.store.remove("grant", replay.grantId);
        throw new OAuthFailure("invalid_grant");
      }
      if (
        existing.clientId !== client.client_id ||
        !this.store.get<UserGrant>("grant", existing.grantId)
      )
        throw new OAuthFailure("invalid_grant");
      const scopes = form.has("scope")
        ? form.get("scope")!.split(" ").filter(Boolean)
        : existing.scopes;
      if (!scopes.length || scopes.some((scope) => !existing.scopes.includes(scope)))
        throw new OAuthFailure("invalid_scope");
      if (!this.store.take("refresh", refreshHash)) throw new OAuthFailure("invalid_grant");
      this.store.put("used_refresh", refreshHash, existing, Date.now() + grantLifetime);
      token = { ...existing, scopes };
    } else throw new OAuthFailure("unsupported_grant_type");
    const access = randomToken(),
      refresh = randomToken();
    this.store.put("access", hash(access), token, Date.now() + accessLifetime * 1000);
    this.store.put("refresh", hash(refresh), token, Date.now() + grantLifetime);
    return Response.json({
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: accessLifetime,
      scope: token.scopes.join(" "),
    });
  }
  private async revoke(request: Request): Promise<Response> {
    const form = await this.form(request),
      client = this.client(form.get("client_id")),
      digest = hash(form.get("token") ?? "");
    const token =
      this.store.get<Token>("access", digest) ?? this.store.get<Token>("refresh", digest);
    if (token?.clientId === client.client_id) this.store.remove("grant", token.grantId);
    return new Response(null, { status: 200 });
  }
  async authenticate(request: Request): Promise<AuthenticatedUser | undefined> {
    const header = request.headers.get("authorization"),
      match = header?.match(/^Bearer ([A-Za-z0-9_-]+)$/i);
    const token = match ? this.store.get<Token>("access", hash(match[1]!)) : undefined;
    if (!token) return undefined;
    let grant = this.store.get<UserGrant>("grant", token.grantId);
    if (
      !grant ||
      grant.clientId !== token.clientId ||
      (this.config.allowedUsers.length && !this.config.allowedUsers.includes(grant.identity.login))
    )
      return undefined;
    if (grant.upstreamExpires < Date.now() + 30_000) {
      let pending = this.refreshes.get(token.grantId);
      if (!pending) {
        pending = this.refreshGrant(token.grantId, grant);
        this.refreshes.set(token.grantId, pending);
      }
      try {
        grant = await pending;
      } finally {
        if (this.refreshes.get(token.grantId) === pending) this.refreshes.delete(token.grantId);
      }
    }
    return {
      grantId: token.grantId,
      clientId: token.clientId,
      scopes: token.scopes,
      identity: grant.identity,
      forgejoToken: grant.upstream.access_token,
    };
  }
  private async refreshGrant(grantId: string, previous: UserGrant): Promise<UserGrant> {
    const upstream = await this.upstreamTokens({
      grant_type: "refresh_token",
      refresh_token: previous.upstream.refresh_token,
    });
    // Revocation during the remote exchange must not resurrect this grant.
    if (!this.store.get("grant", grantId)) throw new OAuthFailure("invalid_grant");
    const grant = {
      ...previous,
      upstream,
      upstreamExpires: Date.now() + upstream.expires_in * 1000,
    };
    this.store.put("grant", grantId, grant, Date.now() + grantLifetime);
    return grant;
  }
}
