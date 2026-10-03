import { expect, test } from "bun:test";
import { createActionsGateway } from "../packages/forgejo/src/actions-gateway";
import { createApiActionsCatalog } from "../packages/forgejo/src/api-actions-catalog";
import {
  emptyHostConfig,
  HostSession,
  type HostConfig,
  type HostCredentialStore,
} from "../packages/forgejo/src/host-session";
import { request, type FetchAdapter } from "../packages/forgejo/src/infrastructure";
import { createIssuesGateway } from "../packages/forgejo/src/issue-gateway";
import { createPullRequestCatalog } from "../packages/forgejo/src/pull-request-catalog";
import { createPullRequestsGateway } from "../packages/forgejo/src/pull-request-gateway";
import { createRawApiGateway } from "../packages/forgejo/src/raw-api-gateway";
import { createRepositoryCatalog } from "../packages/forgejo/src/repository-catalog";
import { createRepositoryGateway } from "../packages/forgejo/src/repository-gateway";
import {
  execute,
  type CapabilitySet,
  type CommandDefinition,
  type Effect,
} from "../packages/forgejo/src/runtime";
import type { WorkflowGateway } from "../packages/forgejo/src/workflow-gateway";

const host = "https://forgejo.example";
const credentials: HostCredentialStore = {
  get: async () => "synthetic-token",
  put: async () => {},
  remove: async () => {},
};

function session(advertised: Record<string, unknown> = {}): HostSession {
  let config: HostConfig = {
    ...emptyHostConfig(),
    hosts: [
      {
        url: host,
        identity: { id: "1", login: "octo" },
        server_version: "16.0.2",
        swagger_sha256: null,
      },
    ],
  };
  return new HostSession(
    { load: async () => config, save: async (next) => void (config = next) },
    credentials,
    {
      inspect: async () => ({
        version: "16.0.2",
        identity: { id: "1", login: "octo" },
        swagger: JSON.stringify({ paths: advertised }),
      }),
    },
    [],
    () => new Date("2025-01-01"),
  );
}
function capabilities(overrides: Partial<CapabilitySet>): CapabilitySet {
  return {
    gateway: { smoke: async ({ value }: { value: string }) => ({ echoed: value }) },
    host: session(),
    repositories: undefined,
    git: undefined,
    output: { write: async () => "/tmp/output", stream: async () => "/tmp/output" },
    environment: {},
    cwd: "/repo",
    keychainNoUi: true,
    clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    cancelled: () => false,
    ...overrides,
  };
}
function pullCapabilities(fetchAdapter: FetchAdapter): CapabilitySet {
  return capabilities({
    pullRequests: createPullRequestsGateway(fetchAdapter),
    issues: createIssuesGateway(fetchAdapter),
  });
}
function actionsCapabilities(fetchAdapter: FetchAdapter): CapabilitySet {
  const workflows: WorkflowGateway = {
    list: async () => [{ name: "ci.yml", path: ".forgejo/workflows/ci.yml", content: "name: CI" }],
    get: async () => ({ name: "ci.yml", path: ".forgejo/workflows/ci.yml", content: "name: CI" }),
  };
  return capabilities({ actions: createActionsGateway(fetchAdapter), workflows });
}
/** Runs one approval-gated command, taking the grant from its own refusal. */
async function approved(
  command: string,
  input: Record<string, unknown>,
  catalog: CommandDefinition[],
  set: CapabilitySet,
): Promise<Awaited<ReturnType<typeof execute>>> {
  // `api` is the one leaf with no repository selector, and its schema rejects unknown keys.
  const invocation = {
    command,
    input: { host, ...(command === "api" ? {} : { repo: "octo/demo" }), ...input },
    requestId: `${command.replace(" ", "-")}-landed`,
    approval: undefined as string | undefined,
    dryRun: false,
    mode: "request" as const,
  };
  const planned = await execute(invocation, catalog, set);
  const grant = String(planned.error?.details.approve).replace("--approve ", "");
  return execute({ ...invocation, approval: grant }, catalog, set);
}
function states(outcome: Awaited<ReturnType<typeof execute>>): Array<[string, string]> {
  return outcome.effects.map((effect: Effect) => [effect.action, effect.state]);
}
/** Answers one pull request, merged or not, in the shape the contract advertises. */
function pullResponse(merged: boolean): Response {
  return Response.json(
    {
      number: 7,
      title: "Add a thing",
      state: merged ? "closed" : "open",
      merged,
      base: { ref: "main" },
      head: { ref: "feature", sha: "abc" },
    },
    { status: 200 },
  );
}
/** Fails a send outright, the way a Host this client never reached does. */
const unreachable: FetchAdapter = async () => {
  throw new TypeError("connection refused");
};

