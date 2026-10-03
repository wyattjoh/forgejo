import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createActionsGateway } from "../packages/forgejo/src/actions-gateway";
import { createApiActionsCatalog } from "../packages/forgejo/src/api-actions-catalog";
import {
  emptyHostConfig,
  HostSession,
  type HostConfig,
  type HostCredentialStore,
} from "../packages/forgejo/src/host-session";
import type { FetchAdapter } from "../packages/forgejo/src/infrastructure";
import { createIssuesGateway } from "../packages/forgejo/src/issue-gateway";
import { createPullRequestCatalog } from "../packages/forgejo/src/pull-request-catalog";
import { createPullRequestsGateway } from "../packages/forgejo/src/pull-request-gateway";
import { createRawApiGateway } from "../packages/forgejo/src/raw-api-gateway";
import { execute, type CapabilitySet } from "../packages/forgejo/src/runtime";
import type { WorkflowGateway } from "../packages/forgejo/src/workflow-gateway";

const host = "https://forgejo.example";
const mergePath = "/repos/{owner}/{repo}/pulls/{index}/merge";
const dispatchPath = "/repos/{owner}/{repo}/actions/workflows/{workflowfilename}/dispatches";
const deletePath = "/repos/{owner}/{repo}";
const jobsPath = "/repos/{owner}/{repo}/actions/runs/{run_id}/jobs";
const contract = JSON.parse(
  readFileSync(new URL("../swagger.v1.json", import.meta.url), "utf8"),
) as {
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string }> }>>;
  responses: Record<string, { schema?: { type?: string } }>;
  definitions: Record<
    string,
    { properties?: Record<string, { type?: string; additionalProperties?: { type?: string } }> }
  >;
};
const credentials: HostCredentialStore = {
  get: async () => "synthetic-token",
  put: async () => {},
  remove: async () => {},
};

/** Reads one advertised operation from the committed Host contract. */
function operation(path: string, method: string): { responses: Record<string, { $ref?: string }> } {
  const advertised = contract.paths[path]?.[method];
  if (!advertised) throw new Error(`contract.operation_missing:${method} ${path}`);
  return advertised;
}

/** Resolves the body schema the contract advertises under one status. */
function responseSchema(path: string, method: string, status: number): { type?: string } {
  const reference = operation(path, method).responses[String(status)]?.$ref;
  const name = reference?.replace("#/responses/", "");
  const schema = name === undefined ? undefined : contract.responses[name]?.schema;
  if (!schema) throw new Error(`contract.no_schema:${method} ${path} ${status}`);
  return schema;
}

/** Lists the success statuses the contract advertises for one operation. */
function successStatuses(path: string, method: string): number[] {
  const statuses = Object.keys(operation(path, method).responses)
    .map(Number)
    .filter((status) => status >= 200 && status < 300);
  if (!statuses.length) throw new Error(`contract.no_success_status:${method} ${path}`);
  return statuses;
}

/**
 * Lists the failure statuses the contract advertises for one operation.
 *
 * 401 and 403 are excluded because the raw transport maps them to `auth.required` before a handler
 * observes them, so they never reach the effect ledger.
 */
function failureStatuses(path: string, method: string): number[] {
  const statuses = Object.keys(operation(path, method).responses)
    .map(Number)
    .filter((status) => status >= 400 && status !== 401 && status !== 403);
  if (!statuses.length) throw new Error(`contract.no_failure_status:${method} ${path}`);
  return statuses;
}

