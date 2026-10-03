import { expect, test } from "bun:test";
import { createAuthCatalog, execute } from "../packages/forgejo/src/runtime";
import { run } from "../packages/forgejo-cli/src/cli";
import type { HumanInterface } from "../packages/forgejo-cli/src/human-interface";
import {
  emptyHostConfig,
  HostSession,
  normalizeDeploymentUrl,
  parseHostConfig,
  type HostConfig,
  type HostCredentialStore,
} from "../packages/forgejo/src/host-session";

const account = "https://forgejo.example/prefix";
const credentials = (initial: Record<string, string> = {}): HostCredentialStore => {
  const values = new Map(Object.entries(initial));
  return {
    get: async (_service, host) => values.get(host),
    put: async (_service, host, token) => {
      values.set(host, token);
    },
    remove: async (_service, host) => {
      values.delete(host);
    },
  };
};
const inspector = {
  inspect: async () => ({
    version: "16.0.2",
    identity: { id: "42", login: "octo" },
    swagger: JSON.stringify({ paths: { "/user": { get: { operationId: "getUser" } } } }),
  }),
};

function session(initial = emptyHostConfig(), credentialStore = credentials()) {
  let config: HostConfig = initial;
  return {
    config: () => config,
    session: new HostSession(
      { load: async () => config, save: async (next) => void (config = next) },
      credentialStore,
      inspector,
      [{ operation_id: "getUser", method: "GET", path: "/user" }],
      () => new Date("2025-01-01T00:00:00.000Z"),
    ),
  };
}

test("normalizes only valid Forgejo Deployment URLs", () => {
  expect(normalizeDeploymentUrl("https://FORGEJO.example:443/prefix/")).toBe(account);
  expect(() => normalizeDeploymentUrl("https://forgejo.example/api/v1")).toThrow(
    "host.api_root_not_allowed",
  );
  expect(() => normalizeDeploymentUrl("http://forgejo.example")).toThrow("host.insecure_url");
  expect(normalizeDeploymentUrl("http://localhost:3000/")).toBe("http://localhost:3000");
});

test("strict configuration rejects duplicate normalized hosts and unknown fields", () => {
  expect(() => parseHostConfig('{"schema_version":1,"hosts":[],"extra":true}')).toThrow(
    "config.invalid",
  );
  expect(() =>
    parseHostConfig(
      '{"schema_version":1,"hosts":[{"url":"https://forgejo.example","identity":null,"server_version":null,"swagger_sha256":null},{"url":"https://forgejo.example/","identity":null,"server_version":null,"swagger_sha256":null}]}',
    ),
  ).toThrow("config.duplicate_host");
  expect(() => parseHostConfig('{"schema_version":1,"schema_version":1,"hosts":[]}')).toThrow(
    "config.invalid",
  );
});

