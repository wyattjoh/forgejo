import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createOutputStore } from "../packages/forgejo/src/adapters";
import { run } from "../packages/forgejo-cli/src/cli";
import { createIssueCatalog } from "../packages/forgejo/src/issue-catalog";
import type { Issue, IssuesGateway } from "../packages/forgejo/src/issue-gateway";
import { createPullRequestCatalog } from "../packages/forgejo/src/pull-request-catalog";
import {
  createPullRequestsGateway,
  type CombinedStatus,
  type CommitStatus,
  type PullRequest,
  type PullRequestsGateway,
} from "../packages/forgejo/src/pull-request-gateway";
import {
  emptyHostConfig,
  HostSession,
  type HostConfig,
  type HostCredentialStore,
} from "../packages/forgejo/src/host-session";
import type { GitOperations, GitRemote } from "../packages/forgejo/src/git-operations";
import type { FetchAdapter } from "../packages/forgejo/src/infrastructure";
import { execute } from "../packages/forgejo/src/runtime";

const host = "https://forgejo.example";
const credentials: HostCredentialStore = {
  get: async () => "synthetic-token",
  put: async () => {},
  remove: async () => {},
};
const issue: Issue = {
  host,
  repository: "octo/demo",
  index: 7,
  title: "Fix it",
  body: "body",
  state: "open",
  author: "octo",
  assignees: [],
  labels: [],
  milestone: null,
  due_date: null,
  created_at: null,
  updated_at: null,
  web_url: `${host}/octo/demo/issues/7`,
};
const pull: PullRequest = {
  ...issue,
  base: "main",
  head: "feature",
  head_sha: "abc",
  merged: false,
  web_url: `${host}/octo/demo/pulls/7`,
};
function session(): HostSession {
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
      inspect: async () => {
        throw new Error("unexpected");
      },
    },
    [],
    () => new Date("2025-01-01"),
  );
}
function approval(outcome: Awaited<ReturnType<typeof execute>>): string {
  return String(outcome.error?.details.approve).replace("--approve ", "");
}
test("issue edits preserve the issue when the dedicated label effect fails", async () => {
  const issues: IssuesGateway = {
    list: async () => [issue],
    get: async () => issue,
    create: async () => issue,
    edit: async () => issue,
    remove: async () => {},
    pin: async () => {},
    replaceLabels: async () => {
      throw new Error("issue.label_not_found");
    },
    comments: async () => [],
    comment: async () => ({
      id: 1,
      body: "ok",
      author: "octo",
      created_at: null,
      updated_at: null,
      web_url: null,
    }),
  };
  const capabilities = capabilitiesFor(issues, pullGateway());
  const invocation = {
    command: "issue edit",
    input: { host, repo: "octo/demo", index: 7, label: ["missing"] },
    requestId: "issue-edit",
    approval: undefined,
    dryRun: false,
    mode: "request" as const,
  };
  const planned = await execute(invocation, createIssueCatalog(), capabilities);
  const outcome = await execute(
    { ...invocation, approval: approval(planned) },
    createIssueCatalog(),
    capabilities,
  );
  expect(outcome.error?.code).toBe("issue.label_not_found");
  expect(outcome.result).toMatchObject({ index: 7, title: "Fix it" });
  expect(outcome.effects.map((effect) => effect.state)).toEqual(["succeeded", "failed"]);
});
test("pull-request creation records ordered partial reviewer effects", async () => {
  const requested: string[][] = [];
  const gateway = pullGateway({
    reviewers: async (_host, _token, _owner, _repo, _index, reviewers) => {
      requested.push(reviewers);
      throw new Error("pull_request.request_failed");
    },
  });
  const capabilities = capabilitiesFor(issueGateway(), gateway);
  const invocation = {
    command: "pr create",
    input: { host, repo: "octo/demo", title: "PR", base: "main", reviewer: ["alice", "bob"] },
    requestId: "pr-create",
    approval: undefined,
    dryRun: false,
    mode: "request" as const,
  };
  const planned = await execute(invocation, createPullRequestCatalog(), capabilities);
  const outcome = await execute(
    { ...invocation, approval: approval(planned) },
    createPullRequestCatalog(),
    capabilities,
  );
  expect(requested).toEqual([["alice", "bob"]]);
  expect(outcome.error?.code).toBe("pull_request.request_failed");
  expect(outcome.effects.map((effect) => effect.state)).toEqual(["succeeded", "failed"]);
});
test("a failing pull-request read reports its namespaced code, not a generic failure", async () => {
  const gateway = pullGateway({
    get: async () => {
      throw new Error("pull_request.not_found");
    },
  });
  const outcome = await execute(
    {
      command: "pr view",
      input: { host, repo: "octo/demo", index: 7 },
      requestId: "pr-view",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    capabilitiesFor(issueGateway(), gateway),
  );
  expect(outcome.error?.code).toBe("pull_request.not_found");
});
test("Human decoding keeps review approval distinct from a mutation approval grant", async () => {
  let stdout = "";
  const exit = await run(
    ["pr", "review", "7", "--approve", "--dry-run"],
    "",
    (text) => void (stdout += text),
    () => {},
    {
      capabilities: capabilitiesFor(issueGateway(), pullGateway()),
      catalog: createPullRequestCatalog(),
      human: undefined,
    },
  );
  expect(exit).toBe(0);
  expect(stdout).toBe("{}\n");
});
test("pull-request diff delivers bytes in Request mode and checks make polling explicit", async () => {
  const capabilities = capabilitiesFor(issueGateway(), pullGateway());
  const diff = await execute(
    {
      command: "pr diff",
      input: { host, repo: "octo/demo", index: 7 },
      requestId: "diff",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    capabilities,
  );
  expect(diff.result).toMatchObject({ path: "/tmp/diff", bytes: 4, media_type: "text/plain" });
  const checks = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7, watch: true, interval: 1, timeout: 1 },
      requestId: "checks",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    capabilities,
  );
  expect(checks.result).toMatchObject({ watching: true, complete: true, attempts: 1 });
});
test("commit statuses are normalized from the contract's status field", async () => {
  const definitions = (await contract()).definitions;
  const properties = Object.keys(definitions.CommitStatus!.properties!);
  expect(properties).toContain("status");
  expect(properties).not.toContain("state");
  const gateway = createPullRequestsGateway(async () =>
    jsonResponse({
      sha: "abc",
      state: "pending",
      total_count: 1,
      statuses: [
        {
          context: "build",
          status: "pending",
          target_url: "https://forgejo.example/run/1",
          description: "running",
        },
      ],
    }),
  );
  expect(await gateway.statuses(host, "synthetic-token", "octo", "demo", "abc")).toEqual({
    state: "pending",
    total_count: 1,
    statuses: [
      {
        context: "build",
        state: "pending",
        target_url: "https://forgejo.example/run/1",
        description: "running",
      },
    ],
  });
});
test("commit statuses come from the deduped combined endpoint, not the accumulating history", async () => {
  const source = await contract();
  expect(source.paths["/repos/{owner}/{repo}/commits/{ref}/status"]?.get?.operationId).toBe(
    "repoGetCombinedStatusByRef",
  );
  const properties = source.definitions.CombinedStatus!.properties!;
  expect(Object.keys(properties)).toContain("statuses");
  expect(properties.state).toEqual({ $ref: "#/definitions/CommitStatusState" });
  const permitted = String(source.definitions.CommitStatusState!.description);
  for (const value of ["pending", "success", "error", "failure", "warning", "skipped"])
    expect(permitted).toContain(`"${value}"`);
  const requested: string[] = [];
  const gateway = createPullRequestsGateway(hostFetch(requested));
  expect(await gateway.statuses(host, "synthetic-token", "octo", "demo", "abc")).toEqual({
    state: "success",
    total_count: 1,
    statuses: [{ context: "build", state: "success", target_url: null, description: "Success" }],
  });
  expect(requested).toEqual([`${host}/api/v1/repos/octo/demo/commits/abc/status?limit=100`]);
});
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

