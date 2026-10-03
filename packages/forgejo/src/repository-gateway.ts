import {
  decodeJsonBody,
  markTransmitted,
  readAnswer,
  request,
  responseTooLarge,
  type FetchAdapter,
} from "./infrastructure";

/** A normalized Forgejo repository returned by curated repository commands. */
export type Repository = {
  host: string;
  owner: string;
  name: string;
  full_name: string;
  description: string | null;
  visibility: "public" | "private" | "limited";
  archived: boolean;
  fork: boolean;
  default_branch: string;
  clone_urls: { https: string | null; ssh: string | null };
  web_url: string;
};
/** Inputs accepted by the repository creation endpoint. */
export type CreateRepositoryInput = {
  name: string;
  /**
   * Owning organization, when the repository is not created under the authenticated account.
   * Forgejo creates under an organization and under the current user through separate
   * endpoints, and the organization endpoint answers 404 for a user owner.
   */
  organization: string | undefined;
  description: string | undefined;
  private: boolean | undefined;
  init: boolean | undefined;
  defaultBranch: string | undefined;
};
/** Inputs accepted by curated repository edits. */
export type EditRepositoryInput = {
  description: string | undefined;
  website: string | undefined;
  defaultBranch: string | undefined;
  visibility: "public" | "private" | undefined;
  archived: boolean | undefined;
  name: string | undefined;
};
/** A narrow authenticated Forgejo repository API boundary. */
export type RepositoryGateway = {
  list(
    host: string,
    token: string,
    owner: string | undefined,
    page: number,
    limit: number,
  ): Promise<Repository[]>;
  get(host: string, token: string, owner: string, name: string): Promise<Repository>;
  create(host: string, token: string, input: CreateRepositoryInput): Promise<Repository>;
  edit(
    host: string,
    token: string,
    owner: string,
    name: string,
    input: EditRepositoryInput,
  ): Promise<Repository>;
  remove(host: string, token: string, owner: string, name: string): Promise<void>;
  /**
   * Forks a repository. `organization` names the owning organization when the fork is not
   * created under the authenticated account. Forgejo resolves that name against organizations
   * only, so a user owner never matches and must be sent as undefined.
   */
  fork(
    host: string,
    token: string,
    owner: string,
    name: string,
    organization: string | undefined,
    targetName: string | undefined,
  ): Promise<Repository>;
};

/** Creates the concrete curated repository gateway over Forgejo's REST API. */
export function createRepositoryGateway(fetchAdapter: FetchAdapter): RepositoryGateway {
  const call = async <T>(
    host: string,
    token: string,
    path: string,
    init: RequestInit,
  ): Promise<T> => {
    const response = await request(fetchAdapter, `${host}/api/v1${path}`, {
      ...init,
      headers: { Accept: "application/json", Authorization: `token ${token}`, ...init.headers },
    });
    // Every failure records whether the Host received the request, so a mutation that may already
    // have landed is never reported as never attempted. An answer too large to read is one the
    // Host sent, so it marks too.
    if (response.kind === "too_large")
      throw markTransmitted(responseTooLarge("repository", response), init, response.transmitted);
    if (response.kind !== "response")
      throw markTransmitted(new Error(`repository.${response.kind}`), init, response.transmitted);
    if (response.response.status < 200 || response.response.status >= 300) {
      if (response.response.status === 401 || response.response.status === 403)
        throw markTransmitted(new Error("auth.required"), init);
      if (response.response.status === 404)
        throw markTransmitted(new Error("repository.not_found"), init);
      throw markTransmitted(new Error("repository.request_failed"), init);
    }
    try {
      return decodeJsonBody<T>(response.response.body, "repository.invalid_response") as T;
    } catch (error) {
      throw markTransmitted(error, init);
    }
  };
  // Normalizing an answer fails over a mutation the Host has already performed just as decoding
  // does, and under the same error code, so both belong inside the same marked region.
  const mutate = async <T>(
    host: string,
    token: string,
    path: string,
    init: RequestInit,
    shape: (value: unknown) => T,
  ): Promise<T> => {
    const value = await call<unknown>(host, token, path, init);
    return readAnswer(init, () => shape(value));
  };
  return {
    list: async (host, token, owner, page, limit) => {
      const query = new URLSearchParams({ page: String(page), limit: String(limit) });
      const path = owner
        ? `/users/${encodeURIComponent(owner)}/repos?${query}`
        : `/user/repos?${query}`;
      const value = await call<unknown>(host, token, path, { method: "GET" });
      // An empty body decodes to undefined, which must not read as an empty list of repositories.
      if (!Array.isArray(value)) throw new Error("repository.invalid_response");
      return value.map((item) => normalize(host, item));
    },
    get: async (host, token, owner, name) =>
      normalize(host, await call(host, token, repoPath(owner, name), { method: "GET" })),
    create: async (host, token, input) => {
      const body = JSON.stringify({
        name: input.name,
        description: input.description,
        private: input.private,
        auto_init: input.init,
        default_branch: input.defaultBranch,
      });
      const path = input.organization
        ? `/orgs/${encodeURIComponent(input.organization)}/repos`
        : "/user/repos";
      return mutate(host, token, path, json("POST", body), (value) => normalize(host, value));
    },
    edit: async (host, token, owner, name, input) =>
      mutate(
        host,
        token,
        repoPath(owner, name),
        json(
          "PATCH",
          JSON.stringify({
            description: input.description,
            website: input.website,
            default_branch: input.defaultBranch,
            private: input.visibility === undefined ? undefined : input.visibility === "private",
            archived: input.archived,
            name: input.name,
          }),
        ),
        (value) => normalize(host, value),
      ),
    remove: async (host, token, owner, name) =>
      call<void>(host, token, repoPath(owner, name), { method: "DELETE" }),
    fork: async (host, token, owner, name, organization, targetName) =>
      mutate(
        host,
        token,
        `${repoPath(owner, name)}/forks`,
        json("POST", JSON.stringify({ organization, name: targetName })),
        (value) => normalize(host, value),
      ),
  };
}

function json(method: string, body: string): RequestInit {
  return { method, body, headers: { "Content-Type": "application/json" } };
}
function repoPath(owner: string, name: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}
function normalize(host: string, value: unknown): Repository {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const owner = source.owner as Record<string, unknown> | undefined;
  const name = string(source.name, "repository.invalid_response");
  const ownerName = string(owner?.login, "repository.invalid_response");
  const visibility =
    source.private === true ? "private" : source.visibility === "limited" ? "limited" : "public";
  return {
    host,
    owner: ownerName,
    name,
    full_name: `${ownerName}/${name}`,
    description: typeof source.description === "string" ? source.description : null,
    visibility,
    archived: source.archived === true,
    fork: source.fork === true,
    default_branch: typeof source.default_branch === "string" ? source.default_branch : "",
    clone_urls: {
      https: typeof source.clone_url === "string" ? source.clone_url : null,
      ssh: typeof source.ssh_url === "string" ? source.ssh_url : null,
    },
    web_url: typeof source.html_url === "string" ? source.html_url : `${host}/${ownerName}/${name}`,
  };
}
function string(value: unknown, error: string): string {
  if (typeof value !== "string" || !value) throw new Error(error);
  return value;
}
