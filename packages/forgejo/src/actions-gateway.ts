import { abandonBody } from "./adapters";
import {
  decodeJsonBody,
  markTransmitted,
  readAnswer,
  request,
  requestStream,
  responseTooLarge,
  type FetchAdapter,
} from "./infrastructure";

/**
 * A normalized Forgejo Actions workflow run.
 *
 * Field names are the `ActionRun` names the Host advertises in `swagger.v1.json`, so drift in the
 * contract is visible rather than silently normalizing to null. Forgejo has no run-level
 * conclusion and no run-level attempt, so neither appears here; attempt exists per job only.
 * `web_url` is the one house name, derived from the advertised `html_url`.
 */
export type ActionRun = {
  id: number;
  index_in_repo: number;
  workflow_id: string | null;
  title: string | null;
  event: string | null;
  status: string | null;
  commit_sha: string | null;
  prettyref: string | null;
  created: string | null;
  updated: string | null;
  web_url: string;
};
/**
 * A normalized Forgejo Actions job.
 *
 * Field names are the `ActionRunJob` names the Host advertises in `swagger.v1.json`. Forgejo has
 * no job-level conclusion; `status` carries the outcome, so `failure` is read from there. The
 * attempt count is advertised as `attempt`, not GitHub's `run_attempt`.
 */
export type ActionJob = {
  id: number;
  name: string;
  status: string | null;
  attempt: number | null;
};
/**
 * A normalized Forgejo Actions artifact.
 */
export type ActionArtifact = { id: number; name: string; size_in_bytes: number | null };
/**
 * Filters accepted by the selected Actions run list endpoint.
 *
 * `ref` is matched exactly against the stored fully-qualified ref, such as `refs/heads/main`,
 * while a listed run reports the short `prettyref`. Callers qualify the short form before
 * filtering; see `qualifyRef` in the Actions catalog.
 */
export type ActionRunFilter = {
  page: number;
  limit: number;
  workflow: string | undefined;
  event: string | undefined;
  status: string | undefined;
  ref: string | undefined;
  commit: string | undefined;
  run_number: number | undefined;
};
/**
 * An authenticated purpose-built boundary for selected Forgejo Actions REST operations.
 */