test("a dispatch whose answer cannot be read is not reported as never attempted", async () => {
  // The run is queued the moment the Host takes the POST. Reporting `planned` here reads as
  // "nothing happened" and gets the job queued a second time on the retry.
  const outcome = await approved(
    "workflow run",
    { workflow: "ci.yml", ref: "main" },
    createApiActionsCatalog(),
    actionsCapabilities(async () => new Response("{oops", { status: 201 })),
  );
  expect(outcome.error?.code).toBe("actions.invalid_response");
  expect(states(outcome)).toEqual([["workflow.dispatch", "unknown"]]);
  expect(outcome.effects[0]?.details).toMatchObject({ transmitted: true });
});

test("a dispatch whose answer decodes but will not normalize is not reported as never attempted", async () => {
  // The same error code covers both, and the run is queued either way, so the mark cannot stop at
  // the decode step.
  const outcome = await approved(
    "workflow run",
    { workflow: "ci.yml", ref: "main" },
    createApiActionsCatalog(),
    actionsCapabilities(async () => Response.json({ id: "7" }, { status: 201 })),
  );
  expect(outcome.error?.code).toBe("actions.invalid_response");
  expect(states(outcome)).toEqual([["workflow.dispatch", "unknown"]]);
  expect(outcome.effects[0]?.details).toMatchObject({ transmitted: true });
});

test("a dispatch that never reached the Host is still reported as never attempted", async () => {
  const outcome = await approved(
    "workflow run",
    { workflow: "ci.yml", ref: "main" },
    createApiActionsCatalog(),
    actionsCapabilities(unreachable),
  );
  expect(outcome.error?.code).toBe("actions.network");
  expect(states(outcome)).toEqual([["workflow.dispatch", "planned"]]);
  expect(outcome.effects[0]?.details).toEqual({});
});

test("a dispatch whose answer is too large to read is not reported as never attempted", async () => {
  // The two mechanisms meet here. The size bound refuses an answer this client cannot hold, but
  // an answer arriving at all means the Host already took the POST and queued the run, so the
  // effect is `unknown` rather than `planned`. Reporting a size failure as never attempted would
  // get the job queued a second time, which is the whole point of the transmitted mark.
  const outcome = await approved(
    "workflow run",
    { workflow: "ci.yml", ref: "main" },
    createApiActionsCatalog(),
    actionsCapabilities(
      async () =>
        new Response("{}", {
          status: 201,
          headers: { "content-length": String(64 * 1024 * 1024) },
        }),
    ),
  );
  expect(outcome.error?.code).toBe("actions.response_too_large");
  expect(outcome.error?.details).toMatchObject({
    limit_bytes: 16 * 1024 * 1024,
    response_bytes: 64 * 1024 * 1024,
    status: 201,
  });
  expect(states(outcome)).toEqual([["workflow.dispatch", "unknown"]]);
  expect(outcome.effects[0]?.details).toMatchObject({ transmitted: true });
});

test("an oversized answer to a read leaves its effects honestly unattempted", async () => {
  // The mark comes from what the transport did, not from which command asked. `run cancel` reads
  // the run first, and a read that returns too much has still changed nothing on the Host.
  const outcome = await approved(
    "run cancel",
    { run: { kind: "id", value: 42 } },
    createApiActionsCatalog(),
    actionsCapabilities(async (_input, init) =>
      init?.method === "GET"
        ? new Response("{}", {
            status: 200,
            headers: { "content-length": String(64 * 1024 * 1024) },
          })
        : new Response("", { status: 200 }),
    ),
  );
  expect(outcome.error?.code).toBe("actions.response_too_large");
  expect(states(outcome)).toEqual([["run.cancel", "planned"]]);
  expect(outcome.effects[0]?.details).toEqual({});
});

