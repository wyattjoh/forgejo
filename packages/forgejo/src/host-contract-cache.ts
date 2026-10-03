import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { responseReadLimit, type ContractCache } from "./infrastructure";

/** A cached, validated advertised contract for one normalized Deployment URL. */
export type HostContractCache = {
  url: string;
  swagger: string;
  cache: ContractCache;
};
/** Persistence boundary for bounded advertised Swagger contracts. */
export type HostContractCacheStore = {
  load(url: string): Promise<HostContractCache | undefined>;
  save(entry: HostContractCache): Promise<void>;
  remove(url: string): Promise<void>;
};

/**
 * Resolves the Forgejo XDG cache root, including its test-only absolute override.
 *
 * @param environment Environment values to inspect.
 * @param home Home directory used when XDG_CACHE_HOME is absent.
 * @returns The absolute cache root.
 */
export function forgejoCacheRoot(
  environment: Record<string, string | undefined>,
  home: string,
): string {
  const override = environment.FORGEJO_CACHE_DIR;
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new Error("cache.relative_override");
    return override;
  }
  return join(environment.XDG_CACHE_HOME ?? join(home, ".cache"), "forgejo");
}

/**
 * Creates a permissioned, same-directory atomic contract-cache store.
 *
 * @param root Absolute Forgejo cache root.
 * @returns A contract-cache persistence adapter.
 */
export function createHostContractCacheStore(root: string): HostContractCacheStore {
  const pathFor = (url: string) =>
    join(root, `${createHash("sha256").update(url).digest("hex")}.json`);
  return {
    load: async (url) => {
      const path = pathFor(url);
      try {
        const metadata = await lstat(path);
        assertSafeMetadata(metadata, "cache.unsafe_file");
        const parsed = JSON.parse(await Bun.file(path).text()) as HostContractCache;
        if (
          parsed.url !== url ||
          typeof parsed.swagger !== "string" ||
          !parsed.cache ||
          typeof parsed.cache.fingerprint !== "string"
        )
          throw new Error("cache.corrupt");
        return parsed;
      } catch (error) {
        if (isMissing(error)) return undefined;
        if (error instanceof Error && error.message.startsWith("cache.")) throw error;
        throw new Error("cache.corrupt");
      }
    },
    save: async (entry) => {
      if (Buffer.byteLength(entry.swagger) > responseReadLimit) throw new Error("cache.too_large");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await lstat(root);
      assertSafeMetadata(directory, "cache.unsafe_directory");
      if (!directory.isDirectory()) throw new Error("cache.unsafe_directory");
      await chmod(root, 0o700);
      const path = pathFor(entry.url);
      const temporary = join(
        root,
        `.${createHash("sha256").update(path).digest("hex")}.${crypto.randomUUID()}.tmp`,
      );
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(entry)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      await chmod(path, 0o600);
      const directoryHandle = await open(root, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    },
    remove: async (url) => {
      try {
        await unlink(pathFor(url));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
  };
}

function assertSafeMetadata(metadata: Awaited<ReturnType<typeof lstat>>, code: string): void {
  const owner = process.getuid?.();
  if (metadata.isSymbolicLink() || owner === undefined || metadata.uid !== owner)
    throw new Error(code);
}
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}