export type ActionsGateway = {
  list(
    host: string,
    token: string,
    owner: string,
    repo: string,
    filter: ActionRunFilter,
  ): Promise<ActionRun[]>;
  get(host: string, token: string, owner: string, repo: string, run: number): Promise<ActionRun>;
  jobs(host: string, token: string, owner: string, repo: string, run: number): Promise<ActionJob[]>;
  cancel(host: string, token: string, owner: string, repo: string, run: number): Promise<void>;
  remove(host: string, token: string, owner: string, repo: string, run: number): Promise<void>;
  /**
   * Retrieves a run's logs as a stream, because they are bulk content headed for a file.
   *
   * A log or artifact is delivered to a destination rather than inlined, so it is never held in
   * memory and the client's in-memory read bound does not apply to it: a large but healthy log is
   * written out rather than refused.
   */
  logs(
    host: string,
    token: string,
    owner: string,
    repo: string,
    run: number,
  ): Promise<ReadableStream<Uint8Array>>;
  jobLogs(
    host: string,
    token: string,
    owner: string,
    repo: string,
    job: number,
  ): Promise<ReadableStream<Uint8Array>>;
  artifacts(
    host: string,
    token: string,
    owner: string,
    repo: string,
    run: number,
    name: string | undefined,
  ): Promise<ActionArtifact[]>;
  downloadArtifact(
    host: string,
    token: string,
    owner: string,
    repo: string,
    artifact: number,
  ): Promise<ReadableStream<Uint8Array>>;
  /**
   * Dispatches a workflow, returning undefined when the Host answers without run info.
   *
   * The contract declares `inputs` as a map of strings, so the caller sends the values verbatim.
   */
  dispatch(
    host: string,
    token: string,
    owner: string,
    repo: string,
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<ActionRun | undefined>;
  rerunCapability(
    host: string,
    token: string,
  ): Promise<{ name: string; version: number; routes: string[] } | undefined>;
  rerun(
    host: string,
    token: string,
    owner: string,
    repo: string,
    run: number,
    job: number | undefined,
  ): Promise<{ run: ActionRun; jobs: ActionJob[] }>;
};

/**
 * Creates a normalized Actions gateway without depending on Forgejo web routes.
 *
 * @param fetchAdapter Authenticated HTTP transport seam.
 * @returns Selected Actions REST operations.
 */
export function createActionsGateway(fetchAdapter: FetchAdapter): ActionsGateway {
  return {
    list: async (host, token, owner, repo, filter) => {
      const query = new URLSearchParams({ page: String(filter.page), limit: String(filter.limit) });
      set(query, "workflow_id", filter.workflow);
      set(query, "event", filter.event);
      set(query, "status", filter.status);
      set(query, "ref", filter.ref);
      set(query, "head_sha", filter.commit);
      if (filter.run_number !== undefined) query.set("run_number", String(filter.run_number));
      const value = await jsonObject(fetchAdapter, host, token, `${runs(owner, repo)}?${query}`, {
        method: "GET",
      });
      return array(value.workflow_runs ?? value.runs).map((item) => run(host, owner, repo, item));
    },
    get: async (host, token, owner, repo, id) =>
      run(
        host,
        owner,
        repo,
        await json(fetchAdapter, host, token, `${runs(owner, repo)}/${id}`, { method: "GET" }),
      ),
    jobs: async (host, token, owner, repo, id) =>
      // `ListActionRunJobs` answers `ActionRunJobList`, a bare array rather than an envelope.
      jobList(
        await jsonArray(fetchAdapter, host, token, `${runs(owner, repo)}/${id}/jobs`, {
          method: "GET",
        }),
      ),
    cancel: (host, token, owner, repo, id) =>
      empty(fetchAdapter, host, token, `${runs(owner, repo)}/${id}/cancel`, { method: "POST" }),
    remove: (host, token, owner, repo, id) =>
      empty(fetchAdapter, host, token, `${runs(owner, repo)}/${id}`, { method: "DELETE" }),
    logs: (host, token, owner, repo, id) =>
      stream(fetchAdapter, host, token, `${runs(owner, repo)}/${id}/logs`),
    jobLogs: (host, token, owner, repo, id) =>
      stream(fetchAdapter, host, token, `${repoPath(owner, repo)}/actions/jobs/${id}/logs`),
    artifacts: async (host, token, owner, repo, id, name) => {
      const collected: ActionArtifact[] = [];
      // A run's artifacts are paged, so every page is needed before a lookup can honestly say an
      // artifact is absent. Only an empty page ends the walk: the Host serves at most
      // `[api] MAX_RESPONSE_ITEMS` entries whatever is asked for, and that is instance-configured,
      // so a page shorter than the request is not evidence of the last page.
      //
      // `ActionArtifactList` is a bare array, so this reads the raw decoded body rather than going
      // through `jsonObject`. `record` passes an array through unchanged, so an object decode here
      // would leave `.artifacts` undefined and report every run as artifact-free. An empty body
      // decodes to undefined, which `artifactList` reads as no entries, ending the walk.
      for (let current = 1; current <= artifactPageLimit; current++) {
        const query = new URLSearchParams({
          page: String(current),
          limit: String(artifactPageRequest),
        });
        set(query, "name", name);
        const page = artifactList(
          await json(fetchAdapter, host, token, `${runs(owner, repo)}/${id}/artifacts?${query}`, {
            method: "GET",
          }),
        ).map(artifact);
        if (page.length === 0) return collected;
        collected.push(...page);
      }
      // Reaching the bound means the walk never saw the end, so `collected` is a partial answer.
      // Returning it would report a present artifact as missing, so this fails instead.
      throw tooManyArtifacts();
    },
    downloadArtifact: (host, token, owner, repo, id) =>
      stream(fetchAdapter, host, token, `${repoPath(owner, repo)}/actions/artifacts/${id}/zip`),
    dispatch: async (host, token, owner, repo, workflow, ref, inputs) => {
      const init = jsonRequest("POST", { ref, inputs, return_run_info: true });
      const dispatched = await json(
        fetchAdapter,
        host,
        token,
        `${repoPath(owner, repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
        init,
      );
      // The run is queued by the time this reads the answer, so a normalization failure here is
      // still a dispatch that happened.
      return dispatched === undefined
        ? undefined
        : readAnswer(init, () => run(host, owner, repo, dispatched));
    },
    rerunCapability: async (host, token) => {
      try {
        const value = record(
          await json(fetchAdapter, host, token, "/actions/extensions/rerun", { method: "GET" }),
        );
        return typeof value.name === "string" && typeof value.version === "number"
          ? {
              name: value.name,
              version: value.version,
              routes: array(value.routes).filter(
                (item): item is string => typeof item === "string",
              ),
            }
          : undefined;
      } catch (error) {
        if (error instanceof Error && error.message === "actions.not_found") return undefined;
        throw error;
      }
    },
    rerun: async (host, token, owner, repo, id, jobId) => {
      const path =
        jobId === undefined
          ? `${runs(owner, repo)}/${id}/rerun`
          : `${runs(owner, repo)}/${id}/jobs/${jobId}/rerun`;
      const init = { method: "POST" };
      const value = await jsonObject(fetchAdapter, host, token, path, init);
      return readAnswer(init, () => ({
        run: run(host, owner, repo, value.run),
        jobs: jobList(value.jobs),
      }));
    },
  };
}
// The Host clamps a page to its own `[api] MAX_RESPONSE_ITEMS`, so asking for the contract's
// largest page size just means fewer round trips where the Host allows them. The page bound is a
// runaway guard for a Host that never returns an empty page, not a result ceiling.
const artifactPageRequest = 100;
const artifactPageLimit = 50;
/**
 * Reports that a run's artifact listing never reached its end.
 *
 * Shaped like a selector failure rather than a bare `Error`, so the executor reports the code with
 * a message and a recovery a caller can act on instead of a generic failure with no details.
 */
function tooManyArtifacts(): { code: string; message: string; details: Record<string, unknown> } {
  return {
    code: "actions.too_many_artifacts",
    message: "The run's artifact listing did not end within the pages this client walks",
    details: {
      pages_walked: artifactPageLimit,
      requested_page_size: artifactPageRequest,
      recovery: "page /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts through api",
    },
  };
}
function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
function runs(owner: string, repo: string): string {
  return `${repoPath(owner, repo)}/actions/runs`;
}
async function json(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await call(fetchAdapter, host, token, path, init);
  try {
    return decodeJsonBody(response.body, "actions.invalid_response");
  } catch (error) {
    // The Host answered, so a body this client cannot read says nothing about whether the request
    // took effect.
    throw markTransmitted(error, init);
  }
}
/**
 * Decodes one response whose contract requires an object body.
 *
 * An empty body decodes to undefined, which would otherwise read as an object holding no
 * collection and let a caller conclude the Host has no runs, jobs, or artifacts at all.
 */
async function jsonObject(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const value = await json(fetchAdapter, host, token, path, init);
  if (value === undefined) throw markTransmitted(new Error("actions.invalid_response"), init);
  return record(value);
}
/**
 * Decodes one response whose contract requires a bare collection body.
 *
 * An empty body decodes to undefined, which would otherwise read as a collection holding nothing
 * and let a caller conclude the run has no jobs at all.
 */
async function jsonArray(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
  init: RequestInit,
): Promise<unknown[]> {
  const value = await json(fetchAdapter, host, token, path, init);
  if (!Array.isArray(value)) throw markTransmitted(new Error("actions.invalid_response"), init);
  return value;
}
async function empty(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
  init: RequestInit,
): Promise<void> {
  await call(fetchAdapter, host, token, path, init);
}
/**
 * Retrieves bulk content as a stream rather than reading it into memory.
 *
 * The caller pipes this straight to an Output store, so the bytes are bounded by the destination
 * filesystem instead of by the client's read bound. An unhappy status is classified before the
 * body is handed back, and its body is discarded rather than left open.
 */
async function stream(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
): Promise<ReadableStream<Uint8Array>> {
  // Bulk content is only ever read, so the marking below finds nothing to mark. It is threaded
  // through anyway, because a stream that later carried a state-changing method must report a
  // landed request the same way every other call does.
  const init: RequestInit = {
    method: "GET",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/zip, text/plain",
    },
  };
  const result = await requestStream(fetchAdapter, `${host}/api/v1${path}`, init);
  if (result.kind !== "stream")
    throw markTransmitted(new Error(`actions.${result.kind}`), init, result.transmitted);
  try {
    assertAnswered(result.status, init);
  } catch (error) {
    // The classified status is what the caller needs, so dropping the error page's body must not
    // be able to replace it with whatever cancelling failed with.
    await abandonBody(result.body);
    throw error;
  }
  return result.body;
}
async function call(
  fetchAdapter: FetchAdapter,
  host: string,
  token: string,
  path: string,
  init: RequestInit,
): Promise<{ status: number; body: Uint8Array }> {
  const result = await request(fetchAdapter, `${host}/api/v1${path}`, {
    ...init,
    headers: { Authorization: `token ${token}`, Accept: "application/json", ...init.headers },
  });
  // A dispatch whose answer was lost has still queued its run, so every failure past this point
  // reports whether the Host received the request rather than leaving the caller to re-dispatch.
  // An answer too large to read is still an answer, so it reports the same way.
  if (result.kind === "too_large")
    throw markTransmitted(responseTooLarge("actions", result), init, result.transmitted);
  if (result.kind !== "response")
    throw markTransmitted(new Error(`actions.${result.kind}`), init, result.transmitted);
  assertAnswered(result.response.status, init);
  return result.response;
}
/**
 * Throws the failure a response status reports, and returns when the Host answered normally.
 *
 * The Host answered, so every failure it raises is transmitted by definition and marks itself
 * accordingly: a mutation behind an unhappy status may still have landed.
 */
function assertAnswered(status: number, init: RequestInit): void {
  if (status === 401 || status === 403) throw markTransmitted(new Error("auth.required"), init);
  if (status === 404) throw markTransmitted(new Error("actions.not_found"), init);
  if (status < 200 || status >= 300)
    throw markTransmitted(new Error("actions.request_failed"), init);
}
function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } };
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
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error("actions.invalid_response");
  return value;
}
/**
 * Normalizes a Forgejo run response.
 */
export function normalizeActionRun(
  host: string,
  owner: string,
  repo: string,
  value: unknown,
): ActionRun {
  return run(host, owner, repo, value);
}
function run(host: string, owner: string, repo: string, value: unknown): ActionRun {
  const source = record(value);
  const id = integer(source.id);
  // A dispatch answers with DispatchWorkflowRun, which names the repository index `run_number`.
  const index = integer(source.index_in_repo ?? source.run_number ?? id);
  return {
    id,
    index_in_repo: index,
    workflow_id: text(source.workflow_id),
    title: text(source.title),
    event: text(source.event),
    status: text(source.status),
    commit_sha: text(source.commit_sha),
    prettyref: text(source.prettyref),
    created: text(source.created),
    updated: text(source.updated),
    // Forgejo keys the run page by the repository index, not the run ID.
    web_url: text(source.html_url) ?? `${host}/${owner}/${repo}/actions/runs/${index}`,
  };
}
/**
 * Normalizes a Forgejo job response.
 */
export function normalizeActionJob(value: unknown): ActionJob {
  return job(value);
}
function jobList(value: unknown): ActionJob[] {
  return array(value).map(job);
}
function job(value: unknown): ActionJob {
  const source = record(value);
  return {
    id: integer(source.id),
    name: typeof source.name === "string" ? source.name : String(source.id),
    status: text(source.status),
    attempt: typeof source.attempt === "number" ? source.attempt : null,
  };
}
/**
 * Reads the artifact entries out of a `ListActionRunArtifacts` body.
 *
 * `ActionArtifactList` is the array itself, unlike `ListActionRunResponse`, which wraps runs in
 * `workflow_runs`. A wrapper is still tolerated so a Host that grows one stays readable.
 */
function artifactList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : array(record(value).artifacts);
}
function artifact(value: unknown): ActionArtifact {
  const source = record(value);
  return {
    id: integer(source.id),
    name: typeof source.name === "string" ? source.name : String(source.id),
    size_in_bytes: typeof source.size_in_bytes === "number" ? source.size_in_bytes : null,
  };
}
