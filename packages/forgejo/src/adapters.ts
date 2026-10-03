/** Filesystem operations available to runtime adapters. */
export type FileSystem = {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  directoryStatus(path: string): Promise<"missing" | "empty" | "nonempty">;
  list: ((path: string) => Promise<string[]>) | undefined;
};
/** Non-shell process execution seam. */
export type ProcessRunner = {
  run(
    argv: string[],
    options: {
      cwd: string;
      timeout_ms: number;
      stdin: Uint8Array | undefined;
      environment: Record<string, string> | undefined;
    },
  ): Promise<{ exit_code: number; stdout: string; stderr: string }>;
};
/** Credential seam that intentionally exposes no listing primitive. */
export type CredentialStore = {
  get(host: string): Promise<string | undefined>;
  put(host: string, token: string): Promise<void>;
  remove(host: string): Promise<void>;
};
/** Terminal seam used only by Human-mode adapters. */
export type Terminal = { isTty: boolean; confirm(message: string): Promise<boolean> };
/** Clock seam used for approvals, timeouts, and cache freshness. */
export type Clock = { now(): Date };
/**
 * Byte-safe output destination seam.
 *
 * A placement either lands every byte it was handed or throws, so the checksum bounded delivery
 * reports for the returned path describes exactly what is now at that path. `stream` carries the
 * same guarantee for content that is never buffered, which is how bulk content larger than the
 * client's read bound still reaches a caller.
 */
export type OutputStore = {
  write(bytes: Uint8Array, destination: string | undefined): Promise<string>;
  stream(body: ReadableStream<Uint8Array>, destination: string | undefined): Promise<string>;
};
/**
 * Filesystem primitives an Output store needs to place one delivered file.
 *
 * `writeStream` consumes its body without collecting it, and leaves the destination either
 * complete or absent: a half-written archive that looks like a whole one is worse than no file,
 * so an implementation that can be interrupted part way places the bytes elsewhere first.
 */
export type OutputFileSystem = {
  makeDirectory(path: string): Promise<void>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  writeStream(path: string, body: ReadableStream<Uint8Array>): Promise<void>;
  temporaryFile(): Promise<string>;
};
/**
 * Creates an Output store that places bytes at a requested path.
 *
 * The parent directory is created because a caller naming a download directory has asked for that
 * directory, and a missing one is not a reason to fail a retrieved artifact. A destination that
 * names no directory is written where the caller stands, so nothing is created for it.
 *
 * @param filesystem Concrete placement primitives.
 * @returns An Output store over that filesystem.
 */
export function createOutputStore(filesystem: OutputFileSystem): OutputStore {
  const resolve = async (destination: string | undefined): Promise<string> => {
    const path = destination ?? (await filesystem.temporaryFile());
    const separator = path.lastIndexOf("/");
    if (separator > 0) await filesystem.makeDirectory(path.slice(0, separator));
    return path;
  };
  return {
    write: async (bytes, destination) => {
      const path = await resolve(destination);
      await filesystem.write(path, bytes);
      return path;
    },
    stream: async (body, destination) => {
      const path = await resolve(destination);
      await filesystem.writeStream(path, body);
      return path;
    },
  };
}
/**
 * Abandons the rest of a body that will not be read, never failing for it.
 *
 * A cancel that rejects must not decide how an operation is reported: the size, the status, or
 * the placement failure was already established, and letting a failed cleanup throw would report
 * something no caller can act on in place of the reason the body was dropped.
 *
 * @param source A stream or reader that is finished with, if there is one at all.
 */
export async function abandonBody(
  source: { cancel(): Promise<unknown> } | null | undefined,
): Promise<void> {
  try {
    await source?.cancel();
  } catch {
    return;
  }
}

/**
 * Creates the production Output filesystem over real files.
 *
 * It lives here rather than inline at the composition root so the placement guarantees the
 * `OutputFileSystem` contract states are exercised by tests rather than only asserted in prose.
 *
 * @param primitives Node filesystem calls, injected so a test can drive the failure paths.
 * @returns Placement primitives an Output store can use directly.
 */
export function createFileOutputFileSystem(primitives: {
  makeDirectory(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, bytes: Uint8Array, options: { mode: number }): Promise<void>;
  open(path: string, flags: string, mode: number): Promise<FileWriteHandle>;
  remove(path: string, options: { force: true }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  makeTemporaryDirectory(prefix: string): Promise<string>;
  temporaryRoot(): string;
  uniqueSuffix(): string;
}): OutputFileSystem {
  return {
    makeDirectory: async (path) => void (await primitives.makeDirectory(path, { recursive: true })),
    write: (path, bytes) => primitives.writeFile(path, bytes, { mode: 0o600 }),
    // Streamed content lands beside its destination and is renamed once it is whole, so an
    // interrupted download leaves nothing at the path a caller was told to read rather than a
    // truncated archive that reports as complete. The temporary file is a sibling because a
    // rename is only atomic, and only succeeds at all, within one filesystem.
    writeStream: async (path, body) => {
      const temporary = `${path}.${primitives.uniqueSuffix()}.part`;
      const handle = await primitives.open(temporary, "wx", 0o600);
      try {
        for await (const chunk of body) {
          const { bytesWritten } = await handle.write(chunk);
          // The contract this store publishes is all the bytes or none, so a short write is a
          // failure rather than a file whose reported checksum describes bytes it does not hold.
          if (bytesWritten !== chunk.byteLength) throw new Error("output.write_incomplete");
        }
        await handle.close();
        await primitives.rename(temporary, path);
      } catch (error) {
        // Closing and renaming are inside the same attempt as the write, so a failure at either
        // takes the temporary file with it instead of leaving one in the caller's download
        // directory. Cleanup must not replace the reason the delivery failed, which is the only
        // thing a caller can act on, so neither step may throw over it, and closing a handle that
        // already closed is one of the things being swallowed here.
        await abandon(handle.close());
        await abandon(primitives.remove(temporary, { force: true }));
        throw error;
      }
    },
    temporaryFile: async () =>
      `${await primitives.makeTemporaryDirectory(`${primitives.temporaryRoot()}/forgejo-output-`)}/output`,
  };
}
/** A file handle an Output filesystem writes one delivered stream through. */
export type FileWriteHandle = {
  write(chunk: Uint8Array): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
};
async function abandon(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch {
    return;
  }
}
/** Deterministic in-memory filesystem adapter for foundation tests. */
export function memoryFileSystem(initial: Record<string, Uint8Array> = {}): FileSystem {
  const files = new Map(Object.entries(initial));
  return {
    read: async (path) => {
      const value = files.get(path);
      if (!value) throw new Error("File not found");
      return value;
    },
    write: async (path, bytes) => {
      files.set(path, bytes);
    },
    directoryStatus: async () => "missing",
    list: undefined,
  };
}
/** Deterministic in-memory credential adapter for foundation tests. */
export function memoryCredentials(initial: Record<string, string> = {}): CredentialStore {
  const credentials = new Map(Object.entries(initial));
  return {
    get: async (host) => credentials.get(host),
    put: async (host, token) => {
      credentials.set(host, token);
    },
    remove: async (host) => {
      credentials.delete(host);
    },
  };
}
