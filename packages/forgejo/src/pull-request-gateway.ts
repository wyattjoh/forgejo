import {
  issuePath,
  jsonRequest,
  normalizeComment,
  normalizeIssue,
  pullCall,
  pullCallArray,
  pullCallNormalized,
  pullCallStatus,
  repoPath,
  resolveMilestone,
  type Issue,
  type IssueComment,
} from "./issue-gateway";
import { request, responseTooLarge, type FetchAdapter } from "./infrastructure";

/** A normalized Forgejo pull request. */
export type PullRequest = Issue & {
  base: string;
  head: string;
  head_sha: string | null;
  merged: boolean;
};
/** Inputs accepted by pull-request create and edit operations. */
export type PullRequestInput = {
  title: string | undefined;
  body: string | undefined;
  base: string | undefined;
  head: string | undefined;
  assignees: string[] | undefined;
  milestone: string | undefined;
};
/** Filter inputs supported by the selected pull-request list command. */
export type PullRequestListInput = {
  state: "open" | "closed" | "all";
  base: string | undefined;
  head: string | undefined;
  author: string | undefined;
  milestone: string | undefined;
  sort: string | undefined;
  page: number;
  limit: number;
};
/**
 * What a merge request actually did on the Host.
 *
 * Forgejo answers the merge endpoint with an empty body under two different success statuses, and
 * only one of them means the pull request merged. 201 means it scheduled an automatic merge for
 * when checks succeed, so nothing merged and no branch was deleted yet.
 */
export type MergeOutcome = { scheduled: boolean };
/**
 * One normalized commit status associated with a pull-request head.
 *
 * `state` carries the contract's `CommitStatusState`, one of "pending", "success", "error",
 * "failure", "warning", or "skipped".
 */
export type CommitStatus = {
  context: string | null;
  state: string | null;
  target_url: string | null;
  description: string | null;
};
/**
 * The deduped commit statuses for one head, with the Host's own rollup verdict.
 *
 * `state` is the contract's `CombinedStatus.state`, the worst status across every check by the
 * Host's priority order. It answers "are the checks passing", not "have they finished": a head
 * with one failed check and one still running rolls up to "failure" while `statuses` still
 * carries the pending row, so settledness has to come from `statuses`.
 *
 * `total_count` is the contract's count of the checks this rollup covers. A head with no status
 * row at all reports zero, which the Host returns for a repository with no checks configured and
 * for a check that has not registered yet alike.
 */
export type CombinedStatus = {
  state: string | null;
  total_count: number;
  statuses: CommitStatus[];
};
/** A narrow authenticated Forgejo pull-request API boundary. */
export type PullRequestsGateway = {
  list(
    host: string,
    token: string,
    owner: string,
    repo: string,
    input: PullRequestListInput,
  ): Promise<PullRequest[]>;
  get(
    host: string,
    token: string,
    owner: string,
    repo: string,
    index: number,
  ): Promise<PullRequest>;
  create(
    host: string,
    token: string,
    owner: string,
    repo: string,
    input: PullRequestInput,
  ): Promise<PullRequest>;
  edit(
    host: string,
    token: string,
    owner: string,
    repo: string,
    index: number,
    input: PullRequestInput,
  ): Promise<PullRequest>;
  reviewers(
    host: string,
    token: string,
    owner: string,
    repo: string,
    index: number,
    reviewers: string[],
  ): Promise<void>;
  comments(
    host: string,
    token: string,
    owner: string,
    repo: string,
    index: number,
  ): Promise<IssueComment[]>;
  comment(
    host: string,
    token: string,
    owner: string,
    repo: string,
    index: number,
    body: string,
  ): Promise<IssueComment>;
  diff(
    host: string,
    token: string,
    owner: string,
    repo: string,
    index: number,
    patch: boolean,
    binary: boolean,
  ): Promise<Uint8Array>;
  review(
    host: string,
    token: string,
    owner: string,
    repo: string,
    index: number,
    event: "APPROVED" | "REQUEST_CHANGES" | "COMMENT",
    body: string | undefined,
  ): Promise<void>;
  merge(
    host: string,
    token: string,
    owner: string,
    repo: string,
    index: number,
    method: string,
    deleteBranch: boolean,
    matchHead: string | undefined,
    whenChecksSucceed: boolean,
  ): Promise<MergeOutcome>;
  statuses(
    host: string,
    token: string,
    owner: string,
    repo: string,
    sha: string,
  ): Promise<CombinedStatus>;
};

