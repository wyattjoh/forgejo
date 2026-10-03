import { chmod, lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { parseHostConfig, type HostProfileStore } from "@wyattjoh/forgejo/internal/host-session";

const encoder = new TextEncoder();

/**
 * Resolves the Forgejo XDG configuration root, including its test-only absolute override.
 *
 * @param environment Environment values to inspect.
 * @param home Home directory used when XDG_CONFIG_HOME is absent.
 * @returns The absolute configuration root.
 */
export function forgejoConfigRoot(
  environment: Record<string, string | undefined>,
  home: string,
): string {
  const override = environment.FORGEJO_CONFIG_DIR;
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new Error("config.relative_override");
    return override;
  }
  return join(environment.XDG_CONFIG_HOME ?? join(home, ".config"), "forgejo");
}

/**
 * Creates the strict, permissioned, same-directory atomic Host profile store.
 *
 * @param root Absolute Forgejo configuration root.
 * @returns A Host profile persistence adapter.
 */
export function createHostConfigStore(root: string): HostProfileStore {
  const path = join(root, "config.json");
  return {
    load: async () => {
      try {
        const metadata = await lstat(path);
        assertSafeMetadata(metadata, "config.unsafe_file");
        try {
          return parseHostConfig(await Bun.file(path).text());
        } catch {
          throw new Error("config.corrupt");
        }
      } catch (error) {
        if (isMissing(error)) return { schema_version: 1, hosts: [] };
        throw error;
      }
    },
    save: async (config) => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await lstat(root);
      assertSafeMetadata(directory, "config.unsafe_directory");
      if (!directory.isDirectory()) throw new Error("config.unsafe_directory");
      await chmod(root, 0o700);
      const temporary = join(dirname(path), `.config.${crypto.randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(encoder.encode(`${JSON.stringify(config, null, 2)}\n`));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      const rootHandle = await open(root, "r");
      try {
        await rootHandle.sync();
      } finally {
        await rootHandle.close();
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