test("an oversized diff reports its size, and a failed fetch still reports a transport failure", async () => {
  // A diff is read into memory to be delivered, so a huge one is refused rather than truncated: a
  // half a patch applies cleanly and silently drops changes, which is worse than no patch at all.
  const oversized = createPullRequestsGateway(
    async () =>
      new Response("diff --git", { headers: { "content-length": String(64 * 1024 * 1024) } }),
  );
  const thrown = await rejection(
    oversized.diff(host, "synthetic-token", "octo", "demo", 7, false, false),
  );
  expect(thrown.code).toBe("pull_request.response_too_large");
  expect(thrown.details).toMatchObject({
    limit_bytes: 16 * 1024 * 1024,
    response_bytes: 64 * 1024 * 1024,
  });
  const unreachable = createPullRequestsGateway(async () => {
    throw new TypeError("fetch failed");
  });
  await expect(
    unreachable.diff(host, "synthetic-token", "octo", "demo", 7, false, false),
  ).rejects.toThrow("pull_request.network");
});

test("a head with no status row normalizes the Host's empty combined status", async () => {
  // What a Host with no checks configured actually sends: routers/api/v1/repo/status.go answers
  // an empty CombinedStatus, and modules/structs/status.go tags State without omitempty, so the
  // absent rollup arrives as "" rather than as a missing key.
  const gateway = createPullRequestsGateway(async () =>
    jsonResponse({
      state: "",
      sha: "",
      total_count: 0,
      statuses: null,
      repository: null,
      commit_url: "",
      url: "",
    }),
  );
  expect(await gateway.statuses(host, "synthetic-token", "octo", "demo", "abc")).toEqual({
    state: null,
    total_count: 0,
    statuses: [],
  });
});
test("the reported check count comes from the rollup the Host returned", async () => {
  const gateway = pullGateway({
    statuses: async () => ({
      state: "success",
      total_count: 2,
      statuses: [status("success", "build"), status("success", "test")],
    }),
  });
  const outcome = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7 },
      requestId: "checks-total",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    capabilitiesFor(issueGateway(), gateway),
  );
  expect(outcome.result).toMatchObject({ complete: true, passing: true, total_count: 2 });
});
test("an accumulated pending history settles on the first poll against a real gateway", async () => {
  const requested: string[] = [];
  const timing = clockWithSleep();
  const outcome = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7, watch: true },
      requestId: "checks-history",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    {
      ...capabilitiesFor(issueGateway(), createPullRequestsGateway(hostFetch(requested))),
      clock: timing.clock,
      sleep: timing.sleep,
    },
  );
  expect(outcome.result).toMatchObject({
    watching: true,
    complete: true,
    state: "success",
    passing: true,
    attempts: 1,
  });
  expect(statesOf(outcome.result)).toEqual(["success"]);
  expect(timing.slept).toEqual([]);
  expect(requested.filter((url) => url.includes("/statuses/"))).toEqual([]);
});
test("the rollup verdict answers passing while complete answers settled", async () => {
  // Passing mirrors the Host's own merge gate, IsPullCommitStatusPass, which answers with
  // state.IsSuccess(). "skipped" settles green in the UI but does not pass that gate, so a
  // path-filtered workflow that skips every job must not report passing here either.
  const verdicts = [
    ["success", true],
    ["warning", false],
    ["skipped", false],
    ["failure", false],
    ["error", false],
  ] as const;
  for (const [state, passing] of verdicts) {
    const outcome = await execute(
      {
        command: "pr checks",
        input: { host, repo: "octo/demo", index: 7 },
        requestId: `checks-rollup-${state}`,
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      createPullRequestCatalog(),
      capabilitiesFor(issueGateway(), pullGateway({ statuses: async () => combined(state) })),
    );
    expect(outcome.result).toMatchObject({ complete: true, state, passing });
  }
});
test("an all-failed run settles complete but not passing", async () => {
  const timing = clockWithSleep();
  const outcome = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7, watch: true },
      requestId: "checks-all-failed",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    {
      ...capabilitiesFor(
        issueGateway(),
        pullGateway({
          statuses: async () => ({
            state: "failure",
            total_count: 2,
            statuses: [status("failure", "build"), status("failure", "test")],
          }),
        }),
      ),
      clock: timing.clock,
      sleep: timing.sleep,
    },
  );
  expect(outcome.result).toMatchObject({
    watching: true,
    complete: true,
    state: "failure",
    passing: false,
    attempts: 1,
  });
  expect(statesOf(outcome.result)).toEqual(["failure", "failure"]);
  expect(timing.slept).toEqual([]);
});
test("a failing rollup does not settle while another check is still pending", async () => {
  const timing = clockWithSleep();
  const outcome = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7, watch: true, interval: 30, timeout: 60 },
      requestId: "checks-mixed",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    {
      ...capabilitiesFor(
        issueGateway(),
        pullGateway({
          statuses: async () => ({
            state: "failure",
            total_count: 2,
            statuses: [status("failure", "build"), status("pending", "test")],
          }),
        }),
      ),
      clock: timing.clock,
      sleep: timing.sleep,
    },
  );
  expect(outcome.result).toMatchObject({
    watching: true,
    complete: false,
    state: "failure",
    passing: false,
    attempts: 3,
  });
  expect(timing.slept).toEqual([30000, 30000]);
});
test("an empty status list never counts as settled", async () => {
  const empty = pullGateway({
    statuses: async () => ({ state: null, total_count: 0, statuses: [] }),
  });
  const reported = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7 },
      requestId: "checks-empty",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    capabilitiesFor(issueGateway(), empty),
  );
  expect(reported.result).toMatchObject({
    watching: false,
    complete: false,
    passing: false,
    total_count: 0,
    attempts: 1,
  });
  expect(statesOf(reported.result)).toEqual([]);
  const timing = clockWithSleep();
  const watched = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7, watch: true, interval: 30, timeout: 120 },
      requestId: "checks-empty-watch",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    { ...capabilitiesFor(issueGateway(), empty), clock: timing.clock, sleep: timing.sleep },
  );
  expect(watched.result).toMatchObject({ watching: true, complete: false, attempts: 5 });
  expect(timing.slept).toEqual([30000, 30000, 30000, 30000]);
});
test("watching sleeps no longer than the timeout it was given", async () => {
  const timing = clockWithSleep();
  const outcome = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7, watch: true, interval: 30, timeout: 100 },
      requestId: "checks-clamped",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    {
      ...capabilitiesFor(
        issueGateway(),
        pullGateway({ statuses: async () => combined("pending") }),
      ),
      clock: timing.clock,
      sleep: timing.sleep,
    },
  );
  expect(outcome.result).toMatchObject({ watching: true, complete: false, attempts: 5 });
  expect(timing.slept).toEqual([30000, 30000, 30000, 10000]);
  expect(timing.slept.reduce((total, item) => total + item, 0)).toBe(100000);
});
test("a pending check reports as not complete with its real per-status state", async () => {
  const outcome = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7 },
      requestId: "checks-pending",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    capabilitiesFor(issueGateway(), pullGateway({ statuses: async () => combined("pending") })),
  );
  expect(outcome.result).toMatchObject({ watching: false, complete: false, attempts: 1 });
  expect(statesOf(outcome.result)).toEqual(["pending"]);
});
test("watching polls at the supplied interval until the checks settle", async () => {
  const observed = ["pending", "pending", "success"];
  let poll = 0;
  const timing = clockWithSleep();
  const outcome = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7, watch: true, interval: 5, timeout: 300 },
      requestId: "checks-watch",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    {
      ...capabilitiesFor(
        issueGateway(),
        pullGateway({
          statuses: async () => combined(observed[Math.min(poll++, observed.length - 1)]!),
        }),
      ),
      clock: timing.clock,
      sleep: timing.sleep,
    },
  );
  expect(outcome.result).toMatchObject({ watching: true, complete: true, attempts: 3 });
  expect(statesOf(outcome.result)).toEqual(["success"]);
  expect(timing.slept).toEqual([5000, 5000]);
});
test("watching returns rather than erroring when the timeout elapses with checks unfinished", async () => {
  const timing = clockWithSleep();
  const outcome = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7, watch: true, interval: 30, timeout: 120 },
      requestId: "checks-timeout",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    {
      ...capabilitiesFor(
        issueGateway(),
        pullGateway({ statuses: async () => combined("pending") }),
      ),
      clock: timing.clock,
      sleep: timing.sleep,
    },
  );
  expect(outcome.status).toBe("success");
  expect(outcome.error).toBeNull();
  expect(outcome.result).toMatchObject({ watching: true, complete: false, attempts: 5 });
  expect(timing.slept).toEqual([30000, 30000, 30000, 30000]);
});
test("watching survives one failed status read and settles on the next", async () => {
  // The watch loop is shared with `run watch`, so a blip against the Host costs one interval
  // here too rather than discarding the whole wait the caller asked for.
  const observed = ["pending", "throw", "success"];
  let poll = 0;
  const timing = clockWithSleep();
  const outcome = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7, watch: true, interval: 5, timeout: 300 },
      requestId: "checks-transient",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    {
      ...capabilitiesFor(
        issueGateway(),
        pullGateway({
          statuses: async () => {
            const next = observed[Math.min(poll++, observed.length - 1)]!;
            if (next === "throw") throw new Error("pull_request.request_failed");
            return combined(next);
          },
        }),
      ),
      clock: timing.clock,
      sleep: timing.sleep,
    },
  );
  expect(outcome.error).toBeNull();
  expect(outcome.result).toMatchObject({ watching: true, complete: true, attempts: 3 });
  expect(timing.slept).toEqual([5000, 5000]);
});
test("a status read that keeps failing surfaces its error once the budget runs out", async () => {
  let poll = 0;
  const timing = clockWithSleep();
  const outcome = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7, watch: true, interval: 30, timeout: 60 },
      requestId: "checks-persistent",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    {
      ...capabilitiesFor(
        issueGateway(),
        pullGateway({
          statuses: async () => {
            if (poll++ === 0) return combined("pending");
            throw new Error("pull_request.request_failed");
          },
        }),
      ),
      clock: timing.clock,
      sleep: timing.sleep,
    },
  );
  // A failure still live when the budget expires is not transient, so it is reported rather than
  // dressed up as a watch that merely ran out of time.
  expect(outcome.status).toBe("error");
  expect(outcome.error?.code).toBe("pull_request.request_failed");
  expect(timing.slept).toEqual([30000, 30000]);
});
test("a first status read that fails is reported at once rather than waited out", async () => {
  // Retrying the very first poll would spend the whole budget re-asking a question the Host has
  // already answered, and a rejected token or an absent pull request never becomes transient.
  // Watching must not make a refusal slower to surface than not watching does.
  const timing = clockWithSleep();
  const outcome = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7, watch: true, interval: 30, timeout: 300 },
      requestId: "checks-first-poll",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    {
      ...capabilitiesFor(
        issueGateway(),
        pullGateway({
          statuses: async () => {
            throw new Error("auth.required");
          },
        }),
      ),
      clock: timing.clock,
      sleep: timing.sleep,
    },
  );
  expect(outcome.error?.code).toBe("auth.required");
  expect(timing.slept).toEqual([]);
});
test("the default watch timeout outlasts a real check run", async () => {
  const timing = clockWithSleep();
  const outcome = await execute(
    {
      command: "pr checks",
      input: { host, repo: "octo/demo", index: 7, watch: true },
      requestId: "checks-default",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createPullRequestCatalog(),
    {
      ...capabilitiesFor(
        issueGateway(),
        pullGateway({ statuses: async () => combined("pending") }),
      ),
      clock: timing.clock,
      sleep: timing.sleep,
    },
  );
  expect(outcome.result).toMatchObject({ watching: true, complete: false });
  expect(timing.slept.reduce((total, item) => total + item, 0)).toBe(300000);
  expect(new Set(timing.slept)).toEqual(new Set([5000]));
});
function status(state: string, context = "build"): CommitStatus {
  return { context, state, target_url: null, description: null };
}
function combined(state: string): CombinedStatus {
  return { state, total_count: 1, statuses: [status(state)] };
}
async function contract(): Promise<{
  paths: Record<string, Record<string, { operationId?: string } | undefined> | undefined>;
  definitions: Record<
    string,
    { description?: string; properties?: Record<string, unknown> } | undefined
  >;
}> {
  return JSON.parse(await readFile(new URL("../swagger.v1.json", import.meta.url), "utf8"));
}
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
/**
 * Serves what a real Host serves: a status history that accumulates one row per update, and the
 * combined endpoint that dedupes it to the latest row per context. Taken from Forgejo's own
 * TestCreateCommitStatus_AvoidsDuplicates, where one job persists three rows for one context.
 */
function hostFetch(requested: string[]): FetchAdapter {
  const history = [
    { context: "build", status: "pending", target_url: null, description: "Blocked" },
    { context: "build", status: "pending", target_url: null, description: "Waiting" },
    { context: "build", status: "success", target_url: null, description: "Success" },
  ];
  return async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/pulls/"))
      return jsonResponse({
        number: 7,
        title: "Fix it",
        state: "open",
        base: { ref: "main" },
        head: { ref: "feature", sha: "abc" },
      });
    if (url.includes("/commits/"))
      return jsonResponse({ sha: "abc", state: "success", total_count: 1, statuses: [history[2]] });
    return jsonResponse(history);
  };
}
function statesOf(result: Record<string, unknown> | null): Array<string | null> {
  return ((result?.statuses ?? []) as CommitStatus[]).map((item) => item.state);
}
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
test("single-effect issue and pull-request mutations report a populated ledger", async () => {
  const capabilities = capabilitiesFor(issueGateway(), pullGateway());
  const cases = [
    { command: "issue close", input: { index: 7 }, action: "issue.closed" },
    { command: "issue reopen", input: { index: 7 }, action: "issue.open" },
    { command: "issue comment", input: { index: 7, body: "ok" }, action: "issue.comment.create" },
    { command: "issue delete", input: { index: 7 }, action: "issue.delete" },
    { command: "issue pin", input: { index: 7 }, action: "issue.pin" },
    { command: "issue unpin", input: { index: 7 }, action: "issue.unpin" },
    {
      command: "pr comment",
      input: { index: 7, body: "ok" },
      action: "pull_request.comment.create",
    },
    { command: "pr review", input: { index: 7, approve: true }, action: "pull_request.review" },
    { command: "pr merge", input: { index: 7, merge: true }, action: "pull_request.merge" },
  ];
  for (const entry of cases) {
    const catalog = entry.command.startsWith("issue ")
      ? createIssueCatalog()
      : createPullRequestCatalog();
    const invocation = {
      command: entry.command,
      input: { host, repo: "octo/demo", ...entry.input },
      requestId: entry.command.replace(" ", "-"),
      approval: undefined as string | undefined,
      dryRun: false,
      mode: "request" as const,
    };
    const planned = await execute(invocation, catalog, capabilities);
    const outcome = await execute(
      { ...invocation, approval: approval(planned) },
      catalog,
      capabilities,
    );
    expect(outcome.error).toBeNull();
    expect(outcome.effects).toEqual([
      {
        effect_id: entry.action,
        action: entry.action,
        target: "octo/demo#7",
        state: "succeeded",
        details: {},
      },
    ]);
  }
});
/**
 * Pins which remote `pr checkout` uses, because remote inference runs in exactly one
 * configuration: Human mode, inside a working directory whose remote matches a configured Host
 * profile, with no explicit repository. Every other configuration, Request mode included, has to
 * reach the same Git work through an explicit remote or the leaf cannot succeed where it is
 * advertised.
 */