/**
 * Creates a normalized, bounded Forgejo pull-request gateway.
 *
 * @param fetchAdapter Authenticated transport seam.
 * @returns The selected pull-request REST operations.
 */
export function createPullRequestsGateway(fetchAdapter: FetchAdapter): PullRequestsGateway {
  return {
    list: async (host, token, owner, repo, input) => {
      const query = new URLSearchParams({
        state: input.state,
        page: String(input.page),
        limit: String(input.limit),
      });
      set(query, "base", input.base);
      set(query, "head", input.head);
      set(query, "poster", input.author);
      set(query, "milestone", input.milestone);
      set(query, "sort", input.sort);
      const value = await pullCallArray(
        fetchAdapter,
        host,
        token,
        `${pullsPath(owner, repo)}?${query}`,
        { method: "GET" },
      );
      return value
        .filter((item) => item !== null)
        .map((item) => normalizePullRequest(host, owner, repo, item));
    },
    get: async (host, token, owner, repo, index) =>
      normalizePullRequest(
        host,
        owner,
        repo,
        await pullCall(fetchAdapter, host, token, pullPath(owner, repo, index), { method: "GET" }),
      ),
    create: async (host, token, owner, repo, input) =>
      pullCallNormalized(
        fetchAdapter,
        host,
        token,
        pullsPath(owner, repo),
        jsonRequest("POST", await pullBody(fetchAdapter, host, token, owner, repo, input)),
        (value) => normalizePullRequest(host, owner, repo, value),
      ),
    edit: async (host, token, owner, repo, index, input) =>
      pullCallNormalized(
        fetchAdapter,
        host,
        token,
        pullPath(owner, repo, index),
        jsonRequest("PATCH", await pullBody(fetchAdapter, host, token, owner, repo, input)),
        (value) => normalizePullRequest(host, owner, repo, value),
      ),
    reviewers: async (host, token, owner, repo, index, reviewers) => {
      await pullCall<void>(
        fetchAdapter,
        host,
        token,
        `${pullPath(owner, repo, index)}/requested_reviewers`,
        jsonRequest("POST", { reviewers }),
      );
    },
    comments: async (host, token, owner, repo, index) => {
      const value = await pullCallArray(
        fetchAdapter,
        host,
        token,
        commentsPath(owner, repo, index),
        { method: "GET" },
      );
      return value.map(normalizeComment);
    },
    comment: async (host, token, owner, repo, index, body) =>
      pullCallNormalized(
        fetchAdapter,
        host,
        token,
        commentsPath(owner, repo, index),
        jsonRequest("POST", { body }),
        normalizeComment,
      ),
    diff: async (host, token, owner, repo, index, patch, binary) => {
      const kind = patch ? "patch" : "diff";
      const query = binary ? "?binary=true" : "";
      return raw(fetchAdapter, host, token, `${pullPath(owner, repo, index)}.${kind}${query}`);
    },
    review: async (host, token, owner, repo, index, event, body) => {
      await pullCall<void>(
        fetchAdapter,
        host,
        token,
        `${pullPath(owner, repo, index)}/reviews`,
        jsonRequest("POST", { event, body }),
      );
    },
    merge: async (
      host,
      token,
      owner,
      repo,
      index,
      method,
      deleteBranch,
      matchHead,
      whenChecksSucceed,
    ) => {
      const status = await pullCallStatus(
        fetchAdapter,
        host,
        token,
        `${pullPath(owner, repo, index)}/merge`,
        jsonRequest("POST", {
          Do: method,
          delete_branch_after_merge: deleteBranch,
          merge_when_checks_succeed: whenChecksSucceed,
          head_commit_id: matchHead,
        }),
      );
      // Forgejo answers 201 only when it scheduled the merge for later, and 200 when it merged.
      return { scheduled: status === 201 };
    },
    statuses: async (host, token, owner, repo, sha) => {
      // The combined endpoint dedupes by context and keeps the latest row per check. The plain
      // statuses endpoint returns every row ever written for the sha, so an Actions check that
      // was ever pending would read as pending forever. It answers with an object rather than a
      // collection, so this reads through the object path, not `pullCallArray`.
      const value = await pullCall<unknown>(
        fetchAdapter,
        host,
        token,
        `${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/status?limit=100`,
        { method: "GET" },
      );
      const source = record(value);
      return {
        state: nullableString(source.state),
        total_count: count(source.total_count),
        statuses: array(source.statuses).map(normalizeStatus),
      };
    },
  };
}