test("a mutation whose read fails before it sends anything reports its effect as planned", async () => {
  // The signal is the transmitted mutation, not the command: `run cancel` is a mutation, and the
  // request that failed was the run lookup, which changed nothing.
  const outcome = await approved(
    "run cancel",
    { run: { kind: "id", value: 42 } },
    createApiActionsCatalog(),
    actionsCapabilities(async (_input, init) =>
      init?.method === "GET"
        ? new Response("", { status: 404 })
        : new Response("", { status: 200 }),
    ),
  );
  expect(outcome.error?.code).toBe("actions.not_found");
  expect(states(outcome)).toEqual([["run.cancel", "planned"]]);
});

test("a merge that lands and then refuses the branch deletion reports both effects truthfully", async () => {
  // Forgejo deletes the head branch inside the merge call, once the merge has already landed, and
  // answers a refusal with 403. The merge is a fact by then.
  const outcome = await approved(
    "pr merge",
    { index: 7, merge: true, delete_branch: true },
    createPullRequestCatalog(),
    pullCapabilities(async (_input, init) =>
      init?.method === "POST" ? new Response("", { status: 403 }) : pullResponse(true),
    ),
  );
  expect(outcome.status).toBe("error");
  expect(outcome.result).toMatchObject({ scheduled: false });
  expect(states(outcome)).toEqual([
    ["pull_request.merge", "succeeded"],
    ["branch.delete", "failed"],
  ]);
  expect(outcome.error).toMatchObject({
    code: "pull_request.branch_delete_failed",
    details: { cause: "auth.required" },
  });
});

test("a merge the Host refused outright reports both effects as failed, not merged", async () => {
  const outcome = await approved(
    "pr merge",
    { index: 7, merge: true, delete_branch: true },
    createPullRequestCatalog(),
    pullCapabilities(async (_input, init) =>
      init?.method === "POST" ? new Response("", { status: 403 }) : pullResponse(false),
    ),
  );
  expect(outcome.result).toBeNull();
  expect(outcome.error?.code).toBe("auth.required");
  expect(states(outcome)).toEqual([
    ["pull_request.merge", "failed"],
    ["branch.delete", "failed"],
  ]);
});

test("a merge whose outcome the Host will not confirm stays unresolved rather than planned", async () => {
  const outcome = await approved(
    "pr merge",
    { index: 7, merge: true, delete_branch: true },
    createPullRequestCatalog(),
    pullCapabilities(async (_input, init) =>
      init?.method === "POST"
        ? new Response("", { status: 500 })
        : new Response("", { status: 500 }),
    ),
  );
  expect(outcome.error?.code).toBe("pull_request.request_failed");
  expect(states(outcome)).toEqual([
    ["pull_request.merge", "unknown"],
    ["branch.delete", "unknown"],
  ]);
});

test("a merge whose answer is too large to read is reconciled, not reported as never attempted", async () => {
  // The highest-stakes instance of the two mechanisms meeting. Reconciliation only runs on a
  // transmitted failure, so an unmarked size failure would rethrow with both effects `planned`
  // and a caller would merge a pull request that is already merged.
  const outcome = await approved(
    "pr merge",
    { index: 7, merge: true },
    createPullRequestCatalog(),
    pullCapabilities(async (_input, init) =>
      init?.method === "POST"
        ? new Response("{}", {
            status: 200,
            headers: { "content-length": String(64 * 1024 * 1024) },
          })
        : pullResponse(true),
    ),
  );
  expect(states(outcome)).toEqual([["pull_request.merge", "succeeded"]]);
  expect(outcome.result).toMatchObject({ scheduled: false });
  expect(outcome.error?.code).toBe("pull_request.response_too_large");
});

test("an api write whose answer is too large to read is not reported as never attempted", async () => {
  // The same composition through the raw gateway: the write is a mutation like any other, and an
  // answer arriving at all means the Host performed it.
  const outcome = await approved(
    "api",
    {
      endpoint: "/repos/octo/demo/issues",
      method: "POST",
      input: JSON.stringify({ title: "Add a thing" }),
    },
    createApiActionsCatalog(),
    capabilities({
      host: session({
        "/repos/{owner}/{repo}/issues": {
          post: { operationId: "issueCreateIssue", responses: { "201": {} } },
        },
      }),
      rawApi: createRawApiGateway(
        async () =>
          new Response("{}", {
            status: 201,
            headers: { "content-length": String(64 * 1024 * 1024) },
          }),
      ),
    }),
  );
  expect(outcome.error?.code).toBe("api.response_too_large");
  expect(states(outcome)).toEqual([["api.request", "unknown"]]);
  expect(outcome.effects[0]?.details).toMatchObject({ transmitted: true });
});

