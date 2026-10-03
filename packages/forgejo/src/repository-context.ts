import { selectHost, type HostProfile } from "./host-session";
import type { GitOperations, GitRemote } from "./git-operations";
import { isErrorCode, type NextStep } from "./runtime";

/** The safe provenance through which the Host profile was selected. */
export type HostSelectionSource = "explicit" | "environment" | "git_remote";
/** The stable repository context available to repository-scoped command outcomes. */
export type RepositoryContext = {
  deployment_url: string;
  host_selection_source: HostSelectionSource;
  owner: string | undefined;
  name: string | undefined;
  repository: string | undefined;
  web_url: string | undefined;
  remote_name: string | undefined;
  remote_url: string | undefined;
  working_directory: string | undefined;
};
/** Inputs used to select a Host profile and optional repository selector. */
export type RepositoryContextInput = {
  host: string | undefined;
  repo: string | undefined;
  environmentHost: string | undefined;
  cwd: string;
  requestMode: boolean;
  requireRepository: boolean;
};
/** A typed selection failure with safe recovery details. */
export class RepositoryContextError extends Error {
  /**
   * Creates a stable repository context failure.
   *
   * @param code Stable error code.
   * @param message Safe user-facing message.
   * @param details Credential-free recovery details.
   * @param next_steps Typed recoveries this failure already knows, read by the runtime's failure
   * path under the name the outcome uses.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown>,
    readonly next_steps: NextStep[] = [],
  ) {
    super(code);
    this.name = "RepositoryContextError";
  }
}

/**
 * Resolves repository targeting from explicit input, environment, or configured Git remotes.
 *
 * @param input Selection inputs from the current command mode.
 * @param profiles Configured Host profiles.
 * @param git Non-shell Git read boundary.
 * @returns A credential-free selected Host and optional repository context.
 */
export async function resolveRepositoryContext(
  input: RepositoryContextInput,
  profiles: HostProfile[],
  git: GitOperations | undefined,
): Promise<RepositoryContext> {
  const explicit = input.host ? chooseExplicit(profiles, input.host, "explicit") : undefined;
  if (input.requestMode) {
    if (!explicit) throw required("host.required", false);
    if (input.requireRepository && !input.repo) throw required("repo.required", true);
  }
  const environment =
    !explicit && input.environmentHost
      ? chooseExplicit(profiles, input.environmentHost, "environment")
      : undefined;
  const selected = explicit ?? environment;
  const inferred =
    input.requestMode || input.repo
      ? undefined
      : await infer(selected ? [selected.profile] : profiles, git, input.cwd);
  const host = selected ?? inferred;
  if (!host) throw required("host.required", false);
  const candidate = input.repo ? undefined : inferred?.candidate;
  if (input.requireRepository && !input.repo && !candidate) throw required("repo.required", true);
  if (input.repo && !isSelector(input.repo))
    throw new RepositoryContextError("repo.invalid", "Repository must be OWNER/NAME", {
      recovery: "--repo OWNER/NAME",
    });
  if (candidate && candidate.profile.url !== host.profile.url)
    throw required("repo.required", true);
  const repository = input.repo ?? candidate?.repository;
  const [owner, name] = repository ? repository.split("/") : [undefined, undefined];
  return {
    deployment_url: host.profile.url,
    host_selection_source: host.source,
    owner,
    name,
    repository,
    web_url: repository ? `${host.profile.url}/${repository}` : undefined,
    remote_name: candidate?.remote.name,
    remote_url: candidate?.remote.url,
    working_directory: candidate ? input.cwd : undefined,
  };
}

function chooseExplicit(
  profiles: HostProfile[],
  selector: string,
  source: HostSelectionSource,
): { profile: HostProfile; source: HostSelectionSource; candidate: undefined } {
  try {
    return { profile: selectHost(profiles, selector), source, candidate: undefined };
  } catch (error) {
    // Selection reports `host.not_found` and `host.ambiguous` today, and both flow through. Any
    // other failure is unexpected here, and its message describes the mishap rather than naming a
    // code, so it reports the generic this site already used for a non-Error throw: the recovery
    // and message attached below say the configured Host was not found, which is what a caller
    // can act on regardless of why selection failed.
    const code =
      error instanceof Error && isErrorCode(error.message) ? error.message : "host.not_found";
    throw new RepositoryContextError(code, "Configured Host was not found", {
      recovery: "--host HOST",
    });
  }
}
async function infer(
  profiles: HostProfile[],
  git: GitOperations | undefined,
  cwd: string,
): Promise<{ profile: HostProfile; source: "git_remote"; candidate: Candidate } | undefined> {
  if (!git) return undefined;
  const observed = await git.remotes(cwd);
  const candidates = observed.remotes.flatMap((remote) => parseCandidate(remote, profiles));
  const unique = new Map(
    candidates.map((candidate) => [`${candidate.profile.url}/${candidate.repository}`, candidate]),
  );
  if (unique.size === 0) return undefined;
  if (unique.size !== 1)
    throw new RepositoryContextError(
      "repo.ambiguous",
      "Configured Git remotes identify different repositories",
      {
        remotes: [...unique.values()].map((candidate) => ({
          name: candidate.remote.name,
          target: `${candidate.profile.url}/${candidate.repository}`,
        })),
        recovery: "--repo OWNER/NAME",
      },
    );
  const candidate = [...unique.values()][0]!;
  return { profile: candidate.profile, source: "git_remote", candidate };
}
type Candidate = { profile: HostProfile; repository: string; remote: GitRemote };
function parseCandidate(remote: GitRemote, profiles: HostProfile[]): Candidate[] {
  const parsed = parseRemote(remote.url);
  if (!parsed) return [];
  return profiles.flatMap((profile) => {
    const base = new URL(profile.url);
    if (base.hostname.toLowerCase() !== parsed.hostname) return [];
    if (parsed.port !== undefined && parsed.port !== effectivePort(base)) return [];
    const prefix = base.pathname.replace(/^\/+|\/+$/g, "");
    const paths = parsed.parts;
    const prefixParts = prefix ? prefix.split("/") : [];
    if (paths.length !== prefixParts.length + 2) return [];
    if (prefixParts.some((part, index) => paths[index] !== part)) return [];
    const repository = paths.slice(prefixParts.length).join("/");
    return isSelector(repository) ? [{ profile, repository, remote }] : [];
  });
}
function parseRemote(
  value: string,
): { hostname: string; port: string | undefined; parts: string[] } | undefined {
  const scp = /^(?:[^@\s/:]+@)?([^:\s/]+):(.+)$/.exec(value);
  if (scp) return remoteParts(scp[1]!, undefined, scp[2]!);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "ssh:") || url.password) return undefined;
  if (url.protocol === "https:" && url.username) return undefined;
  if (url.search || url.hash) return undefined;
  return remoteParts(url.hostname, url.port || undefined, url.pathname);
}
function remoteParts(
  hostname: string,
  port: string | undefined,
  pathname: string,
): { hostname: string; port: string | undefined; parts: string[] } | undefined {
  const parts = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.some((part) => !part)) return undefined;
  const last = parts.at(-1);
  if (!last) return undefined;
  parts[parts.length - 1] = last.endsWith(".git") ? last.slice(0, -4) : last;
  if (!parts.at(-1)) return undefined;
  return { hostname: hostname.toLowerCase(), port, parts };
}
function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}
function isSelector(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => part.length > 0 && !/\s/.test(part));
}
/**
 * Reports an absent selection, naming the input the caller has to supply.
 *
 * This is the one selection failure whose recovery is fully known here: an input was not sent, and
 * only the caller holds its value, so the step names the field rather than guessing at one. A Host
 * that was named but not found is a different failure, and this does not speak for it.
 */
function required(code: string, repository: boolean): RepositoryContextError {
  const field = repository ? "repo" : "host";
  return new RepositoryContextError(
    code,
    repository ? "Repository selection is required" : "Configured Host selection is required",
    { recovery: repository ? "--repo OWNER/NAME" : "--host HOST" },
    [{ action: "provide", field }],
  );
}
