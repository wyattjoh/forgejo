import { expect, test } from "bun:test";
import {
  createActionsGateway,
  normalizeActionJob,
  normalizeActionRun,
} from "../packages/forgejo/src/actions-gateway";
import { selectedOperations } from "../packages/forgejo/src/generated/operation-types";
import type { FetchAdapter } from "../packages/forgejo/src/infrastructure";

const host = "https://forgejo.example";
const owner = "octo";
const repo = "demo";
const token = "synthetic-token";
const artifacts = `/api/v1/repos/${owner}/${repo}/actions/runs/42/artifacts`;
// Shaped exactly as `convert.ToActionRun` serializes a run, so the contract test below can prove
// every key of it is advertised.
const body = {
  id: 42,
  title: "Add continuous integration",
  workflow_id: "ci.yml",
  index_in_repo: 9,
  prettyref: "main",
  is_ref_deleted: false,
  commit_sha: "9f1c2d3e4b5a69788796a5b4c3d2e1f0a9b8c7d6",
  is_fork_pull_request: false,
  need_approval: false,
  approved_by: 0,
  event: "push",
  event_payload: "{}",
  trigger_event: "push",
  status: "success",
  started: "2025-01-01T00:00:00Z",
  stopped: "2025-01-01T00:01:00Z",
  created: "2025-01-01T00:00:00Z",
  updated: "2025-01-01T00:01:00Z",
  html_url: `${host}/${owner}/${repo}/actions/runs/9`,
};

// Shaped exactly as `convert.ToActionRunJob` serializes a job, so the contract test below can
// prove every key of it is advertised.
const jobBody = {
  id: 3,
  run_id: 42,
  repo_id: 7,
  owner_id: 1,
  name: "test",
  needs: ["build"],
  runs_on: ["docker"],
  task_id: 11,
  status: "failure",
  attempt: 2,
  handle: "3-2",
};

async function contract(): Promise<{
  definitions: Record<string, { properties?: Record<string, unknown> }>;
  responses: Record<string, { schema?: { type?: string } }>;
}> {
  return (await Bun.file(new URL("../swagger.v1.json", import.meta.url)).json()) as Awaited<
    ReturnType<typeof contract>
  >;
}
async function definitionProperties(name: string): Promise<Record<string, unknown>> {
  return (await contract()).definitions[name]?.properties ?? {};
}
async function contractProperties(): Promise<Record<string, unknown>> {
  return definitionProperties("ActionRun");
}
async function jobContractProperties(): Promise<Record<string, unknown>> {
  return definitionProperties("ActionRunJob");
}

/** Answers from a fixed route table and records every path the gateway asked for. */
function transport(routes: Record<string, BodyInit>): {
  fetchAdapter: FetchAdapter;
  requested: string[];
} {
  const requested: string[] = [];
  return {
    requested,
    fetchAdapter: async (input) => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      requested.push(path);
      const body = routes[path] ?? routes[url.pathname];
      return body === undefined ? new Response("", { status: 404 }) : new Response(body);
    },
  };
}

/** Reads the typed failure a call rejects with, so its code and details can be asserted. */
async function rejection(
  call: Promise<unknown>,
): Promise<{ code: string; details: Record<string, unknown> }> {
  try {
    await call;
  } catch (error) {
    return error as { code: string; details: Record<string, unknown> };
  }
  throw new Error("expected the call to reject");
}
/** Reads a streamed bulk body, which the gateway hands back instead of a buffer. */
async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

function artifactPage(from: number, count: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      id: from + index,
      name: `artifact-${from + index}`,
      size_in_bytes: 1,
      run_id: 42,
      archive_download_url: `${host}/api/v1/repos/${owner}/${repo}/actions/artifacts/${from + index}/zip`,
    })),
  );
}

