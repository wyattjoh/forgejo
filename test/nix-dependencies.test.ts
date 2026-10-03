import { describe, expect, test } from "bun:test";
import { nixDependencies } from "../scripts/nix-dependencies";

const hash = `sha512-${"A".repeat(86)}==`;
const fixture = () => ({
  lockfileVersion: 2,
  configVersion: 1,
  workspaces: {
    "": { name: "root", devDependencies: { dev: "1" } },
    "packages/app": { name: "@test/app", dependencies: { parent: "1" } },
  },
  packages: {
    parent: [
      "parent@1.0.0",
      "",
      {
        dependencies: { child: "2" },
        peerDependencies: { absent: "1" },
        optionalPeers: ["absent"],
      },
      hash,
    ],
    "parent/child": ["child@2.0.0", "", {}, hash],
    child: ["child@1.0.0", "", {}, hash],
    dev: ["dev@1.0.0", "", {}, hash],
  },
});
describe("Nix production dependency projection", () => {
  test("preserves nested resolution and excludes dev dependencies", () => {
    const output = nixDependencies(JSON.stringify(fixture()));
    expect(output.dependencies.map((dep) => dep.location)).toEqual([
      "parent",
      "parent/node_modules/child",
    ]);
    expect(output.dependencies[1]!.url).toEndWith("child-2.0.0.tgz");
  });
  test("requires every nonoptional dependency and integrity", () => {
    const lock = fixture();
    delete (lock.packages as Record<string, unknown>)["parent/child"];
    delete (lock.packages as Record<string, unknown>).child;
    expect(() => nixDependencies(JSON.stringify(lock))).toThrow("Missing locked dependency");
    expect(() => nixDependencies(JSON.stringify(fixture()).replaceAll(hash, ""))).toThrow(
      "Missing integrity",
    );
  });
  test("fails closed on unsafe paths and unknown lock versions", () => {
    const lock = fixture();
    (lock.workspaces as Record<string, unknown>)["packages/../escape"] = { name: "escape" };
    expect(() => nixDependencies(JSON.stringify(lock))).toThrow("Unsafe workspace");
    expect(() => nixDependencies(JSON.stringify({ ...fixture(), lockfileVersion: 3 }))).toThrow(
      "Unsupported Bun lockfile",
    );
  });
  test("committed manifest matches the lock", async () => {
    expect(nixDependencies(await Bun.file("bun.lock").text())).toEqual(
      await Bun.file("nix/dependencies.json").json(),
    );
  });
});