/** Answers one request with a success status and no body at all. */
function emptyResponse(status: number): Response {
  return new Response(null, { status });
}
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
function approval(outcome: Awaited<ReturnType<typeof execute>>): string {
  return String(outcome.error?.details.approve).replace("--approve ", "");
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
async function approved(
  command: string,
  input: Record<string, unknown>,
  catalog: ReturnType<typeof createPullRequestCatalog>,
  set: CapabilitySet,
): Promise<Awaited<ReturnType<typeof execute>>> {
  const invocation = {
    command,
    input,
    requestId: `${command}-empty-body`,
    approval: undefined as string | undefined,
    dryRun: false,
    mode: "request" as const,
  };
  const planned = await execute(invocation, catalog, set);
  return execute({ ...invocation, approval: approval(planned) }, catalog, set);
}
function pullCapabilities(fetchAdapter: FetchAdapter): CapabilitySet {
  return capabilities({
    pullRequests: createPullRequestsGateway(fetchAdapter),
    issues: createIssuesGateway(fetchAdapter),
  });
}
function actionsCapabilities(
  fetchAdapter: FetchAdapter,
  timing: Partial<CapabilitySet> = {},
): CapabilitySet {
  const workflows: WorkflowGateway = {
    list: async () => [{ name: "ci.yml", path: ".forgejo/workflows/ci.yml", content: "name: CI" }],
    get: async () => ({ name: "ci.yml", path: ".forgejo/workflows/ci.yml", content: "name: CI" }),
  };
  return capabilities({ actions: createActionsGateway(fetchAdapter), workflows, ...timing });
}
/** A clock the injected sleep advances, so a watch runs its real budget without real waiting. */
function clockWithSleep(): {
  clock: { now: () => Date };
  sleep: (milliseconds: number) => Promise<void>;
  slept: number[];
} {
  let current = Date.parse("2025-01-01T00:00:00Z");
  const slept: number[] = [];
  return {
    clock: { now: () => new Date(current) },
    sleep: async (milliseconds) => {
      slept.push(milliseconds);
      current += milliseconds;
    },
    slept,
  };
}
async function mergeOutcome(
  fetchAdapter: FetchAdapter,
  extra: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof execute>>> {
  return approved(
    "pr merge",
    { host, repo: "octo/demo", index: 7, merge: true, ...extra },
    createPullRequestCatalog(),
    pullCapabilities(fetchAdapter),
  );
}
async function dispatchOutcome(
  fetchAdapter: FetchAdapter,
  extra: Record<string, unknown> = {},
  timing: Partial<CapabilitySet> = {},
): Promise<Awaited<ReturnType<typeof execute>>> {
  return approved(
    "workflow run",
    { host, repo: "octo/demo", workflow: "ci.yml", ref: "main", ...extra },
    createApiActionsCatalog(),
    actionsCapabilities(fetchAdapter, timing),
  );
}
async function readOutcome(
  command: string,
  input: Record<string, unknown>,
  catalog: ReturnType<typeof createPullRequestCatalog>,
  set: CapabilitySet,
): Promise<Awaited<ReturnType<typeof execute>>> {
  return execute(
    {
      command,
      input: { host, repo: "octo/demo", ...input },
      requestId: `${command}-read`,
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    set,
  );
}
async function apiOutcome(
  path: string,
  method: string,
  status: number,
): Promise<Awaited<ReturnType<typeof execute>>> {
  const endpoint = path
    .replace("{owner}", "octo")
    .replace("{repo}", "demo")
    .replace("{index}", "7");
  return approved(
    "api",
    { host, endpoint, method: method.toUpperCase() },
    createApiActionsCatalog(),
    capabilities({
      host: session({ [path]: { [method]: operation(path, method) } }),
      rawApi: createRawApiGateway(async () => emptyResponse(status)),
    }),
  );
}

test("merging a pull request succeeds under every advertised success status with an empty body", async () => {
  for (const status of successStatuses(mergePath, "post")) {
    const outcome = await mergeOutcome(async () => emptyResponse(status));
    expect(outcome.error).toBeNull();
    expect(outcome.result).toMatchObject({ scheduled: false });
    expect(outcome.effects).toEqual([
      {
        effect_id: "pull_request.merge",
        action: "pull_request.merge",
        target: "octo/demo#7",
        state: "succeeded",
        details: {},
      },
    ]);
  }
});

test("merging with branch deletion records both effects as succeeded", async () => {
  const outcome = await mergeOutcome(async () => emptyResponse(200), { delete_branch: true });
  expect(outcome.status).toBe("success");
  expect(outcome.effects.map((effect) => [effect.target, effect.action, effect.state])).toEqual([
    ["octo/demo#7", "pull_request.merge", "succeeded"],
    ["octo/demo#7", "branch.delete", "succeeded"],
  ]);
});

test("a merge answered with a body the contract does not advertise still reports success", async () => {
  const outcome = await mergeOutcome(async () => new Response("{oops", { status: 200 }));
  expect(outcome.error).toBeNull();
  expect(outcome.effects[0]?.state).toBe("succeeded");
});

test("a scheduled auto-merge is not reported as merged and deletes no branch", async () => {
  const outcome = await mergeOutcome(async () => emptyResponse(201), {
    when_checks_succeed: true,
    delete_branch: true,
  });
  expect(outcome.status).toBe("success");
  expect(outcome.result).toMatchObject({ scheduled: true });
  expect(outcome.effects).toEqual([
    {
      effect_id: "pull_request.merge",
      action: "pull_request.merge",
      target: "octo/demo#7",
      state: "unknown",
      details: { scheduled: true },
    },
  ]);
});

test("dispatching a workflow succeeds under every advertised success status with an empty body", async () => {
  for (const status of successStatuses(dispatchPath, "post")) {
    const outcome = await dispatchOutcome(async () => emptyResponse(status));
    expect(outcome.error).toBeNull();
    expect(outcome.result).toMatchObject({ run: null, watching: false, complete: false });
    expect(outcome.effects.map((effect) => [effect.action, effect.state])).toEqual([
      ["workflow.dispatch", "succeeded"],
    ]);
  }
});

test("a dispatch asks for run info and returns the created run", async () => {
  const bodies: unknown[] = [];
  const outcome = await dispatchOutcome(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 42, run_number: 9, jobs: ["build"] }, { status: 201 });
  });
  expect(bodies).toEqual([{ ref: "main", inputs: {}, return_run_info: true }]);
  // A dispatch reports only the repository index, and Forgejo keys the run page by that index.
  expect(outcome.result).toMatchObject({
    run: { id: 42, index_in_repo: 9, web_url: `${host}/octo/demo/actions/runs/9` },
    complete: false,
  });
});