test("a normalized run carries the title, status, commit, ref, and timestamps Forgejo sent", () => {
  expect(normalizeActionRun(host, owner, repo, body)).toEqual({
    id: 42,
    index_in_repo: 9,
    workflow_id: "ci.yml",
    title: "Add continuous integration",
    event: "push",
    status: "success",
    commit_sha: "9f1c2d3e4b5a69788796a5b4c3d2e1f0a9b8c7d6",
    prettyref: "main",
    created: "2025-01-01T00:00:00Z",
    updated: "2025-01-01T00:01:00Z",
    web_url: `${host}/${owner}/${repo}/actions/runs/9`,
  });
});

test("a normalized run omits run-level fields Forgejo does not provide", async () => {
  const normalized = normalizeActionRun(host, owner, repo, body) as Record<string, unknown>;
  const properties = await contractProperties();
  for (const absent of ["conclusion", "attempt", "head_sha", "ref", "created_at", "updated_at"]) {
    expect(properties).not.toHaveProperty(absent);
    expect(normalized).not.toHaveProperty(absent);
  }
});

test("normalized run field names are the committed contract's run field names", async () => {
  const properties = await contractProperties();
  expect(Object.keys(properties).length).toBeGreaterThan(0);
  // `web_url` is this CLI's house name for the resource link and is derived from `html_url`;
  // every other key is passed straight through, so a rename on the host fails here.
  for (const key of Object.keys(normalizeActionRun(host, owner, repo, body)))
    if (key !== "web_url") expect(properties).toHaveProperty(key);
  for (const key of Object.keys(body)) expect(properties).toHaveProperty(key);
});

test("the committed contract answers a run's artifacts with a bare array, not a wrapper", async () => {
  // `ListActionRunResponse` wraps runs in `workflow_runs`, but `ActionArtifactList` is the array
  // itself, so reading an `artifacts` key off the body finds nothing and every lookup misses.
  const document = await contract();
  expect(document.responses.ActionArtifactList?.schema?.type).toBe("array");
  expect(document.definitions.ListActionRunResponse?.properties).toHaveProperty("workflow_runs");
});

test("a run's artifacts are read from the bare array the contract advertises", async () => {
  const { fetchAdapter } = transport({
    [`${artifacts}?page=1&limit=100`]: JSON.stringify([
      { id: 5, name: "coverage", size_in_bytes: 3, run_id: 42 },
      { id: 6, name: "logs", run_id: 42 },
    ]),
    [`${artifacts}?page=2&limit=100`]: "[]",
  });
  expect(
    await createActionsGateway(fetchAdapter).artifacts(host, token, owner, repo, 42, undefined),
  ).toEqual([
    { id: 5, name: "coverage", size_in_bytes: 3 },
    { id: 6, name: "logs", size_in_bytes: null },
  ]);
});

test("a name filter reaches the Host and paging survives a Host that serves short pages", async () => {
  // A Host with `[api] MAX_RESPONSE_ITEMS = 20` serves twenty entries for a hundred-entry request.
  // Treating a short page as the last one would hide artifacts 21 and up, which is this ticket's
  // own defect, so only an empty page ends the walk.
  const { fetchAdapter, requested } = transport({
    [`${artifacts}?page=1&limit=100&name=coverage`]: artifactPage(1, 20),
    [`${artifacts}?page=2&limit=100&name=coverage`]: artifactPage(21, 20),
    [`${artifacts}?page=3&limit=100&name=coverage`]: artifactPage(41, 3),
    [`${artifacts}?page=4&limit=100&name=coverage`]: "[]",
  });
  const listed = await createActionsGateway(fetchAdapter).artifacts(
    host,
    token,
    owner,
    repo,
    42,
    "coverage",
  );
  expect(listed).toHaveLength(43);
  expect(listed.at(-1)).toEqual({ id: 43, name: "artifact-43", size_in_bytes: 1 });
  expect(requested).toHaveLength(4);
  expect(requested[3]).toBe(`${artifacts}?page=4&limit=100&name=coverage`);
});

