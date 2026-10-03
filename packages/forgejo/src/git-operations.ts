import { boundDiagnostics } from "./infrastructure";
import type { FileSystem, ProcessRunner } from "./adapters";
import type { Diagnostic } from "./runtime";

const timeoutMs = 30_000;

/** A completed direct-argv Git operation with bounded public diagnostics. */
export type GitResult = {
  ok: boolean;
  diagnostics: Diagnostic[];
};
/** A named Git remote observed in one local working tree. */
export type GitRemote = {
  name: string;
  url: string;
};
/** The narrow non-shell Git capability available to repository commands. */
export type GitOperations = {
  remotes(cwd: string): Promise<{ remotes: GitRemote[]; diagnostics: Diagnostic[] }>;
  remoteNames(cwd: string): Promise<{ names: string[]; diagnostics: Diagnostic[] }>;
  destination(cwd: string, destination: string): Promise<"missing" | "empty" | "nonempty">;
  clone(cwd: string, url: string, destination: string, remote: string): Promise<GitResult>;
  addRemote(cwd: string, remote: string, url: string): Promise<GitResult>;
  push(cwd: string, remote: string): Promise<GitResult>;
  checkoutPull(
    cwd: string,
    remote: string,
    index: number,
    branch: string,
    force: boolean,
  ): Promise<GitResult>;
};

/**
 * Creates Git operations that use direct argument arrays and never open credential UI.
 *
 * @param process Direct process execution adapter.
 * @param filesystem Directory-state adapter used for clone preflight.
 * @param cancelled Cancellation observer.
 * @returns The scoped Git operation boundary.
 */
export function createGitOperations(
  process: ProcessRunner,
  filesystem: FileSystem,
  cancelled: () => boolean,
): GitOperations {
  const run = async (
    cwd: string,
    args: string[],
  ): Promise<{ raw: ProcessResult; result: GitResult }> => {
    if (cancelled()) throw new Error("command.cancelled");
    const raw = await process.run(["git", ...args], {
      cwd,
      timeout_ms: timeoutMs,
      stdin: undefined,
      environment: { GIT_TERMINAL_PROMPT: "0" },
    });
    if (cancelled()) throw new Error("command.cancelled");
    return { raw, result: { ok: raw.exit_code === 0, diagnostics: diagnostics(args, raw) } };
  };
  return {
    remotes: async (cwd) => {
      const { raw, result } = await run(cwd, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
      return {
        remotes: result.ok ? parseRemotesFromConfig(raw.stdout) : [],
        diagnostics: result.diagnostics,
      };
    },
    remoteNames: async (cwd) => {
      const { raw, result } = await run(cwd, ["remote"]);
      return {
        names: result.ok ? raw.stdout.split("\n").filter(Boolean) : [],
        diagnostics: result.diagnostics,
      };
    },
    destination: (cwd, destination) => filesystem.directoryStatus(resolvePath(cwd, destination)),
    clone: async (cwd, url, destination, remote) =>
      (await run(cwd, ["clone", "--origin", remote, "--", url, destination])).result,
    addRemote: async (cwd, remote, url) => (await run(cwd, ["remote", "add", remote, url])).result,
    push: async (cwd, remote) => (await run(cwd, ["push", "-u", remote, "HEAD"])).result,
    checkoutPull: async (cwd, remote, index, branch, force) => {
      const fetched = await run(cwd, [
        "fetch",
        ...(force ? ["--force"] : []),
        remote,
        `pull/${index}/head:${branch}`,
      ]);
      if (!fetched.result.ok) return fetched.result;
      const switched = await run(cwd, ["switch", ...(force ? ["--force"] : []), branch]);
      return {
        ok: switched.result.ok,
        diagnostics: [...fetched.result.diagnostics, ...switched.result.diagnostics],
      };
    },
  };
}
type ProcessResult = { exit_code: number; stdout: string; stderr: string };
function diagnostics(args: string[], result: ProcessResult): Diagnostic[] {
  return boundDiagnostics(
    [
      diagnostic(`git ${args.join(" ")}`, "stdout", result.stdout),
      diagnostic(`git ${args.join(" ")}`, "stderr", result.stderr),
    ].filter((item) => item.content.length > 0),
  );
}
function diagnostic(source: string, stream: "stdout" | "stderr", content: string): Diagnostic {
  return {
    source,
    stream,
    content,
    original_bytes: Buffer.byteLength(content),
    truncated: false,
  };
}
function resolvePath(cwd: string, path: string): string {
  return path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`;
}
function parseRemotesFromConfig(output: string): GitRemote[] {
  return output.split("\n").flatMap((line) => {
    const entry = /^(\S+)\s+(.+)$/.exec(line);
    if (!entry) return [];
    const match = /^remote\.([^.]*)\.url$/.exec(entry[1]!);
    return match && entry[2] ? [{ name: match[1]!, url: entry[2] }] : [];
  });
}