test("the contract declares every dispatch input as a string", () => {
  // The encoding below is not a style choice: the Host rejects a dispatch whose inputs carry any
  // other JSON type, so this pins the reason the values are sent verbatim.
  const inputs = contract.definitions.DispatchWorkflowOption?.properties?.inputs;
  expect(inputs?.type).toBe("object");
  expect(inputs?.additionalProperties?.type).toBe("string");
});

test("a dispatch sends numeric- and boolean-looking field values as strings", async () => {
  const bodies: unknown[] = [];
  const outcome = await dispatchOutcome(
    async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return emptyResponse(204);
    },
    {
      field: [
        "count=3",
        "enabled=true",
        "disabled=false",
        "version=1.0",
        "empty=null",
        "environment=production",
        'matrix={"os":"linux"}',
      ],
    },
  );
  expect(outcome.error).toBeNull();
  expect(bodies).toEqual([
    {
      ref: "main",
      inputs: {
        count: "3",
        enabled: "true",
        disabled: "false",
        version: "1.0",
        empty: "null",
        environment: "production",
        matrix: '{"os":"linux"}',
      },
      return_run_info: true,
    },
  ]);
});

test("a field value containing = keeps everything after the first separator", async () => {
  const bodies: unknown[] = [];
  await dispatchOutcome(
    async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return emptyResponse(204);
    },
    { field: ["query=a=1&b=2"] },
  );
  expect(bodies).toEqual([{ ref: "main", inputs: { query: "a=1&b=2" }, return_run_info: true }]);
});

test("workflow run rejects raw_field, which no longer has a meaning of its own", async () => {
  const outcome = await dispatchOutcome(async () => emptyResponse(204), {
    raw_field: ["count=3"],
  });
  expect(outcome.error?.code).toBe("request.invalid");
});

test("a watch that fails after the dispatch keeps the queued run and its succeeded effect", async () => {
  let calls = 0;
  const timing = clockWithSleep();
  const outcome = await dispatchOutcome(
    async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ id: 42, run_number: 9 }, { status: 201 })
        : new Response("", { status: 500 });
    },
    { watch: true, interval: 1, timeout: 3 },
    { clock: timing.clock, sleep: timing.sleep },
  );
  // A Host that keeps refusing is not a blip, so the watch spends its whole budget retrying and
  // then reports the failure that was still live when the budget ran out.
  expect(calls).toBe(4);
  expect(timing.slept).toEqual([1000, 1000, 1000]);
  expect(outcome.result).toMatchObject({ run: { id: 42 }, watching: false });
  expect(outcome.effects.map((effect) => [effect.action, effect.state])).toEqual([
    ["workflow.dispatch", "succeeded"],
  ]);
  expect(outcome.error?.code).toBe("actions.request_failed");
});

test("a watch survives one failed poll and reports the run the next poll reads", async () => {
  let calls = 0;
  const timing = clockWithSleep();
  const outcome = await dispatchOutcome(
    async () => {
      calls += 1;
      if (calls === 1) return Response.json({ id: 42, run_number: 9 }, { status: 201 });
      if (calls === 2) return new Response("", { status: 500 });
      return Response.json({ id: 42, run_number: 9, status: "success" }, { status: 200 });
    },
    { watch: true, interval: 1, timeout: 60 },
    { clock: timing.clock, sleep: timing.sleep },
  );
  expect(outcome.error).toBeNull();
  expect(outcome.result).toMatchObject({ run: { id: 42 }, watching: true, complete: true });
  expect(timing.slept).toEqual([1000, 1000]);
});