test("an artifact listing that never ends fails loudly instead of answering from a partial walk", async () => {
  // A Host that ignores `page` would otherwise have the walk stop at its own bound and then report
  // a present artifact as missing, which is a worse answer than no answer.
  const { fetchAdapter, requested } = transport({ [artifacts]: artifactPage(1, 20) });
  const thrown = await createActionsGateway(fetchAdapter)
    .artifacts(host, token, owner, repo, 42, undefined)
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  // Shaped like a selector failure, so the executor carries the message and recovery through
  // rather than reporting a generic failure with no details.
  expect(thrown).toMatchObject({
    code: "actions.too_many_artifacts",
    message: expect.any(String),
    details: { pages_walked: expect.any(Number), recovery: expect.any(String) },
  });
  expect(requested.length).toBeGreaterThan(1);
});

test("an artifact page that decodes to nothing ends the walk rather than failing", async () => {
  // A Host answering an empty body decodes to undefined, which reads as no entries. Ticket 03's
  // `jsonObject` would reject that, and would also leave `.artifacts` undefined on the bare array.
  const { fetchAdapter } = transport({
    [`${artifacts}?page=1&limit=100`]: JSON.stringify([{ id: 5, name: "coverage" }]),
    [`${artifacts}?page=2&limit=100`]: "",
  });
  expect(
    await createActionsGateway(fetchAdapter).artifacts(host, token, owner, repo, 42, undefined),
  ).toEqual([{ id: 5, name: "coverage", size_in_bytes: null }]);
});

test("an artifact downloads from the zip route the committed manifest allowlists", async () => {
  const archive = new Uint8Array([80, 75, 3, 4, 20, 0]);
  const { fetchAdapter, requested } = transport({
    [`/api/v1/repos/${owner}/${repo}/actions/artifacts/5/zip`]: archive,
  });
  // The gateway streams bulk content, so the archive is read off the stream rather than returned
  // as a buffer the client had to hold whole.
  expect(
    await collect(
      await createActionsGateway(fetchAdapter).downloadArtifact(host, token, owner, repo, 5),
    ),
  ).toEqual(archive);
  expect(requested).toEqual([`/api/v1/repos/${owner}/${repo}/actions/artifacts/5/zip`]);
  expect(
    selectedOperations.find((entry) => entry.operation_id === "DownloadActionArtifact")?.path,
  ).toBe("/repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip");
});

test("a JSON response past the read bound reports its size rather than a network failure", async () => {
  // A run list from a Host with an enormous page is a healthy answer that is simply too big to
  // hold. Reporting it as a network failure sends a caller into a retry that re-reads the same
  // answer, so the failure names the limit and the size the Host advertised instead.
  const fetchAdapter: FetchAdapter = async () =>
    new Response(JSON.stringify({ workflow_runs: [] }), {
      headers: { "content-length": String(64 * 1024 * 1024) },
    });
  const thrown = await rejection(
    createActionsGateway(fetchAdapter).jobs(host, token, owner, repo, 42),
  );
  expect(thrown.code).toBe("actions.response_too_large");
  expect(thrown.details).toMatchObject({
    limit_bytes: 16 * 1024 * 1024,
    response_bytes: 64 * 1024 * 1024,
    status: 200,
  });
});

test("a log stream larger than the read bound is delivered rather than refused", async () => {
  // The bound exists to keep a response out of memory, and a log never enters memory: it goes
  // straight to a file. So the boundary for bulk content is delivery, not refusal.
  const chunk = 4 * 1024 * 1024;
  let remaining = 6;
  const fetchAdapter: FetchAdapter = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull: (controller) =>
          remaining-- > 0 ? controller.enqueue(new Uint8Array(chunk)) : controller.close(),
      }),
    );
  const logs = await createActionsGateway(fetchAdapter).logs(host, token, owner, repo, 42);
  expect((await collect(logs)).byteLength).toBe(6 * chunk);
});

test("a bulk read reports an unhappy status and drops the body it will not hand back", async () => {
  let cancelled = false;
  const errorPage = new ReadableStream<Uint8Array>({
    pull: (controller) => controller.enqueue(new Uint8Array(8)),
    cancel: () => void (cancelled = true),
  });
  const fetchAdapter: FetchAdapter = async () => new Response(errorPage, { status: 404 });
  await expect(
    createActionsGateway(fetchAdapter).logs(host, token, owner, repo, 42),
  ).rejects.toThrow("actions.not_found");
  expect(cancelled).toBe(true);
});

