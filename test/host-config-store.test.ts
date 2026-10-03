import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostConfigStore,
  forgejoConfigRoot,
} from "../packages/forgejo-cli/src/host-config-store";

test("config roots honour only absolute Forgejo overrides", () => {
  expect(forgejoConfigRoot({ FORGEJO_CONFIG_DIR: "/tmp/forgejo" }, "/Users/test")).toBe(
    "/tmp/forgejo",
  );
  expect(forgejoConfigRoot({}, "/Users/test")).toBe("/Users/test/.config/forgejo");
  expect(() => forgejoConfigRoot({ FORGEJO_CONFIG_DIR: "relative" }, "/Users/test")).toThrow(
    "config.relative_override",
  );
});

test("config persistence writes strict JSON into a private configuration root", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgejo-config-"));
  try {
    const store = createHostConfigStore(join(root, "forgejo"));
    await store.save({ schema_version: 1, hosts: [] });
    expect(await store.load()).toEqual({ schema_version: 1, hosts: [] });
    expect((await stat(join(root, "forgejo", "config.json"))).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