test("a repository delete whose answer is too large to read is not reported as never attempted", async () => {
  // The third gateway that marks a size failure. A delete answered at all has deleted, so the
  // ledger must not read as though the repository is still there.
  const outcome = await approved(
    "repo delete",
    { repo: "octo/demo" },
    createRepositoryCatalog(),
    capabilities({
      repositories: createRepositoryGateway(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-length": String(64 * 1024 * 1024) },
          }),
      ),
    }),
  );
  expect(outcome.error?.code).toBe("repository.response_too_large");
  expect(states(outcome)).toEqual([["repository.delete", "unknown"]]);
  expect(outcome.effects[0]?.details).toMatchObject({ transmitted: true });
});

test("a merge that never reached the Host reports both effects as planned", async () => {
  const outcome = await approved(
    "pr merge",
    { index: 7, merge: true, delete_branch: true },
    createPullRequestCatalog(),
    pullCapabilities(unreachable),
  );
  expect(outcome.error?.code).toBe("pull_request.network");
  expect(states(outcome)).toEqual([
    ["pull_request.merge", "planned"],
    ["branch.delete", "planned"],
  ]);
});

test("an api write answered with an unadvertised status is not reported as never attempted", async () => {
  // `api` is the documented write escape hatch, and the surprising answer is exactly the case
  // where "did it land?" matters most.
  const outcome = await approved(
    "api",
    { endpoint: "/repos/octo/demo/issues", method: "POST" },
    createApiActionsCatalog(),
    capabilities({
      host: session({
        "/repos/{owner}/{repo}/issues": {
          post: { operationId: "issueCreateIssue", responses: { "201": {} } },
        },
      }),
      rawApi: createRawApiGateway(async () => new Response("", { status: 200 })),
    }),
  );
  expect(outcome.error?.code).toBe("api.unexpected_response");
  expect(states(outcome)).toEqual([["api.request", "unknown"]]);
  expect(outcome.effects[0]?.details).toMatchObject({ transmitted: true });
});

test("an api write whose bytes cannot be delivered is not reported as never attempted", async () => {
  // Delivering the answer is local work. The write landed before the output store was ever asked.
  const outcome = await approved(
    "api",
    { endpoint: "/repos/octo/demo/issues", method: "POST", output: "/nope/output.zip" },
    createApiActionsCatalog(),
    capabilities({
      host: session({
        "/repos/{owner}/{repo}/issues": {
          post: { operationId: "issueCreateIssue", responses: { "201": {} } },
        },
      }),
      output: {
        write: async () => {
          throw new Error("EACCES");
        },
        stream: async () => {
          throw new Error("EACCES");
        },
      },
      rawApi: createRawApiGateway(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 201,
            headers: { "content-type": "application/zip" },
          }),
      ),
    }),
  );
  expect(outcome.status).toBe("error");
  expect(states(outcome)).toEqual([["api.request", "unknown"]]);
  expect(outcome.effects[0]?.details).toMatchObject({ transmitted: true });
});

test("a scheduled merge the Host will not confirm is not reported as a failed merge", async () => {
  // Under `when_checks_succeed`, an unmerged pull request is also what a merge the Host accepted
  // and scheduled looks like, so this cannot claim the merge did not happen.
  const outcome = await approved(
    "pr merge",
    { index: 7, merge: true, when_checks_succeed: true },
    createPullRequestCatalog(),
    pullCapabilities(async (_input, init) =>
      init?.method === "POST" ? new Response("", { status: 500 }) : pullResponse(false),
    ),
  );
  expect(outcome.error?.code).toBe("pull_request.request_failed");
  expect(states(outcome)).toEqual([["pull_request.merge", "unknown"]]);
});

test("the transport reports transmission from the answer, not from the request it sent", async () => {
  const lost = new Response(
    new ReadableStream({
      start: (controller) => controller.error(new Error("connection reset")),
    }),
    { status: 200 },
  );
  const read = await request(async () => lost, host, { method: "POST" });
  expect(read).toMatchObject({ kind: "network", transmitted: true });
  const sent = await request(unreachable, host, { method: "POST" });
  expect(sent).toMatchObject({ kind: "network", transmitted: false });
  const answered = await request(async () => new Response("{}", { status: 200 }), host, {
    method: "POST",
  });
  expect(answered.kind).toBe("response");
});
