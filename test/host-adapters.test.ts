import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostContractCacheStore,
  forgejoCacheRoot,
} from "../packages/forgejo/src/host-contract-cache";
import { createHostConfigStore } from "../packages/forgejo-cli/src/host-config-store";
import { createHttpHostInspector } from "../packages/forgejo/src/host-inspector";
import {
  createSecretsCredentialStore,
  type SecretsPort,
} from "../packages/forgejo-cli/src/credential-store";

const host = "https://forgejo.example/prefix";

test("HTTP host inspection fetches version, identity, and Swagger without exposing its token", async () => {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const inspector = createHttpHostInspector(async (input, init) => {
    const url = String(input);
    seen.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
    if (url.endsWith("/version")) return Response.json({ version: "16.0.2" });
    if (url.endsWith("/user")) return Response.json({ id: 42, login: "octo" });
    return new Response('{"paths":{}}');
  });
  await expect(inspector.inspect(host, "synthetic-secret")).resolves.toEqual({
    version: "16.0.2",
    identity: { id: "42", login: "octo" },
    swagger: '{"paths":{}}',
  });
  expect(seen).toEqual([
    { url: `${host}/api/v1/version`, authorization: null },
    { url: `${host}/api/v1/user`, authorization: "token synthetic-secret" },
    { url: `${host}/swagger.v1.json`, authorization: "token synthetic-secret" },
  ]);
});

test("contract cache honors XDG root and persists a bounded contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgejo-cache-"));
  try {
    expect(forgejoCacheRoot({ FORGEJO_CACHE_DIR: root }, "/Users/test")).toBe(root);
    expect(() => forgejoCacheRoot({ FORGEJO_CACHE_DIR: "relative" }, "/Users/test")).toThrow(
      "cache.relative_override",
    );
    const store = createHostContractCacheStore(root);
    await store.save({
      url: host,
      swagger: '{"paths":{}}',
      cache: {
        fingerprint: "a".repeat(64),
        observed_at: "2025-01-01T00:00:00.000Z",
        compatible: true,
        missing_operations: [],
        quarantined: false,
      },
    });
    expect(await store.load(host)).toMatchObject({ url: host, swagger: '{"paths":{}}' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("config corruption is mapped to a stable recovery error", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgejo-config-corrupt-"));
  try {
    await writeFile(join(root, "config.json"), "{");
    await expect(createHostConfigStore(root).load()).rejects.toThrow("config.corrupt");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("secrets credential store reads, writes, and removes the Host token by URL", async () => {
  const service = "dev.wyattjoh.forgejo-cli.token";
  const items = new Map<string, string>();
  const calls: string[] = [];
  const secrets: SecretsPort = {
    get: async (options) => {
      calls.push(`get ${options.service} ${options.name}`);
      return items.get(options.name) ?? null;
    },
    set: async (options) => {
      calls.push(`set ${options.service} ${options.name}`);
      items.set(options.name, options.value);
    },
    delete: async (options) => {
      calls.push(`delete ${options.service} ${options.name}`);
      return items.delete(options.name);
    },
  };
  const credentials = createSecretsCredentialStore(secrets);
  await expect(credentials.get(service, host, true)).resolves.toBeUndefined();
  await credentials.put(service, host, "synthetic-secret", true);
  await expect(credentials.get(service, host, true)).resolves.toBe("synthetic-secret");
  await credentials.remove(service, host, true);
  await expect(credentials.get(service, host, true)).resolves.toBeUndefined();
  await credentials.remove(service, host, true);
  expect(calls).toEqual([
    `get ${service} ${host}`,
    `set ${service} ${host}`,
    `get ${service} ${host}`,
    `delete ${service} ${host}`,
    `get ${service} ${host}`,
    `delete ${service} ${host}`,
  ]);
  await expect(credentials.put(service, host, "", true)).rejects.toThrow("auth.token_empty");
  await expect(credentials.get("other", host, true)).rejects.toThrow("keychain.invalid_service");
});

test("secrets credential store maps secret store failures to a stable code", async () => {
  const failure = async () => {
    throw new Error("libsecret-1.so.0: cannot open shared object file: synthetic-secret");
  };
  const credentials = createSecretsCredentialStore({ get: failure, set: failure, delete: failure });
  const service = "dev.wyattjoh.forgejo-cli.token";
  for (const operation of [
    credentials.get(service, host, true),
    credentials.put(service, host, "synthetic-secret", true),
    credentials.remove(service, host, true),
  ]) {
    const error = await operation.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("keychain.failed");
  }
});