test("login persists a validated profile without ever returning the token", async () => {
  const target = session();
  const login = await target.session.login(`${account}/`, "synthetic-secret", true);
  expect(login.profile).toEqual({
    url: account,
    identity: { id: "42", login: "octo" },
    server_version: "16.0.2",
    swagger_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(login.git_config).toBe("not_configured");
  expect(JSON.stringify(target.config())).not.toContain("synthetic-secret");
  expect((await target.session.status("forgejo.example", true)).credential_present).toBe(true);
});

test("a failed profile write restores the preceding credential", async () => {
  const previous = "previous-secret";
  const credentialStore = credentials({ [account]: previous });
  const target = new HostSession(
    {
      load: async () => emptyHostConfig(),
      save: async () => Promise.reject(new Error("disk full")),
    },
    credentialStore,
    inspector,
    [{ operation_id: "getUser", method: "GET", path: "/user" }],
    () => new Date("2025-01-01T00:00:00.000Z"),
  );
  await expect(target.login(account, "replacement-secret", true)).rejects.toThrow("disk full");
  expect(await credentialStore.get("dev.wyattjoh.forgejo-cli.token", account, true)).toBe(previous);
});

test("auth catalog keeps login tokens out of dry-run effects", async () => {
  const target = session();
  const outcome = await execute(
    {
      command: "auth login",
      input: { url: account, token: "synthetic-secret" },
      requestId: "auth-1",
      approval: undefined,
      dryRun: true,
      mode: "request",
    },
    createAuthCatalog(),
    {
      gateway: { smoke: async ({ value }) => ({ echoed: value }) },
      host: target.session,
      repositories: undefined,
      git: undefined,
      environment: {},
      cwd: "/tmp",
      keychainNoUi: true,
      clock: { now: () => new Date("2025-01-01T00:00:00.000Z") },
      cancelled: () => false,
    },
  );
  expect(outcome.status).toBe("success");
  expect(JSON.stringify(outcome.effects)).not.toContain("synthetic-secret");
});

test("CLI Human and Request seams route auth login without accepting token argv", async () => {
  const target = session();
  const dependencies = {
    catalog: createAuthCatalog(),
    human: undefined,
    capabilities: {
      gateway: { smoke: async ({ value }: { value: string }) => ({ echoed: value }) },
      host: target.session,
      repositories: undefined,
      git: undefined,
      environment: {},
      cwd: "/tmp",
      keychainNoUi: true,
      clock: { now: () => new Date("2025-01-01T00:00:00.000Z") },
      cancelled: () => false,
    },
  };
  let human = "";
  expect(
    await run(
      ["auth", "login", "--url", account, "--token-stdin", "--dry-run"],
      "synthetic-secret\n",
      (text) => (human += text),
      () => {},
      dependencies,
    ),
  ).toBe(0);
  let request = "";
  expect(
    await run(
      ["auth", "login", "--input-output", "json", "--dry-run"],
      JSON.stringify({
        schema_version: 1,
        request_id: "auth-2",
        input: { url: account, token: "synthetic-secret" },
      }),
      (text) => (request += text),
      () => {},
      dependencies,
    ),
  ).toBe(0);
  expect(human).not.toContain("synthetic-secret");
  expect(request).not.toContain("synthetic-secret");
  expect(
    await run(
      ["auth", "login", "--url", account, "--token", "synthetic-secret"],
      "",
      () => {},
      () => {},
      dependencies,
    ),
  ).toBe(2);
});

test("interactive auth login prompts for a masked token when --token-stdin is omitted", async () => {
  const target = session();
  let passwordPrompts = 0;
  let rendered = "";
  const human = {
    isInteractive: true,
    password: async () => {
      passwordPrompts += 1;
      return "synthetic-secret";
    },
    select: async () => undefined,
    confirm: async () => false,
    render: (outcome) => {
      rendered = JSON.stringify(outcome);
    },
  } satisfies HumanInterface;
  const exit = await run(
    ["auth", "login", "--url", account, "--dry-run"],
    "",
    () => {},
    () => {},
    {
      catalog: createAuthCatalog(),
      human,
      capabilities: {
        gateway: { smoke: async ({ value }) => ({ echoed: value }) },
        host: target.session,
        repositories: undefined,
        git: undefined,
        environment: {},
        cwd: "/tmp",
        keychainNoUi: true,
        clock: { now: () => new Date("2025-01-01T00:00:00.000Z") },
        cancelled: () => false,
      },
    },
  );
  expect(exit).toBe(0);
  expect(passwordPrompts).toBe(1);
  expect(rendered).not.toContain("synthetic-secret");
});

test("logout is scoped, preserves the profile, and clears only its active identity", async () => {
  const target = session();
  await target.session.login(account, "synthetic-secret", true);
  const loggedOut = await target.session.logout(account, true);
  expect(loggedOut.identity).toBeNull();
  expect(target.config().hosts).toHaveLength(1);
  expect((await target.session.status(account, true)).credential_present).toBe(false);
});