/** Normalizes one Forgejo pull request response. */
export function normalizePullRequest(
  host: string,
  owner: string,
  repo: string,
  value: unknown,
): PullRequest {
  const source = record(value);
  const issue = normalizeIssue(host, owner, repo, value);
  return {
    ...issue,
    base: ref(source.base),
    head: ref(source.head),
    head_sha: nullableString(record(source.head).sha),
    merged: source.merged === true,
  };
}
function pullsPath(owner: string, repo: string): string {
  return `${repoPath(owner, repo)}/pulls`;
}
function pullPath(owner: string, repo: string, index: number): string {
  return `${pullsPath(owner, repo)}/${index}`;
}
/**
 * Resolves the conversation-comments path for a pull request.
 *
 * A pull request is an issue in Forgejo, so its conversation comments are issue comments. The
 * contract advertises no comments collection beneath the pulls resource; the review comments it
 * does advertise there are a separate feature.
 */
function commentsPath(owner: string, repo: string, index: number): string {
  return `${issuePath(owner, repo, index)}/comments`;
}
async function pullBody(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  owner: string,
  repo: string,
  input: PullRequestInput,
): Promise<Record<string, unknown>> {
  return {
    title: input.title,
    body: input.body,
    base: input.base,
    head: input.head,
    assignees: input.assignees,
    milestone: await resolveMilestone(fetchAdapter, host, token, owner, repo, input.milestone),
  };
}
function set(query: URLSearchParams, key: string, value: string | undefined): void {
  if (value) query.set(key, value);
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function nullableString(value: unknown): string | null {
  // Forgejo tags these fields without omitempty, so an unset one arrives as "" rather than as a
  // missing key. Both mean absent, and reporting one as null and the other as "" would make the
  // same condition read two different ways.
  return typeof value === "string" && value !== "" ? value : null;
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function ref(value: unknown): string {
  const result = nullableString(record(value).ref);
  if (!result) throw new Error("pull_request.invalid_response");
  return result;
}
function normalizeStatus(value: unknown): CommitStatus {
  const source = record(value);
  return {
    context: nullableString(source.context),
    // The contract's CommitStatus names this field `status`, and carries no `state`.
    state: nullableString(source.status),
    target_url: nullableString(source.target_url),
    description: nullableString(source.description),
  };
}
/**
 * Reads one non-JSON pull-request body, such as a diff or a patch.
 *
 * The read goes through the shared bounded transport rather than the fetch seam directly, so an
 * oversized diff reports the same size failure, with the same limit and advertised size, as every
 * other buffered read, and a transport failure is classified rather than escaping as a raw error.
 */
async function raw(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
): Promise<Uint8Array> {
  const result = await request(fetchAdapter, `${host}/api/v1${path}`, {
    headers: { Accept: "text/plain", Authorization: `token ${token}` },
  });
  if (result.kind === "too_large") throw responseTooLarge("pull_request", result);
  if (result.kind !== "response") throw new Error(`pull_request.${result.kind}`);
  const { status, body } = result.response;
  if (status === 401 || status === 403) throw new Error("auth.required");
  if (status === 404) throw new Error("pull_request.not_found");
  if (status < 200 || status >= 300) throw new Error("pull_request.request_failed");
  return body;
}