const checkoutRemotes: GitRemote[] = [
  { name: "origin", url: "git@forgejo.example:octo/demo.git" },
  // `mirror` is on another deployment, so inference never chooses it and every checkout below
  // that reaches it did so because the request named it.
  { name: "mirror", url: "git@mirror.invalid:octo/demo.git" },
];
test("pr checkout infers a remote only in Human mode without an explicit repository", async () => {
  const checkouts: CheckoutCall[] = [];
  // A different index from every other case here, so the documented `pr-<index>` default is
  // pinned as a template rather than as one literal branch name.
  const inferred = await checkoutPull({ index: 42 }, "human", checkouts);
  expect(inferred.error).toBeNull();
  expect(inferred.result).toEqual({ branch: "pr-42" });
  expect(inferred.effects).toEqual([
    expect.objectContaining({
      action: "checkout_pull_request",
      state: "succeeded",
      details: { remote: "origin" },
    }),
  ]);
  expect(checkouts).toEqual([
    { cwd: "/work", remote: "origin", index: 42, branch: "pr-42", force: false },
  ]);
});
test("pr checkout reaches the same Git work through an explicit remote", async () => {
  const checkouts: CheckoutCall[] = [];
  const routed = await checkoutPull(
    { host, repo: "octo/demo", index: 7, remote: "mirror", branch: "review", force: true },
    "request",
    checkouts,
  );
  expect(routed.error).toBeNull();
  expect(routed.result).toEqual({ branch: "review" });
  expect(routed.effects).toEqual([
    expect.objectContaining({
      action: "checkout_pull_request",
      state: "succeeded",
      details: { remote: "mirror" },
    }),
  ]);
  // Human mode can infer here and still must not, because the caller named a remote of its own.
  const preferred = await checkoutPull({ index: 7, remote: "mirror" }, "human", checkouts);
  expect(preferred.error).toBeNull();
  expect(checkouts).toEqual([
    { cwd: "/work", remote: "mirror", index: 7, branch: "review", force: true },
    { cwd: "/work", remote: "mirror", index: 7, branch: "pr-7", force: false },
  ]);
});
test("pr checkout without a remote reports a recovery in the language of its own mode", async () => {
  const checkouts: CheckoutCall[] = [];
  const request = await checkoutPull({ host, repo: "octo/demo", index: 7 }, "request", checkouts);
  expect(request.error?.code).toBe("git.remote_required");
  expect(request.error?.details).toEqual({ recovery: "input.remote" });
  const human = await checkoutPull({ host, repo: "octo/demo", index: 7 }, "human", checkouts);
  expect(human.error?.code).toBe("git.remote_required");
  expect(human.error?.details).toEqual({ recovery: "--remote NAME" });
  expect(human.effects).toEqual([
    expect.objectContaining({ action: "checkout_pull_request", state: "failed" }),
  ]);
  expect(checkouts).toEqual([]);
});
test("pr checkout in Request mode never falls back to the working directory", async () => {
  const checkouts: CheckoutCall[] = [];
  const outcome = await checkoutPull({ host, index: 7, remote: "origin" }, "request", checkouts);
  expect(outcome.error?.code).toBe("repo.required");
  expect(checkouts).toEqual([]);
});
/**
 * The remote is the first positional argument of `git fetch`, which is assembled without a `--`
 * separator, so the input schema is the only thing between a Request and an option Git would
 * honour. A leading dash and an empty name both have to fail before the leaf runs.
 */
