import { createHash } from "node:crypto";

type Dependencies = Record<string, string>;
type Metadata = {
  dependencies?: Dependencies;
  optionalDependencies?: Dependencies;
  peerDependencies?: Dependencies;
  optionalPeers?: string[];
  os?: string;
  cpu?: string;
};
type Lock = {
  lockfileVersion: number;
  configVersion: number;
  workspaces: Record<string, { name: string; dependencies?: Dependencies }>;
  packages: Record<string, [string, string, Metadata, string?]>;
};
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const safeLocation = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/i;

/** Project the production dependency closure, without installing or resolving versions. */
export function nixDependencies(source: string) {
  const lock = Bun.JSONC.parse(source) as Lock;
  if (lock.lockfileVersion !== 2 || lock.configVersion !== 1) {
    throw new Error("Unsupported Bun lockfile format");
  }
  const workspaces = Object.entries(lock.workspaces)
    .filter(([path]) => path !== "")
    .map(([path, workspace]) => {
      if (!/^packages\/[a-z0-9-]+$/.test(path) || !packageName.test(workspace.name)) {
        throw new Error(`Unsafe workspace: ${path}`);
      }
      return { path, name: workspace.name };
    });
  const workspaceNames = new Set(workspaces.map(({ name }) => name));
  const visited = new Set<string>();
  const pending: string[] = [];
  const enqueue = (name: string, owner: string, optional = false) => {
    if (!packageName.test(name)) throw new Error(`Unsafe package name: ${name}`);
    if (workspaceNames.has(name)) return;
    // Bun's nested lock keys describe package ancestry, not node_modules paths.
    let parent = owner;
    while (parent) {
      const candidate = `${parent}/${name}`;
      if (lock.packages[candidate]) {
        pending.push(candidate);
        return;
      }
      const parts = parent.split("/");
      parts.splice(parts.at(-2)?.startsWith("@") ? -2 : -1);
      parent = parts.join("/");
    }
    if (lock.packages[name]) pending.push(name);
    else if (!optional)
      throw new Error(`Missing locked dependency: ${name} (from ${owner || "workspace"})`);
  };
  for (const { path } of workspaces) {
    for (const name of Object.keys(lock.workspaces[path]!.dependencies ?? {})) enqueue(name, "");
  }
  while (pending.length) {
    const location = pending.pop()!;
    if (visited.has(location)) continue;
    if (
      !safeLocation.test(location) ||
      location.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error(`Unsafe package location: ${location}`);
    }
    visited.add(location);
    const entry = lock.packages[location]!;
    const metadata = entry[2];
    if (metadata.os || metadata.cpu)
      throw new Error(`Platform-specific production dependency: ${location}`);
    for (const name of Object.keys(metadata.dependencies ?? {})) enqueue(name, location);
    for (const name of Object.keys(metadata.optionalDependencies ?? {}))
      enqueue(name, location, true);
    for (const name of Object.keys(metadata.peerDependencies ?? {})) {
      enqueue(name, location, metadata.optionalPeers?.includes(name));
    }
  }
  const dependencies = [...visited].sort().map((location) => {
    const [specifier, registry, , hash] = lock.packages[location]!;
    const match = /^(.*)@([^@]+)$/.exec(specifier);
    if (
      !match ||
      !packageName.test(match[1]!) ||
      !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(match[2]!)
    ) {
      throw new Error(`Non-registry dependency: ${location}`);
    }
    if (registry !== "" || !hash || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(hash)) {
      throw new Error(`Missing integrity or unsupported registry: ${location}`);
    }
    const name = match[1]!;
    const version = match[2]!;
    return {
      location: location
        .split("/")
        .reduce<string[]>((parts, part) => {
          if (part.startsWith("@")) parts.push(part);
          else {
            parts.push(part, "node_modules");
          }
          return parts;
        }, [])
        .slice(0, -1)
        .join("/"),
      url: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`,
      hash,
    };
  });
  return { lockHash: createHash("sha256").update(source).digest("hex"), workspaces, dependencies };
}

if (import.meta.main) {
  const manifest = `${JSON.stringify(nixDependencies(await Bun.file("bun.lock").text()), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (manifest !== (await Bun.file("nix/dependencies.json").text())) {
      throw new Error("Nix dependency manifest is stale; run bun run generate:nix");
    }
  } else {
    process.stdout.write(manifest);
  }
}