test("an api write to a no-content endpoint succeeds without an output destination", async () => {
  for (const [path, method] of [
    [deletePath, "delete"],
    [mergePath, "post"],
  ] as const) {
    for (const status of successStatuses(path, method)) {
      const outcome = await apiOutcome(path, method, status);
      expect(outcome.error).toBeNull();
      expect(outcome.result).toMatchObject({ status, body: null });
      expect(outcome.effects.map((effect) => [effect.action, effect.state])).toEqual([
        ["api.request", "succeeded"],
      ]);
    }
  }
});

test("an api write answered with a failure status does not record a succeeded effect", async () => {
  for (const status of failureStatuses(deletePath, "delete")) {
    const outcome = await apiOutcome(deletePath, "delete", status);
    expect(outcome.result).toMatchObject({ status, body: null });
    expect(outcome.effects.map((effect) => [effect.action, effect.state])).toEqual([
      ["api.request", "failed"],
    ]);
  }
});

test("a malformed body still reports a decode failure under a success status", async () => {
  const viewed = await readOutcome(
    "pr view",
    { index: 7 },
    createPullRequestCatalog(),
    pullCapabilities(async () => new Response("{oops", { status: 200 })),
  );
  expect(viewed.error?.code).toBe("pull_request.invalid_response");
  const dispatched = await dispatchOutcome(async () => new Response("{oops", { status: 201 }));
  expect(dispatched.error?.code).toBe("actions.invalid_response");
});

test("a run's jobs decode the advertised bare array and reject an empty body", async () => {
  // Two decisions have to hold together here, and each hides the other's failure. The operation
  // answers a bare array, so reading it as an envelope yields no jobs, and an empty body must not
  // read as a run that has none.
  expect(responseSchema(jobsPath, "get", 200).type).toBe("array");
  const decoded = createActionsGateway(async () =>
    Response.json([{ id: 3, name: "test", status: "success", attempt: 1 }], { status: 200 }),
  );
  expect(await decoded.jobs(host, "synthetic-token", "octo", "demo", 42)).toEqual([
    { id: 3, name: "test", status: "success", attempt: 1 },
  ]);
  const bodiless = createActionsGateway(async () => emptyResponse(200));
  await expect(bodiless.jobs(host, "synthetic-token", "octo", "demo", 42)).rejects.toThrow(
    "actions.invalid_response",
  );
});

test("an empty body where the contract requires a collection is a decode failure, not an empty collection", async () => {
  const pulls = await readOutcome(
    "pr list",
    {},
    createPullRequestCatalog(),
    pullCapabilities(async () => emptyResponse(200)),
  );
  expect(pulls.error?.code).toBe("pull_request.invalid_response");
  const runs = await readOutcome(
    "run list",
    {},
    createApiActionsCatalog(),
    actionsCapabilities(async () => emptyResponse(200)),
  );
  expect(runs.error?.code).toBe("actions.invalid_response");
});

const secretPath = "/repos/{owner}/{repo}/actions/secrets/{secretname}";

/** Approves one `api` PUT and returns the Content-Type the Host received. */
async function apiWriteContentType(input: Record<string, unknown>): Promise<string | null> {
  let received: string | null = "unsent";
  const outcome = await approved(
    "api",
    { host, endpoint: "/repos/octo/demo/actions/secrets/PROBE", method: "PUT", ...input },
    createApiActionsCatalog(),
    capabilities({
      host: session({ [secretPath]: { put: operation(secretPath, "put") } }),
      rawApi: createRawApiGateway(async (_url, init) => {
        received = new Headers(init?.headers).get("content-type");
        return emptyResponse(201);
      }),
    }),
  );
  expect(outcome.error).toBeNull();
  return received;
}

test("api labels field and raw_field bodies as JSON on the approved write", async () => {
  expect(await apiWriteContentType({ field: ["data=x"] })).toBe("application/json");
  expect(await apiWriteContentType({ raw_field: ["data=x"] })).toBe("application/json");
});

test("api keeps a caller's own Content-Type in any letter case", async () => {
  expect(
    await apiWriteContentType({ field: ["data=x"], header: ["content-type:text/plain"] }),
  ).toBe("text/plain");
});

test("api labels an input body only when its bytes parse as JSON", async () => {
  expect(await apiWriteContentType({ input: '{"data":"x"}' })).toBe("application/json");
  expect(await apiWriteContentType({ input: new TextEncoder().encode('{"data":"x"}') })).toBe(
    "application/json",
  );
  expect(await apiWriteContentType({ input: "not json" })).toBeNull();
});