test("pr checkout rejects a remote Git would read as an option", async () => {
  const checkouts: CheckoutCall[] = [];
  for (const remote of ["-x", "--upload-pack=touch", "", "origin two"]) {
    const outcome = await execute(
      {
        command: "pr checkout",
        input: { host, repo: "octo/demo", index: 7, remote },
        requestId: "pr-checkout-remote",
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      createPullRequestCatalog(),
      {
        ...capabilitiesFor(issueGateway(), pullGateway()),
        git: checkoutGit(checkouts),
        cwd: "/work",
      },
    );
    expect(outcome.error?.code).toBe("request.invalid");
  }
  expect(checkouts).toEqual([]);
});
test("a failed checkout names the remote it fetched from", async () => {
  const checkouts: CheckoutCall[] = [];
  const outcome = await checkoutPull(
    { host, repo: "octo/demo", index: 7, remote: "mirror" },
    "request",
    checkouts,
    false,
  );
  expect(outcome.error?.code).toBe("git.checkout_failed");
  expect(outcome.effects).toEqual([
    expect.objectContaining({
      action: "checkout_pull_request",
      state: "failed",
      details: { remote: "mirror" },
    }),
  ]);
});
type CheckoutCall = { cwd: string; remote: string; index: number; branch: string; force: boolean };
async function checkoutPull(
  input: Record<string, unknown>,
  mode: "human" | "request",
  checkouts: CheckoutCall[],
  succeeds = true,
): Promise<Awaited<ReturnType<typeof execute>>> {
  const capabilities = {
    ...capabilitiesFor(issueGateway(), pullGateway()),
    git: checkoutGit(checkouts, succeeds),
    cwd: "/work",
  };
  const catalog = createPullRequestCatalog();
  const invocation = {
    command: "pr checkout",
    input,
    requestId: "pr-checkout",
    approval: undefined as string | undefined,
    dryRun: false,
    mode,
  };
  const planned = await execute(invocation, catalog, capabilities);
  return execute({ ...invocation, approval: approval(planned) }, catalog, capabilities);
}
function checkoutGit(checkouts: CheckoutCall[], succeeds = true): GitOperations {
  return {
    remotes: async () => ({ remotes: checkoutRemotes, diagnostics: [] }),
    remoteNames: async () => ({
      names: checkoutRemotes.map((remote) => remote.name),
      diagnostics: [],
    }),
    destination: async () => "missing",
    clone: async () => ({ ok: true, diagnostics: [] }),
    addRemote: async () => ({ ok: true, diagnostics: [] }),
    push: async () => ({ ok: true, diagnostics: [] }),
    checkoutPull: async (cwd, remote, index, branch, force) => {
      checkouts.push({ cwd, remote, index, branch, force });
      return { ok: succeeds, diagnostics: [] };
    },
  };
}
function capabilitiesFor(issues: IssuesGateway, pullRequests: PullRequestsGateway) {
  const delivered = new Map<string, Uint8Array>();
  return {
    gateway: { smoke: async ({ value }: { value: string }) => ({ echoed: value }) },
    host: session(),
    repositories: undefined,
    issues,
    pullRequests,
    git: undefined,
    output: createOutputStore({
      makeDirectory: async () => {},
      write: async (path, bytes) => void delivered.set(path, bytes),
      writeStream: async (path, body) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body) chunks.push(chunk);
        delivered.set(path, new Uint8Array(Buffer.concat(chunks)));
      },
      temporaryFile: async () => "/tmp/diff",
    }),
    environment: {},
    cwd: "/tmp",
    keychainNoUi: true,
    clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    cancelled: () => false,
  };
}
function issueGateway(): IssuesGateway {
  return {
    list: async () => [issue],
    get: async () => issue,
    create: async () => issue,
    edit: async () => issue,
    remove: async () => {},
    pin: async () => {},
    replaceLabels: async () => {},
    comments: async () => [],
    comment: async () => ({
      id: 1,
      body: "ok",
      author: "octo",
      created_at: null,
      updated_at: null,
      web_url: null,
    }),
  };
}
function pullGateway(overrides: Partial<PullRequestsGateway> = {}): PullRequestsGateway {
  return {
    list: async () => [pull],
    get: async () => pull,
    create: async () => pull,
    edit: async () => pull,
    reviewers: async () => {},
    comments: async () => [],
    comment: async () => ({
      id: 1,
      body: "ok",
      author: "octo",
      created_at: null,
      updated_at: null,
      web_url: null,
    }),
    diff: async () => new TextEncoder().encode("diff"),
    review: async () => {},
    merge: async () => ({ scheduled: false }),
    statuses: async () => combined("success"),
    ...overrides,
  };
}
