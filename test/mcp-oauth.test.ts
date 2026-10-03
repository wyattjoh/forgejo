import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { connectForgejo, type FetchAdapter, type CommandOutcome } from "@wyattjoh/forgejo";
import {
  createApp,
  createMcpServer,
  ForgejoOAuth,
  OAuthStore,
  readConfig,
  type McpConfig,
} from "@wyattjoh/forgejo-mcp";

const stores: OAuthStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});
const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const config: McpConfig = {
  forgejoHost: "https://forgejo.example",
  publicUrl: "https://mcp.example",
  clientId: "upstream-client",
  clientSecret: "upstream-secret",
  encryptionKey: randomBytes(32).toString("base64"),
  databasePath: ":memory:",
  listenHost: "127.0.0.1",
  port: 3000,
  allowedOrigins: ["https://mcp.example"],
  allowedUsers: [],
  readOnly: false,
};
const swagger = await Bun.file(new URL("../swagger.v1.json", import.meta.url)).text();

function fixture(settings: Partial<McpConfig> = {}, expires = 3600) {
  const settingsWithDefaults = { ...config, ...settings };
  const store = new OAuthStore(":memory:", config.encryptionKey);
  stores.push(store);
  let refreshes = 0,
    writes = 0;
  const fetchAdapter: FetchAdapter = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/login/oauth/access_token")) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_secret")).toBe("upstream-secret");
      expect(body.get("client_id")).toBe("upstream-client");
      if (body.get("grant_type") === "refresh_token") refreshes++;
      else {
        expect(body.get("redirect_uri")).toBe("https://mcp.example/oauth/callback");
        expect(body.get("code_verifier")?.length).toBe(43);
      }
      return Response.json({
        access_token:
          body.get("code") === "bob-code" || body.get("refresh_token") === "bob-refresh-secret"
            ? "bob-user-secret"
            : "forgejo-user-secret",
        refresh_token:
          body.get("code") === "bob-code" || body.get("refresh_token") === "bob-refresh-secret"
            ? "bob-refresh-secret"
            : "forgejo-refresh-secret",
        expires_in: refreshes ? 3600 : expires,
        token_type: "bearer",
      });
    }
    if (url.endsWith("/api/v1/user"))
      return Response.json(
        new Headers(init?.headers).get("authorization")?.includes("bob-user-secret")
          ? { id: 2, login: "bob" }
          : { id: 1, login: "alice" },
      );
    if (url.endsWith("/api/v1/version")) return Response.json({ version: "16.0.2" });
    if (url.endsWith("/swagger.v1.json")) return new Response(swagger);
    if (url.endsWith("/api/v1/repos/alice/demo")) {
      expect(new Headers(init?.headers).get("authorization")).toContain("forgejo-user-secret");
      if (init?.method === "DELETE") {
        writes++;
        return new Response(null, { status: 204 });
      }
      return Response.json({
        id: 1,
        name: "demo",
        full_name: "alice/demo",
        owner: { login: "alice" },
        html_url: "https://forgejo.example/alice/demo",
        clone_url: "https://forgejo.example/alice/demo.git",
        ssh_url: "git@forgejo.example:alice/demo.git",
        private: false,
        archived: false,
        default_branch: "main",
      });
    }
    throw new Error(`Unexpected fixture URL ${url}`);
  };
  const oauth = new ForgejoOAuth(settingsWithDefaults, store, fetchAdapter);
  const app = createApp(settingsWithDefaults, oauth, (options, user, signal) =>
    createMcpServer(options, user, signal, (args) =>
      connectForgejo({ ...args, fetch: fetchAdapter }),
    ),
  );
  const get = (path: string, headers: Record<string, string> = {}) =>
    app(new Request(`https://mcp.example${path}`, { headers }));
  const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    app(
      new Request(`https://mcp.example${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(body),
      }),
    );
  const register = async () => {
    const response = await app(
      new Request("https://mcp.example/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Test MCP client",
          redirect_uris: ["http://127.0.0.1:4567/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(response.status).toBe(201);
    return (await response.json()).client_id as string;
  };
  const start = async (clientId: string, scope = "forgejo:read forgejo:write") => {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: "http://127.0.0.1:4567/callback",
      resource: oauth.resource,
      code_challenge_method: "S256",
      code_challenge: challenge,
      state: "client-state",
      scope,
    });
    const response = await get(`/oauth/authorize?${params}`);
    expect(response.status).toBe(200);
    // no-referrer makes browser form submissions send Origin: null, which consent rejects.
    expect(response.headers.get("referrer-policy")).toBe("strict-origin");
    const html = await response.text();
    const transaction = html.match(/name="transaction" value="([^"]+)"/)![1]!;
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    return { transaction, cookie };
  };
  const login = async (scope?: string, upstreamCode = "upstream-code") => {
    const clientId = await register(),
      { transaction, cookie } = await start(clientId, scope);
    const consent = await post(
      "/oauth/consent",
      { transaction, decision: "allow" },
      { cookie, origin: config.publicUrl },
    );
    expect(consent.status).toBe(302);
    const upstream = new URL(consent.headers.get("location")!);
    expect(upstream.origin).toBe("https://forgejo.example");
    expect(upstream.searchParams.get("code_challenge_method")).toBe("S256");
    expect(upstream.searchParams.get("redirect_uri")).toBe("https://mcp.example/oauth/callback");
    const callback = await get(`/oauth/callback?state=${transaction}&code=${upstreamCode}`, {
      cookie,
    });
    expect(callback.status).toBe(302);
    const redirect = new URL(callback.headers.get("location")!);
    expect(redirect.searchParams.get("state")).toBe("client-state");
    expect(redirect.searchParams.get("iss")).toBe(config.publicUrl);
    const code = redirect.searchParams.get("code")!;
    const tokenForm = {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:4567/callback",
      resource: oauth.resource,
      code_verifier: verifier,
      code,
    };
    const response = await post("/oauth/token", tokenForm);
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    return { clientId, code, tokenForm, tokens };
  };
  const rpc = async (token: string, method: string, params: unknown = {}) => {
    const response = await app(
      new Request("https://mcp.example/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()).result;
  };
  return {
    app,
    oauth,
    store,
    get,
    post,
    register,
    start,
    login,
    rpc,
    counts: () => ({ refreshes, writes }),
  };
}

test("MCP advertises its OAuth resource and Forgejo broker endpoints", async () => {
  const f = fixture();
  const challengeResponse = await f.get("/mcp");
  expect(challengeResponse.status).toBe(401);
  expect(challengeResponse.headers.get("www-authenticate")).toContain(
    "/.well-known/oauth-protected-resource/mcp",
  );
  expect(await (await f.get("/.well-known/oauth-protected-resource/mcp")).json()).toMatchObject({
    resource: "https://mcp.example/mcp",
    authorization_servers: ["https://mcp.example"],
  });
  expect(await (await f.get("/.well-known/oauth-authorization-server")).json()).toMatchObject({
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

test("the MCP SDK discovers, registers, authorizes, and calls tools over HTTP", async () => {
  const f = fixture();
  let information: OAuthClientInformationMixed | undefined;
  let tokens: OAuthTokens | undefined;
  let authorizationUrl: URL | undefined;
  let codeVerifier = "";
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:4567/callback",
    clientMetadata: {
      client_name: "SDK integration test",
      redirect_uris: ["http://127.0.0.1:4567/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    state: () => "sdk-state",
    clientInformation: () => information,
    saveClientInformation: (value) => {
      information = value;
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    redirectToAuthorization: (value) => {
      authorizationUrl = value;
    },
    saveCodeVerifier: (value) => {
      codeVerifier = value;
    },
    codeVerifier: () => codeVerifier,
  };
  const fetchFn: FetchLike = (input, init) => f.app(new Request(input, init));
  const options = { serverUrl: f.oauth.resource, scope: "forgejo:read", fetchFn };
  expect(await auth(provider, options)).toBe("REDIRECT");
  expect(information?.client_id).toBeTruthy();
  const consentPage = await f.app(new Request(authorizationUrl!));
  expect(consentPage.status).toBe(200);
  const cookie = consentPage.headers.get("set-cookie")!.split(";")[0]!;
  const transaction = (await consentPage.text()).match(/name="transaction" value="([^"]+)"/)![1]!;
  expect(
    (
      await f.post(
        "/oauth/consent",
        { transaction, decision: "allow" },
        {
          cookie,
          origin: config.publicUrl,
        },
      )
    ).status,
  ).toBe(302);
  const callback = await f.get(`/oauth/callback?state=${transaction}&code=upstream-code`, {
    cookie,
  });
  const redirect = new URL(callback.headers.get("location")!);
  expect(redirect.searchParams.get("state")).toBe("sdk-state");
  expect(
    await auth(provider, { ...options, authorizationCode: redirect.searchParams.get("code")! }),
  ).toBe("AUTHORIZED");
  expect(tokens?.access_token).toBeTruthy();
  const client = new Client({ name: "SDK integration test", version: "1.0.0" });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(f.oauth.resource), {
      authProvider: provider,
      fetch: fetchFn,
    });
    // SDK 1.30 declares sessionId as string | undefined while Transport uses
    // an optional string, which disagrees under exactOptionalPropertyTypes.
    await client.connect(transport as Transport);
    expect((await client.listTools()).tools.some((tool) => tool.name === "repo_view")).toBe(true);
    const result = await client.callTool({ name: "repo_view", arguments: { repo: "alice/demo" } });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result)).toContain("alice/demo");
  } finally {
    await client.close();
  }
});

test("Forgejo login issues independent MCP tokens, rejects replay, and revokes the whole grant", async () => {
  const f = fixture();
  const { tokens, clientId, tokenForm } = await f.login();
  expect(JSON.stringify(tokens)).not.toContain("forgejo-user-secret");
  expect(JSON.stringify(tokens)).not.toContain("forgejo-refresh-secret");
  const user = await f.oauth.authenticate(
    new Request("https://mcp.example/mcp", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }),
  );
  expect(user).toMatchObject({
    identity: { id: "1", login: "alice" },
    forgejoToken: "forgejo-user-secret",
  });
  expect((await f.post("/oauth/token", tokenForm)).status).toBe(400);
  expect(
    (await f.post("/oauth/token", { ...tokenForm, resource: "https://other.example/mcp" })).status,
  ).toBe(400);
  expect(
    (await f.post("/oauth/revoke", { token: tokens.access_token, client_id: clientId })).status,
  ).toBe(200);
  expect((await f.get("/mcp", { authorization: `Bearer ${tokens.access_token}` })).status).toBe(
    401,
  );
  expect(
    (
      await f.post("/oauth/token", {
        grant_type: "refresh_token",
        client_id: clientId,
        resource: f.oauth.resource,
        refresh_token: tokens.refresh_token,
      })
    ).status,
  ).toBe(400);
});

test("PKCE, browser binding, explicit consent, resource and redirect validation are enforced", async () => {
  const f = fixture(),
    clientId = await f.register(),
    { transaction, cookie } = await f.start(clientId);
  expect(
    (
      await f.post(
        "/oauth/consent",
        { transaction, decision: "allow" },
        { origin: config.publicUrl },
      )
    ).status,
  ).toBe(400);
  expect(
    (await f.get(`/oauth/callback?state=${transaction}&code=unexpected`, { cookie })).status,
  ).toBe(400);
  const denied = await f.post(
    "/oauth/consent",
    { transaction, decision: "deny" },
    { cookie, origin: config.publicUrl },
  );
  expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  const basic = {
    client_id: clientId,
    resource: f.oauth.resource,
    response_type: "code",
    redirect_uri: "http://127.0.0.1:4567/callback",
    code_challenge: challenge,
  };
  expect(
    (
      await f.get(
        `/oauth/authorize?${new URLSearchParams({ ...basic, code_challenge_method: "plain" })}`,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.get(
        `/oauth/authorize?${new URLSearchParams({ ...basic, code_challenge_method: "S256", redirect_uri: "https://attacker.example" })}`,
      )
    ).status,
  ).toBe(400);
  const first = await f.start(clientId);
  await f.post(
    "/oauth/consent",
    { transaction: first.transaction, decision: "allow" },
    { cookie: first.cookie, origin: config.publicUrl },
  );
  expect(
    (await f.get(`/oauth/callback?state=${first.transaction}&code=upstream-code`)).status,
  ).toBe(400);
  const callback = await f.get(`/oauth/callback?state=${first.transaction}&code=upstream-code`, {
    cookie: first.cookie,
  });
  const code = new URL(callback.headers.get("location")!).searchParams.get("code")!;
  const form = {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    resource: f.oauth.resource,
    redirect_uri: basic.redirect_uri,
  };
  expect((await f.post("/oauth/token", { ...form, code_verifier: "b".repeat(43) })).status).toBe(
    400,
  );
  const otherClient = await f.register();
  expect(
    (await f.post("/oauth/token", { ...form, code_verifier: verifier, client_id: otherClient }))
      .status,
  ).toBe(400);
  expect((await f.post("/oauth/token", { ...form, code_verifier: verifier })).status).toBe(200);
});

test("refresh rotates MCP tokens, rejects concurrent replay, and cannot widen scopes", async () => {
  const f = fixture(),
    { clientId, tokens } = await f.login("forgejo:read");
  const form = {
    grant_type: "refresh_token",
    client_id: clientId,
    resource: f.oauth.resource,
    refresh_token: tokens.refresh_token,
  };
  expect((await f.post("/oauth/token", { ...form, scope: "forgejo:write" })).status).toBe(400);
  const responses = await Promise.all([f.post("/oauth/token", form), f.post("/oauth/token", form)]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
  const rotated = await responses.find((response) => response.status === 200)!.json();
  expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
  expect(rotated.scope).toBe("forgejo:read");
  expect((await f.get("/mcp", { authorization: `Bearer ${rotated.access_token}` })).status).toBe(
    401,
  );
});

test("parallel calls share one upstream refresh without sharing another user's credentials", async () => {
  const f = fixture({}, 1),
    { tokens } = await f.login();
  const request = () =>
    new Request("https://mcp.example/mcp", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
  const users = await Promise.all([
    f.oauth.authenticate(request()),
    f.oauth.authenticate(request()),
  ]);
  expect(users.every((user) => user?.identity.login === "alice")).toBe(true);
  expect(f.counts().refreshes).toBe(1);
});

test("HTTP MCP tools use the shared core and signed per-user mutation approvals", async () => {
  const f = fixture(),
    first = await f.login();
  const initialized = await f.rpc(first.tokens.access_token, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  expect(initialized.serverInfo.name).toBe("forgejo");
  const tools = await f.rpc(first.tokens.access_token, "tools/list");
  const names = tools.tools.map((tool: { name: string }) => tool.name);
  expect(names).toContain("repo_view");
  expect(names).toContain("repo_delete");
  expect(names).not.toContain("pr_checkout");
  expect(names).not.toContain("api");
  const view = await f.rpc(first.tokens.access_token, "tools/call", {
    name: "repo_view",
    arguments: { repo: "alice/demo" },
  });
  expect(view.structuredContent.status).toBe("success");
  const rejected = await f.rpc(first.tokens.access_token, "tools/call", {
    name: "repo_view",
    arguments: { repo: "alice/demo", host: "https://attacker.example" },
  });
  expect(rejected.isError).toBe(true);
  const planned = await f.rpc(first.tokens.access_token, "tools/call", {
    name: "repo_delete",
    arguments: { repo: "alice/demo" },
  });
  const outcome = planned.structuredContent as CommandOutcome;
  expect(outcome.error?.code).toBe("approval.required");
  expect(f.counts().writes).toBe(0);
  const approval = outcome.next_steps.find((step) => step.action === "approve")!;
  if (approval.action !== "approve") throw new Error("Missing approval");
  const second = await f.login(undefined, "bob-code");
  expect(
    await f.oauth.authenticate(
      new Request("https://mcp.example/mcp", {
        headers: { authorization: `Bearer ${second.tokens.access_token}` },
      }),
    ),
  ).toMatchObject({ identity: { id: "2", login: "bob" }, forgejoToken: "bob-user-secret" });
  const crossUser = await f.rpc(second.tokens.access_token, "tools/call", {
    name: "repo_delete",
    arguments: { repo: "alice/demo", _approval: approval.grant },
  });
  expect(crossUser.structuredContent.error.code).toBe("approval.required");
  expect(f.counts().writes).toBe(0);
  const executed = await f.rpc(first.tokens.access_token, "tools/call", {
    name: "repo_delete",
    arguments: { repo: "alice/demo", _approval: approval.grant },
  });
  expect(executed.structuredContent.status).toBe("success");
  expect(f.counts().writes).toBe(1);
});

test("read-only policy hides writes and rejects direct calls to them", async () => {
  const f = fixture({ readOnly: true }),
    { tokens } = await f.login("forgejo:read");
  const tools = await f.rpc(tokens.access_token, "tools/list");
  expect(
    tools.tools.every(
      (tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint,
    ),
  ).toBe(true);
  const direct = await f.rpc(tokens.access_token, "tools/call", {
    name: "repo_delete",
    arguments: { repo: "alice/demo" },
  });
  expect(direct.isError).toBe(true);
  expect(f.counts().writes).toBe(0);
});

test("HTTP rejects hostile origins, oversized bodies, invalid hosts and registration floods", async () => {
  const f = fixture();
  expect((await f.get("/mcp", { origin: "https://attacker.example" })).status).toBe(403);
  expect((await f.get("/mcp", { host: "attacker.example" })).status).toBe(421);
  expect(
    (
      await f.app(
        new Request("https://mcp.example/mcp", {
          method: "POST",
          body: "x".repeat(1024 * 1024 + 1),
        }),
      )
    ).status,
  ).toBe(413);
  for (let i = 0; i < 30; i++) await f.register();
  expect(
    (await f.app(new Request("https://mcp.example/oauth/register", { method: "POST" }))).status,
  ).toBe(429);
});

test("encrypted OAuth state survives reopening and detects the wrong encryption key", async () => {
  const directory = await mkdtemp("/private/tmp/forgejo-oauth-test-");
  directories.push(directory);
  const path = join(directory, "oauth.sqlite"),
    key = config.encryptionKey;
  const store = new OAuthStore(path, key);
  store.put("grant", "test-user", { token: "sensitive-forgejo-token" }, Date.now() + 60_000);
  store.close();
  expect((await readFile(path)).includes(Buffer.from("sensitive-forgejo-token"))).toBe(false);
  const reopened = new OAuthStore(path, key);
  stores.push(reopened);
  expect(reopened.get<{ token: string }>("grant", "test-user")).toEqual({
    token: "sensitive-forgejo-token",
  });
  expect(() => new OAuthStore(path, randomBytes(32).toString("base64"))).toThrow();
});

test("configuration accepts one explicit Forgejo host and requires secrets", () => {
  expect(() => readConfig({})).toThrow("MCP_PUBLIC_URL");
  expect(
    readConfig({
      MCP_PUBLIC_URL: "https://mcp.example",
      FORGEJO_HOST: "https://forgejo.example",
      FORGEJO_OAUTH_CLIENT_ID: "id",
      FORGEJO_OAUTH_CLIENT_SECRET: "secret",
      MCP_ENCRYPTION_KEY: config.encryptionKey,
    }).readOnly,
  ).toBe(true);
});