test("a status failure survives a body that refuses to be dropped", async () => {
  // The classified status is the actionable fact. A cleanup that throws must not replace it with
  // a failure the executor can only report as a generic one.
  const fetchAdapter: FetchAdapter = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull: (controller) => controller.enqueue(new Uint8Array(8)),
        cancel: () => {
          throw new Error("cancel blew up");
        },
      }),
      { status: 404 },
    );
  await expect(
    createActionsGateway(fetchAdapter).downloadArtifact(host, token, owner, repo, 5),
  ).rejects.toThrow("actions.not_found");
});

test("downloading an artifact the Host does not have reports a typed not-found", async () => {
  const { fetchAdapter } = transport({});
  await expect(
    createActionsGateway(fetchAdapter).downloadArtifact(host, token, owner, repo, 99),
  ).rejects.toThrow("actions.not_found");
});

test("a dispatched run keeps its run number and derives a web URL from it", () => {
  // A dispatch answers with DispatchWorkflowRun, which carries the run number rather than the
  // repository index, and no link. Forgejo's own run link is keyed by the index, not the ID.
  expect(normalizeActionRun(host, owner, repo, { id: 42, run_number: 9, jobs: ["build"] })).toEqual(
    {
      id: 42,
      index_in_repo: 9,
      workflow_id: null,
      title: null,
      event: null,
      status: null,
      commit_sha: null,
      prettyref: null,
      created: null,
      updated: null,
      web_url: `${host}/${owner}/${repo}/actions/runs/9`,
    },
  );
});

test("a normalized job carries the id, name, status, and attempt Forgejo sent", () => {
  expect(normalizeActionJob(jobBody)).toEqual({
    id: 3,
    name: "test",
    status: "failure",
    attempt: 2,
  });
});

test("a normalized job omits job fields Forgejo does not provide", async () => {
  const normalized = normalizeActionJob(jobBody) as Record<string, unknown>;
  const properties = await jobContractProperties();
  // Guards the absence assertions below, which would pass trivially if the definition vanished.
  expect(Object.keys(properties).length).toBeGreaterThan(0);
  // Forgejo carries the outcome in `status`; there is no separate conclusion, and the attempt is
  // named `attempt`, not GitHub's `run_attempt`.
  for (const absent of ["conclusion", "run_attempt", "started_at", "completed_at", "html_url"]) {
    expect(properties).not.toHaveProperty(absent);
    expect(normalized).not.toHaveProperty(absent);
  }
});

test("normalized job field names are the committed contract's job field names", async () => {
  const properties = await jobContractProperties();
  expect(Object.keys(properties).length).toBeGreaterThan(0);
  for (const key of Object.keys(normalizeActionJob(jobBody)))
    expect(properties).toHaveProperty(key);
  for (const key of Object.keys(jobBody)) expect(properties).toHaveProperty(key);
});

test("a job attempt comes from the advertised attempt, never GitHub's run_attempt", () => {
  expect(normalizeActionJob({ id: 3, name: "test", status: "success", run_attempt: 4 })).toEqual({
    id: 3,
    name: "test",
    status: "success",
    attempt: null,
  });
});

test("a run's jobs decode the bare ActionRunJob array the contract advertises", async () => {
  const paths: string[] = [];
  const gateway = createActionsGateway(async (input) => {
    paths.push(new URL(String(input)).pathname);
    // `ListActionRunJobs` answers `ActionRunJobList`, a bare array, not an envelope.
    return new Response(JSON.stringify([jobBody, { ...jobBody, id: 4, name: "build" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  expect(await gateway.jobs(host, "synthetic-token", owner, repo, 42)).toEqual([
    { id: 3, name: "test", status: "failure", attempt: 2 },
    { id: 4, name: "build", status: "failure", attempt: 2 },
  ]);
  expect(paths).toEqual([`/api/v1/repos/${owner}/${repo}/actions/runs/42/jobs`]);
});
