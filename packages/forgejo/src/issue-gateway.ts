import {
  decodeJsonBody,
  markTransmitted,
  readAnswer,
  request,
  responseTooLarge,
  type FetchAdapter,
} from "./infrastructure";

/** A normalized Forgejo issue shared by issue and pull-request commands. */
export type Issue = {
  host: string;
  repository: string;
  index: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  author: string | null;
  assignees: string[];
  labels: string[];
  milestone: string | null;
  due_date: string | null;
  created_at: string | null;
  updated_at: string | null;
  web_url: string;
};
/** A normalized issue or pull-request comment. */
export type IssueComment = {
  id: number;
  body: string;
  author: string | null;
  created_at: string | null;
  updated_at: string | null;
  web_url: string | null;
};
/** Inputs accepted by issue create and edit operations. */
export type IssueInput = {
  title: string | undefined;
  body: string | undefined;
  assignees: string[] | undefined;
  milestone: string | undefined;
  dueDate: string | undefined;
  state: "open" | "closed" | undefined;
};
/** Filter inputs supported by the selected issue-list command. */
export type IssueListInput = {
  state: "open" | "closed" | "all";
  labels: string[];
  assignees: string[];
  author: string | undefined;
  mention: string | undefined;
  milestone: string | undefined;
  search: string | undefined;
  type: "issues" | "pulls" | undefined;
  sort: string | undefined;
  page: number;
  limit: number;
};
/** A small authenticated Forgejo issue API boundary. */
export type IssuesGateway = {
  list(
    host: string,
    token: string,
    owner: string,
    repo: string,
    input: IssueListInput,
  ): Promise<Issue[]>;
  get(host: string, token: string, owner: string, repo: string, index: number): Promise<Issue>;
  create(
    host: string,
    token: string,
    owner: string,
    repo: string,
    input: IssueInput,
  ): Promise<Issue>;
  edit(
    host: string,
    token: string,
    owner: string,
    repo: string,
    index: number,
    input: IssueInput,
  ): Promise<Issue>;
  remove(host: string, token: string, owner: string, repo: string, index: number): Promise<void>;
  pin(
    host: string,
    token: string,
    owner: string,
    repo: string,
    index: number,
    pinned: boolean,
  ): Promise<void>;
  replaceLabels(
    host: string,
    token: string,
    owner: string,
    repo: string,
    index: number,
    labels: string[],
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
};

/**
 * Creates a normalized, bounded Forgejo issue gateway.
 *
 * @param fetchAdapter Authenticated transport seam.
 * @returns The selected issue REST operations.
 */
export function createIssuesGateway(fetchAdapter: FetchAdapter): IssuesGateway {
  return {
    list: async (host, token, owner, repo, input) => {
      const query = new URLSearchParams({
        state: input.state,
        page: String(input.page),
        limit: String(input.limit),
      });
      put(query, "labels", input.labels.join(","));
      put(query, "assigned_by", input.assignees.join(","));
      put(query, "created_by", input.author);
      put(query, "mentioned_by", input.mention);
      put(query, "milestones", input.milestone);
      put(query, "q", input.search);
      put(query, "type", input.type);
      put(query, "sort", input.sort);
      const value = await callArray(
        fetchAdapter,
        host,
        token,
        `${issuesPath(owner, repo)}?${query}`,
        { method: "GET" },
        "issue",
      );
      return value.map((item) => normalizeIssue(host, owner, repo, item));
    },
    get: async (host, token, owner, repo, index) =>
      normalizeIssue(
        host,
        owner,
        repo,
        await call(
          fetchAdapter,
          host,
          token,
          issuePath(owner, repo, index),
          { method: "GET" },
          "issue",
        ),
      ),
    create: async (host, token, owner, repo, input) =>
      callNormalized(
        fetchAdapter,
        host,
        token,
        issuesPath(owner, repo),
        json("POST", await issueBody(fetchAdapter, host, token, owner, repo, input)),
        "issue",
        (value) => normalizeIssue(host, owner, repo, value),
      ),
    edit: async (host, token, owner, repo, index, input) =>
      callNormalized(
        fetchAdapter,
        host,
        token,
        issuePath(owner, repo, index),
        json("PATCH", await issueBody(fetchAdapter, host, token, owner, repo, input)),
        "issue",
        (value) => normalizeIssue(host, owner, repo, value),
      ),
    remove: (host, token, owner, repo, index) =>
      call<void>(
        fetchAdapter,
        host,
        token,
        issuePath(owner, repo, index),
        { method: "DELETE" },
        "issue",
      ),
    pin: (host, token, owner, repo, index, pinned) =>
      call<void>(
        fetchAdapter,
        host,
        token,
        `${issuePath(owner, repo, index)}/pin`,
        { method: pinned ? "POST" : "DELETE" },
        "issue",
      ),
    replaceLabels: async (host, token, owner, repo, index, labels) => {
      const available = await callArray(
        fetchAdapter,
        host,
        token,
        `${repoPath(owner, repo)}/labels?limit=100`,
        { method: "GET" },
        "issue",
      );
      const ids = labels.map((label) => {
        const match = available.find((item) => record(item).name === label);
        const id = record(match).id;
        if (typeof id !== "number")
          throw typed("issue.label_not_found", "Requested label was not found", { label });
        return id;
      });
      await call<void>(
        fetchAdapter,
        host,
        token,
        `${issuePath(owner, repo, index)}/labels`,
        json("PUT", JSON.stringify({ labels: ids })),
        "issue",
      );
    },
    comments: async (host, token, owner, repo, index) => {
      const value = await callArray(
        fetchAdapter,
        host,
        token,
        `${issuePath(owner, repo, index)}/comments`,
        { method: "GET" },
        "issue",
      );
      return value.map(normalizeComment);
    },
    comment: async (host, token, owner, repo, index, body) =>
      callNormalized(
        fetchAdapter,
        host,
        token,
        `${issuePath(owner, repo, index)}/comments`,
        json("POST", JSON.stringify({ body })),
        "issue",
        normalizeComment,
      ),
  };
}

/** Normalizes one Forgejo issue response for all selected consumers. */
export function normalizeIssue(host: string, owner: string, repo: string, value: unknown): Issue {
  const source = record(value);
  const index = number(source.number, "issue.invalid_response");
  const state =
    source.state === "closed"
      ? "closed"
      : source.state === "open"
        ? "open"
        : fail("issue.invalid_response");
  return {
    host,
    repository: `${owner}/${repo}`,
    index,
    title: string(source.title, "issue.invalid_response"),
    body: nullableString(source.body),
    state,
    author: login(source.user),
    assignees: array(source.assignees).flatMap((assignee) => login(assignee) ?? []),
    labels: array(source.labels).flatMap((label) => nullableString(record(label).name) ?? []),
    milestone: nullableString(record(source.milestone).title),
    due_date: nullableString(source.due_date),
    created_at: nullableString(source.created_at),
    updated_at: nullableString(source.updated_at),
    web_url: nullableString(source.html_url) ?? `${host}/${owner}/${repo}/issues/${index}`,
  };
}

/** Normalizes a Forgejo issue comment response. */
export function normalizeComment(value: unknown): IssueComment {
  const source = record(value);
  return {
    id: number(source.id, "issue.invalid_response"),
    body: nullableString(source.body) ?? "",
    author: login(source.user),
    created_at: nullableString(source.created_at),
    updated_at: nullableString(source.updated_at),
    web_url: nullableString(source.html_url),
  };
}

export function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
export function issuePath(owner: string, repo: string, index: number): string {
  return `${issuesPath(owner, repo)}/${index}`;
}
function issuesPath(owner: string, repo: string): string {
  return `${repoPath(owner, repo)}/issues`;
}
async function issueBody(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  owner: string,
  repo: string,
  input: IssueInput,
): Promise<string> {
  return JSON.stringify({
    title: input.title,
    body: input.body,
    assignees: input.assignees,
    milestone: await resolveMilestone(fetchAdapter, host, token, owner, repo, input.milestone),
    due_date: input.dueDate,
    state: input.state,
  });
}
/** Resolves a v1 milestone selector to the integer REST identifier. */
export async function resolveMilestone(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  owner: string,
  repo: string,
  milestone: string | undefined,
): Promise<number | undefined> {
  if (!milestone) return undefined;
  if (/^\d+$/.test(milestone)) return Number(milestone);
  const items = await callArray(
    fetchAdapter,
    host,
    token,
    `${repoPath(owner, repo)}/milestones?state=all&limit=100`,
    { method: "GET" },
    "issue",
  );
  const match = items.find((item) => record(item).title === milestone);
  const id = record(match).id;
  if (typeof id !== "number")
    throw typed("issue.milestone_not_found", "Requested milestone was not found", { milestone });
  return id;
}
function json(method: string, body: string): RequestInit {
  return { method, body, headers: { "Content-Type": "application/json" } };
}
function put(query: URLSearchParams, key: string, value: string | undefined): void {
  if (value) query.set(key, value);
}
async function send(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
  init: RequestInit,
  domain: "issue" | "pull_request",
): Promise<{ status: number; body: Uint8Array }> {
  const response = await request(fetchAdapter, `${host}/api/v1${path}`, {
    ...init,
    headers: { Accept: "application/json", Authorization: `token ${token}`, ...init.headers },
  });
  // Forgejo deletes a merged pull request's head branch inside the merge call and answers that
  // deletion's refusal as the call's failure, so a failure here is not evidence that nothing
  // landed. Every failure records whether the Host received the request, a size failure included:
  // an answer arrived at all, so whatever the request asked for has already happened.
  if (response.kind === "too_large")
    throw markTransmitted(responseTooLarge(domain, response), init, response.transmitted);
  if (response.kind !== "response")
    throw markTransmitted(new Error(`${domain}.${response.kind}`), init, response.transmitted);
  if (response.response.status < 200 || response.response.status >= 300) {
    if (response.response.status === 401 || response.response.status === 403)
      throw markTransmitted(new Error("auth.required"), init);
    if (response.response.status === 404)
      throw markTransmitted(new Error(`${domain}.not_found`), init);
    throw markTransmitted(new Error(`${domain}.request_failed`), init);
  }
  return response.response;
}
async function call<T>(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
  init: RequestInit,
  domain: "issue" | "pull_request",
): Promise<T> {
  const response = await send(fetchAdapter, host, token, path, init, domain);
  try {
    return decodeJsonBody<T>(response.body, `${domain}.invalid_response`) as T;
  } catch (error) {
    // The Host answered, so a body this client cannot read says nothing about whether the request
    // took effect.
    throw markTransmitted(error, init);
  }
}
/**
 * Executes an operation whose contract requires a collection body.
 *
 * An empty body decodes to undefined, which would otherwise read as an empty collection and let a
 * caller conclude the Host holds no items at all.
 */
async function callArray(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
  init: RequestInit,
  domain: "issue" | "pull_request",
): Promise<unknown[]> {
  const value = await call<unknown>(fetchAdapter, host, token, path, init, domain);
  if (!Array.isArray(value)) throw markTransmitted(new Error(`${domain}.invalid_response`), init);
  return value;
}

/**
 * Executes one operation and normalizes its answer inside the same marked region.
 *
 * Normalizing is as capable of failing over a mutation the Host has already performed as decoding
 * is, and it fails under the same error code, so the two belong together.
 */
async function callNormalized<T>(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
  init: RequestInit,
  domain: "issue" | "pull_request",
  normalize: (value: unknown) => T,
): Promise<T> {
  const value = await call<unknown>(fetchAdapter, host, token, path, init, domain);
  return readAnswer(init, () => normalize(value));
}
/** Executes a selected pull-request REST operation using the same bounded transport policy. */
export async function pullCall<T>(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
  init: RequestInit,
): Promise<T> {
  return call(fetchAdapter, host, token, path, init, "pull_request");
}
/** Executes a selected pull-request REST operation whose contract requires a collection body. */
export async function pullCallArray(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
  init: RequestInit,
): Promise<unknown[]> {
  return callArray(fetchAdapter, host, token, path, init, "pull_request");
}
/**
 * Executes a selected pull-request operation and normalizes its answer under the same mark.
 */
export async function pullCallNormalized<T>(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
  init: RequestInit,
  normalize: (value: unknown) => T,
): Promise<T> {
  return callNormalized(fetchAdapter, host, token, path, init, "pull_request", normalize);
}
/**
 * Executes a selected pull-request operation whose meaning depends on which success status
 * answered, rather than on a response body.
 */
export async function pullCallStatus(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
  init: RequestInit,
): Promise<number> {
  return (await send(fetchAdapter, host, token, path, init, "pull_request")).status;
}
/** Creates a JSON REST request without exposing transport headers to catalogs. */
export function jsonRequest(method: string, body: unknown): RequestInit {
  return json(method, JSON.stringify(body));
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function login(value: unknown): string | null {
  return nullableString(record(value).login);
}
function string(value: unknown, error: string): string {
  if (typeof value !== "string" || !value) fail(error);
  return value;
}
function number(value: unknown, error: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) fail(error);
  return value;
}
function fail(error: string): never {
  throw new Error(error);
}
function typed(
  code: string,
  message: string,
  details: Record<string, unknown>,
): { code: string; message: string; details: Record<string, unknown> } {
  return { code, message, details };
}
