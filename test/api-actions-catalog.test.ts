import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApiActionsCatalog,
  pendingRunStatuses,
  settledRunStatuses,
} from "../packages/forgejo/src/api-actions-catalog";
import type {
  ActionArtifact,
  ActionJob,
  ActionRun,
  ActionRunFilter,
  ActionsGateway,
} from "../packages/forgejo/src/actions-gateway";
import { createOutputStore, type OutputStore } from "../packages/forgejo/src/adapters";
import {
  emptyHostConfig,
  HostSession,
  type HostConfig,
  type HostCredentialStore,
} from "../packages/forgejo/src/host-session";
import { run as cli } from "../packages/forgejo-cli/src/cli";
import type { HumanInterface } from "../packages/forgejo-cli/src/human-interface";
import type { RawApiGateway } from "../packages/forgejo/src/raw-api-gateway";
import { execute, type CapabilitySet, type CommandOutcome } from "../packages/forgejo/src/runtime";
import type { WorkflowGateway } from "../packages/forgejo/src/workflow-gateway";

const host = "https://forgejo.example";
const credentials: HostCredentialStore = {
  get: async () => "synthetic-token",
  put: async () => {},
  remove: async () => {},
};
const run: ActionRun = {
  id: 42,
  index_in_repo: 9,
  workflow_id: "ci.yml",
  title: "CI",
  event: "push",
  status: "success",
  commit_sha: "abc",
  prettyref: "main",
  created: "2025-01-01T00:00:00Z",
  updated: "2025-01-01T00:01:00Z",
  web_url: `${host}/octo/demo/actions/runs/9`,
};
const stubSwagger = JSON.stringify({
  paths: {
    "/version": { get: { responses: { "200": {} } } },
    "/archive": { get: { responses: { "200": {} } } },
    "/repos/octo/demo": { delete: { responses: { "200": {} } } },
  },
});
const advertisedContract = await Bun.file(new URL("../swagger.v1.json", import.meta.url)).text();
function session(swagger: string = stubSwagger): HostSession {
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
        swagger,
      }),
    },
    [],
    () => new Date("2025-01-01"),
  );
}
function actions(overrides: Partial<ActionsGateway> = {}): ActionsGateway {
  return {
    list: async () => [run],
    get: async () => run,
    jobs: async () => [{ id: 3, name: "test", status: "success", attempt: 1 }],
    cancel: async () => {},
    remove: async () => {},
    logs: async () => bodyStream(new TextEncoder().encode("zip")),
    jobLogs: async () => bodyStream(new TextEncoder().encode("log")),
    artifacts: async () => [{ id: 5, name: "coverage", size_in_bytes: 3 }],
    downloadArtifact: async () => bodyStream(new Uint8Array([1, 2, 3])),
    dispatch: async () => run,
    rerunCapability: async () => ({ name: "actions-rerun", version: 1, routes: ["run", "job"] }),
    rerun: async () => ({ run, jobs: [] }),
    ...overrides,
  };
}
/** Answers a gateway's bulk read with the same streamed body the real transport hands back. */
function bodyStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
/** Collects a streamed body, for a fake placement that has to keep what it was handed. */
async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}
/** An Output store over an in-memory placement, for commands whose file is not under test. */
function memoryOutput(): OutputStore {
  const files = new Map<string, Uint8Array>();
  return createOutputStore({
    makeDirectory: async () => {},
    write: async (path, bytes) => void files.set(path, bytes),
    writeStream: async (path, body) => void files.set(path, await collect(body)),
    temporaryFile: async () => "/tmp/output",
  });
}
const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** An Output store over the real filesystem, rooted in a fresh temporary directory. */
async function diskOutput(): Promise<{ store: OutputStore; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), "forgejo-download-"));
  temporaryRoots.push(root);
  return {
    // Deliberately not created here, so a download has to place its own directory.
    directory: join(root, "artifacts"),
    store: createOutputStore({
      makeDirectory: async (path) => void (await mkdir(path, { recursive: true })),
      write: (path, bytes) => writeFile(path, bytes, { mode: 0o600 }),
      writeStream: async (path, body) => {
        const handle = await open(path, "w", 0o600);
        try {
          for await (const chunk of body) await handle.write(chunk);
        } finally {
          await handle.close();
        }
      },
      temporaryFile: async () => join(root, "output"),
    }),
  };
}
function capabilities(
  rawApi: RawApiGateway,
  actionGateway = actions(),
  workflows: WorkflowGateway = {
    list: async () => [{ name: "ci.yml", path: ".forgejo/workflows/ci.yml", content: "name: CI" }],
    get: async () => ({ name: "ci.yml", path: ".forgejo/workflows/ci.yml", content: "name: CI" }),
  },
  hostSession: HostSession = session(),
  output: OutputStore = memoryOutput(),
): CapabilitySet {
  return {
    gateway: { smoke: async ({ value }: { value: string }) => ({ echoed: value }) },
    host: hostSession,
    repositories: undefined,
    git: undefined,
    actions: actionGateway,
    rawApi,
    workflows,
    output,
    environment: {},
    cwd: "/repo",
    keychainNoUi: true,
    clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    cancelled: () => false,
  };
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
function raw(
  body = new TextEncoder().encode('{"ok":true}'),
  media_type = "application/json",
): RawApiGateway {
  return {
    call: async () => ({ status: 200, headers: { "content-type": media_type }, body, media_type }),
  };
}
function recordingRaw(requested: string[]): RawApiGateway {
  return {
    call: async (_host, _token, path) => {
      requested.push(path);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode('{"ok":true}'),
        media_type: "application/json",
      };
    },
  };
}
function contractSession(): HostSession {
  return session(advertisedContract);
}
function approval(outcome: Awaited<ReturnType<typeof execute>>): string {
  return String(outcome.error?.details.approve).replace("--approve ", "");
}

test("raw API returns JSON bodies, delivers binary only to explicit output, and plans writes", async () => {
  const catalog = createApiActionsCatalog();
  const json = await execute(
    {
      command: "api",
      input: { host, endpoint: "/version" },
      requestId: "api-read",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    capabilities(raw()),
  );
  expect(json.result).toMatchObject({ status: 200, body: { ok: true } });
  const binary = await execute(
    {
      command: "api",
      input: { host, endpoint: "/archive", output: "/tmp/archive" },
      requestId: "api-bin",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    capabilities(raw(new Uint8Array([1]), "application/zip")),
  );
  expect(binary.result).toMatchObject({ body: { path: "/tmp/archive", bytes: 1 } });
  const planned = await execute(
    {
      command: "api",
      input: { host, endpoint: "/repos/octo/demo", method: "DELETE" },
      requestId: "api-write",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    capabilities(raw()),
  );
  expect(planned.error?.code).toBe("approval.required");
  expect(planned.effects[0]).toMatchObject({ action: "api.request", state: "planned" });
});

test("raw API rejects --all for every write method before approval or gateway access", async () => {
  const requested: string[] = [];
  const renderer = {
    isInteractive: false,
    password: async () => undefined,
    select: async () => undefined,
    confirm: async () => false,
    render: () => {},
  } satisfies HumanInterface;
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const approvalArgs of [[], ["--approve", "synthetic-grant"]]) {
      let output = "";
      const exit = await cli(
        [
          "api",
          "/repos/octo/demo",
          "--agent",
          "--host",
          host,
          "--method",
          method,
          "--all",
          ...approvalArgs,
        ],
        "",
        (text) => (output += text),
        () => {},
        {
          catalog: createApiActionsCatalog(),
          human: renderer,
          capabilities: capabilities(recordingRaw(requested)),
        },
      );
      expect(exit).toBe(2);
      expect(JSON.parse(output)).toMatchObject({
        status: "error",
        error: { code: "request.invalid" },
      });
    }
  }
  expect(requested).toEqual([]);
});

test("raw API resolves advertised operations with or without the base path prefix and across path segments", async () => {
  const catalog = createApiActionsCatalog();
  const requested: string[] = [];
  const caps = () => capabilities(recordingRaw(requested), actions(), undefined, contractSession());
  const bare = await execute(
    {
      command: "api",
      input: { host, endpoint: "/version" },
      requestId: "bare",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps(),
  );
  expect(bare.error).toBe(null);
  const prefixed = await execute(
    {
      command: "api",
      input: { host, endpoint: "/api/v1/version" },
      requestId: "prefixed",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps(),
  );
  expect(prefixed.error).toBe(null);
  expect(requested).toEqual(["/version", "/version"]);
  const write = {
    command: "api" as const,
    input: {
      host,
      endpoint: "/api/v1/repos/octo/demo/contents/src/app/main.ts",
      method: "PUT",
      field: ['content="aGk="', 'message="add"'],
    },
    requestId: "contents",
    dryRun: false,
    mode: "request" as const,
  };
  const planned = await execute({ ...write, approval: undefined }, catalog, caps());
  expect(planned.error?.code).toBe("approval.required");
  const written = await execute(
    { ...write, approval: approval(planned) },
    catalog,
    capabilities(recordingRaw(requested), actions(), undefined, contractSession()),
  );
  expect(written.error).toBe(null);
  expect(requested.at(-1)).toBe("/repos/octo/demo/contents/src/app/main.ts");
});

test("raw API refuses endpoints the contract does not advertise, including private web routes", async () => {
  const catalog = createApiActionsCatalog();
  const requested: string[] = [];
  const refused = async (endpoint: string) =>
    (
      await execute(
        {
          command: "api",
          input: { host, endpoint },
          requestId: "absent",
          approval: undefined,
          dryRun: false,
          mode: "request",
        },
        catalog,
        capabilities(recordingRaw(requested), actions(), undefined, contractSession()),
      )
    ).error?.code;
  expect(await refused("/repos/octo/demo/bogus")).toBe("api.operation_not_advertised");
  expect(await refused("/repos/octo/demo/issues/1/bogus")).toBe("api.operation_not_advertised");
  expect(await refused("/api/v1/repos/octo/demo/issues/1/bogus")).toBe(
    "api.operation_not_advertised",
  );
  expect(await refused("/octo/demo/issues")).toBe("api.operation_not_advertised");
  expect(await refused("/octo/demo/settings/hooks")).toBe("api.operation_not_advertised");
  expect(await refused("/repos/octo/demo/settings/collaboration")).toBe(
    "api.operation_not_advertised",
  );
  // The web UI serves these from the same origin as the API, so the matcher has to keep refusing
  // them rather than letting a parameter swallow the extra segments and reach a private page.
  expect(await refused("/octo/demo/src/branch/main/README.md")).toBe(
    "api.operation_not_advertised",
  );
  expect(await refused("/user/settings/applications")).toBe("api.operation_not_advertised");
  expect(requested).toEqual([]);
});

test("raw API refuses a method no advertised operation is declared under, by name", async () => {
  const catalog = createApiActionsCatalog();
  const requested: string[] = [];
  const call = async (endpoint: string, method?: string) =>
    await execute(
      {
        command: "api",
        input: { host, endpoint, ...(method === undefined ? {} : { method }) },
        requestId: "method",
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      catalog,
      capabilities(recordingRaw(requested), actions(), undefined, contractSession()),
    );
  // Every one of these resolves under GET, so the refusal can only be about the method. Reporting
  // it as an unadvertised operation sent a caller to re-examine a path with nothing wrong with it.
  for (const method of ["HEAD", "OPTIONS", "head"]) {
    const refused = await call("/repos/octo/demo", method);
    expect(refused.error?.code).toBe("api.method_unsupported");
    expect(refused.error?.message).toContain(method.toUpperCase());
    // A refusal at the schema is not an attempt, so the ledger stays empty and no grant is asked
    // for even though every method other than GET is approval-gated.
    expect(refused.effects).toEqual([]);
  }
  // A method no REST surface serves is still the generic invalid input it always was.
  expect((await call("/repos/octo/demo", "TRACE")).error?.code).toBe("request.invalid");
  // Input can be wrong twice at once. The method is the half a caller cannot diagnose by reading
  // the issues, so it is the half the code reports; the endpoint is still there to be read.
  const both = await call("version", "HEAD");
  expect(both.error?.code).toBe("api.method_unsupported");
  expect(both.error?.details.issues).toHaveLength(2);
  expect((await call("/repos/octo/demo")).error).toBe(null);
  // Existence checks are what a caller reaches for HEAD to do, and a raw file is one of the routes
  // they reach for, so the spanning match has to keep resolving under the method that is served.
  expect((await call("/repos/octo/demo/raw/scripts/install.sh")).error).toBe(null);
  expect(requested).toEqual(["/repos/octo/demo", "/repos/octo/demo/raw/scripts/install.sh"]);
});

test("a parameter spans segments only where the contract cannot describe them as route structure", async () => {
  const catalog = createApiActionsCatalog();
  const requested: string[] = [];
  const call = async (endpoint: string) =>
    await execute(
      {
        command: "api",
        input: { host, endpoint },
        requestId: "spanning",
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      catalog,
      capabilities(recordingRaw(requested), actions(), undefined, contractSession()),
    );
  // Comparing a base and head branch is a wildcard route, so a head such as feature/login has to
  // resolve. The contract advertises /pulls/{index}/reviews/{id}/comments beneath the same prefix,
  // but its literals do not match this target, so it describes a different route and cannot claim
  // this one.
  const branches = await call("/repos/octo/demo/pulls/main/feature/login");
  expect(branches.error).toBe(null);
  expect(requested.at(-1)).toBe("/repos/octo/demo/pulls/main/feature/login");
  const compared = await call("/repos/octo/demo/compare/main...feature/login");
  expect(compared.error).toBe(null);
  expect(requested.at(-1)).toBe("/repos/octo/demo/compare/main...feature/login");
  // A parameter the contract types as an int64 id can never hold a value that spans segments, so
  // these resolved to an operation the host does not serve and answered with a not found.
  expect((await call("/repositories/1/2/3")).error?.code).toBe("api.operation_not_advertised");
  expect((await call("/repos/octo/demo/labels/5/extra")).error?.code).toBe(
    "api.operation_not_advertised",
  );
  expect((await call("/repos/octo/demo/issues/comments/5/assets/9/extra")).error?.code).toBe(
    "api.operation_not_advertised",
  );
  expect(requested).toEqual([
    "/repos/octo/demo/pulls/main/feature/login",
    "/repos/octo/demo/compare/main...feature/login",
  ]);
});

test("a parameter a path item declares for its operations still spans segments", async () => {
  // Swagger lets a path item declare the parameters its operations share. Reading only the
  // operations would leave the parameter undeclared, and an undeclared parameter never spans, so
  // a host emitting this shape would fail every multi-segment call with a misleading refusal.
  const shared = JSON.stringify({
    paths: {
      "/repos/{owner}/{repo}/contents/{filepath}": {
        parameters: [{ in: "path", name: "filepath", type: "string", required: true }],
        get: { responses: { "200": {} } },
      },
    },
  });
  const requested: string[] = [];
  const outcome = await execute(
    {
      command: "api",
      input: { host, endpoint: "/repos/octo/demo/contents/src/app/main.ts" },
      requestId: "shared",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createApiActionsCatalog(),
    capabilities(recordingRaw(requested), actions(), undefined, session(shared)),
  );
  expect(outcome.error).toBe(null);
  expect(requested).toEqual(["/repos/octo/demo/contents/src/app/main.ts"]);
});

test("raw API input validation describes an endpoint form that resolves", async () => {
  const invalid = await execute(
    {
      command: "api",
      input: { host, endpoint: "version" },
      requestId: "invalid",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createApiActionsCatalog(),
    capabilities(raw()),
  );
  expect(invalid.error?.code).toBe("request.invalid");
  const issues = (invalid.error?.details.issues ?? []) as { message: string }[];
  const messages = issues.map((issue) => issue.message).join(" ");
  expect(messages).toContain("/api/v1/version");
  expect(messages).toContain("/version");
});

test("workflow inspection is local and run reads, logs, artifacts, and polling use purpose-built seams", async () => {
  const catalog = createApiActionsCatalog();
  const caps = capabilities(raw());
  const list = await execute(
    {
      command: "workflow list",
      input: {},
      requestId: "workflows",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  expect(list.result).toMatchObject({ source: "local", workflows: [{ name: "ci.yml" }] });
  const viewed = await execute(
    {
      command: "run view",
      input: {
        host,
        repo: "octo/demo",
        run: { kind: "id", value: 42 },
        job: { kind: "name", value: "test" },
        log: true,
        output: "/tmp/log",
      },
      requestId: "log",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  expect(viewed.result).toMatchObject({ run: { id: 42 }, logs: [{ log: { path: "/tmp/log" } }] });
  const artifacts = await execute(
    {
      command: "run download",
      input: {
        host,
        repo: "octo/demo",
        run: { kind: "id", value: 42 },
        artifact: ["coverage"],
        dir: "/tmp",
      },
      requestId: "artifact",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  const completed = await execute(
    {
      command: "run download",
      input: {
        host,
        repo: "octo/demo",
        run: { kind: "id", value: 42 },
        artifact: ["coverage"],
        dir: "/tmp",
      },
      requestId: "artifact",
      approval: approval(artifacts),
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  expect(completed.result).toMatchObject({
    artifacts: [{ artifact: { name: "coverage" }, path: "/tmp/coverage.zip" }],
  });
  const watched = await execute(
    {
      command: "run watch",
      input: { host, repo: "octo/demo", run: { kind: "id", value: 42 }, interval: 1, timeout: 1 },
      requestId: "watch",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  expect(watched.result).toMatchObject({ watching: true, complete: true, attempts: 1 });
});

test("the run statuses a watch settles on partition the ones the contract advertises", async () => {
  // The two sets are the CLI's own copy of Forgejo's DoneStatuses and PendingStatuses, so they
  // have to stay exhaustive over the run-status filter the Host advertises. A status a later Host
  // adds fails here rather than falling into whichever set the watch happens to default to.
  const advertised = (
    JSON.parse(advertisedContract) as {
      paths: Record<
        string,
        Record<string, { parameters?: Array<{ name?: string; items?: { enum?: string[] } }> }>
      >;
    }
  ).paths["/repos/{owner}/{repo}/actions/runs"]?.get?.parameters?.find(
    (parameter) => parameter.name === "status",
  )?.items?.enum;
  expect(advertised).toBeDefined();
  expect([...settledRunStatuses, ...pendingRunStatuses].sort()).toEqual([...advertised!].sort());
  expect(settledRunStatuses.filter((status) => pendingRunStatuses.includes(status))).toEqual([]);
});

test("a run that has not started is watched rather than reported as finished", async () => {
  // "blocked" is the status a fork pull request waiting on approval carries, and "unknown" is a
  // run the Host recorded but has not placed. Reading either as finished returns at once claiming
  // a completion that never happened.
  for (const status of pendingRunStatuses) {
    const timing = clockWithSleep();
    const outcome = await execute(
      {
        command: "run watch",
        input: {
          host,
          repo: "octo/demo",
          run: { kind: "id", value: 42 },
          interval: 30,
          timeout: 120,
        },
        requestId: `watch-${status}`,
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      createApiActionsCatalog(),
      {
        ...capabilities(raw(), actions({ get: async () => ({ ...run, status }) })),
        clock: timing.clock,
        sleep: timing.sleep,
      },
    );
    expect(outcome.error).toBeNull();
    expect(outcome.result).toMatchObject({ watching: true, complete: false, attempts: 5 });
    expect(timing.slept).toEqual([30000, 30000, 30000, 30000]);
  }
});

test("a status the contract does not name keeps a watch waiting", async () => {
  const timing = clockWithSleep();
  const outcome = await execute(
    {
      command: "run watch",
      input: { host, repo: "octo/demo", run: { kind: "id", value: 42 }, interval: 30, timeout: 60 },
      requestId: "watch-unnamed",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createApiActionsCatalog(),
    {
      ...capabilities(raw(), actions({ get: async () => ({ ...run, status: "in_progress" }) })),
      clock: timing.clock,
      sleep: timing.sleep,
    },
  );
  expect(outcome.result).toMatchObject({ watching: true, complete: false, attempts: 3 });
});

test("a watch polls at its interval until the run settles", async () => {
  const observed = ["waiting", "running", "running", "success"];
  let polls = 0;
  const timing = clockWithSleep();
  const outcome = await execute(
    {
      command: "run watch",
      input: { host, repo: "octo/demo", run: { kind: "id", value: 42 }, interval: 5, timeout: 300 },
      requestId: "watch-settles",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createApiActionsCatalog(),
    {
      ...capabilities(
        raw(),
        actions({
          get: async () => ({ ...run, status: observed[Math.min(polls++, observed.length - 1)]! }),
        }),
      ),
      clock: timing.clock,
      sleep: timing.sleep,
    },
  );
  expect(outcome.result).toMatchObject({
    run: { status: "success" },
    watching: true,
    complete: true,
    attempts: 4,
  });
  expect(timing.slept).toEqual([5000, 5000, 5000]);
});

test("a watch runs to its timeout rather than to a fixed poll count", async () => {
  // The old loop stopped after a hundred polls, so a five-minute watch at the default interval
  // ended a hundred seconds early while reporting an unremarkable unfinished run.
  const timing = clockWithSleep();
  const outcome = await execute(
    {
      command: "run watch",
      input: { host, repo: "octo/demo", run: { kind: "id", value: 42 }, interval: 1, timeout: 300 },
      requestId: "watch-uncapped",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createApiActionsCatalog(),
    {
      ...capabilities(raw(), actions({ get: async () => ({ ...run, status: "running" }) })),
      clock: timing.clock,
      sleep: timing.sleep,
    },
  );
  expect(outcome.result).toMatchObject({ watching: true, complete: false, attempts: 301 });
  expect(timing.slept.reduce((total, item) => total + item, 0)).toBe(300000);
});

test("a watch sleeps no longer than the timeout it was given", async () => {
  const timing = clockWithSleep();
  const outcome = await execute(
    {
      command: "run watch",
      input: {
        host,
        repo: "octo/demo",
        run: { kind: "id", value: 42 },
        interval: 30,
        timeout: 100,
      },
      requestId: "watch-clamped",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createApiActionsCatalog(),
    {
      ...capabilities(raw(), actions({ get: async () => ({ ...run, status: "waiting" }) })),
      clock: timing.clock,
      sleep: timing.sleep,
    },
  );
  expect(outcome.result).toMatchObject({ watching: true, complete: false, attempts: 5 });
  expect(timing.slept).toEqual([30000, 30000, 30000, 10000]);
  expect(timing.slept.reduce((total, item) => total + item, 0)).toBe(100000);
});

test("a watch interval below one second is refused rather than spun on", async () => {
  for (const command of ["run watch", "workflow run"]) {
    const outcome = await execute(
      {
        command,
        input: {
          host,
          repo: "octo/demo",
          run: { kind: "id", value: 42 },
          workflow: "ci.yml",
          ref: "main",
          interval: 0.05,
        },
        requestId: "watch-floor",
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      createApiActionsCatalog(),
      capabilities(raw()),
    );
    expect(outcome.error?.code).toBe("request.invalid");
  }
});

test("run download writes each artifact to the requested directory and checksums what landed", async () => {
  const catalog = createApiActionsCatalog();
  const { store, directory } = await diskOutput();
  const archive = new TextEncoder().encode("PK coverage archive bytes");
  const coverage: ActionArtifact = { id: 5, name: "coverage report", size_in_bytes: 21 };
  const asked: Array<{ run: number; artifact: number }> = [];
  const caps = capabilities(
    raw(),
    actions({
      artifacts: async (_host, _token, _owner, _repo, id) => {
        asked.push({ run: id, artifact: 0 });
        return [coverage];
      },
      downloadArtifact: async (_host, _token, _owner, _repo, id) => {
        asked.push({ run: 0, artifact: id });
        return bodyStream(archive);
      },
    }),
    undefined,
    undefined,
    store,
  );
  const input = {
    host,
    repo: "octo/demo",
    run: { kind: "id", value: 42 },
    artifact: ["coverage report"],
    dir: directory,
  };
  const planned = await execute(
    {
      command: "run download",
      input,
      requestId: "d",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  const completed = await execute(
    {
      command: "run download",
      input,
      requestId: "d",
      approval: approval(planned),
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  const path = join(directory, "coverage_report.zip");
  // The directory did not exist before the download, and the bytes have to be readable now.
  const landed = new Uint8Array(await readFile(path));
  expect(landed).toEqual(archive);
  expect(completed.error).toBeNull();
  expect(completed.result).toMatchObject({
    run: { id: 42 },
    artifacts: [
      {
        artifact: coverage,
        path,
        bytes: archive.byteLength,
        media_type: "application/zip",
        sha256: createHash("sha256").update(landed).digest("hex"),
      },
    ],
  });
  // Artifacts are listed and fetched by their stable IDs, which is what both routes take.
  expect(asked).toEqual([
    { run: 42, artifact: 0 },
    { run: 0, artifact: 5 },
  ]);
});

test("an artifact larger than the read bound is written out rather than refused", async () => {
  // The boundary behaviour for bulk content: an artifact three times the size this client will
  // hold in memory still lands, because it is streamed to the destination and never buffered. It
  // is neither truncated nor refused, and the reported size and checksum describe the whole file.
  const catalog = createApiActionsCatalog();
  const chunk = new Uint8Array(4 * 1024 * 1024);
  const chunks = 12;
  const checksum = createHash("sha256");
  let placed = 0;
  const caps = {
    ...capabilities(
      raw(),
      actions({
        artifacts: async () => [{ id: 5, name: "coverage", size_in_bytes: chunks * chunk.length }],
        downloadArtifact: async () => {
          let remaining = chunks;
          return new ReadableStream<Uint8Array>({
            pull: (controller) =>
              remaining-- > 0 ? controller.enqueue(chunk) : controller.close(),
          });
        },
      }),
    ),
    // A placement that keeps nothing, so the test measures what passed through rather than
    // holding a file larger than the bound under test in memory to check it.
    output: {
      write: async (_bytes: Uint8Array, destination: string | undefined) =>
        destination ?? "/tmp/output",
      stream: async (body: ReadableStream<Uint8Array>, destination: string | undefined) => {
        for await (const part of body) placed += part.byteLength;
        return destination ?? "/tmp/output";
      },
    },
  };
  const input = {
    host,
    repo: "octo/demo",
    run: { kind: "id", value: 42 },
    artifact: ["coverage"],
    dir: "/downloads",
  };
  const planned = await execute(
    {
      command: "run download",
      input,
      requestId: "big",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  const completed = await execute(
    {
      command: "run download",
      input,
      requestId: "big",
      approval: approval(planned),
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  for (let index = 0; index < chunks; index++) checksum.update(chunk);
  expect(completed.error).toBeNull();
  expect(completed.result).toMatchObject({
    artifacts: [
      {
        artifact: { id: 5, name: "coverage" },
        path: "/downloads/coverage.zip",
        bytes: chunks * chunk.length,
        media_type: "application/zip",
        sha256: checksum.digest("hex"),
      },
    ],
  });
  expect(placed).toBe(chunks * chunk.length);
});

test("run download resolves a repository run number to the run whose artifacts it fetches", async () => {
  const catalog = createApiActionsCatalog();
  const { store, directory } = await diskOutput();
  const filters: ActionRunFilter[] = [];
  const listed: number[] = [];
  const caps = capabilities(
    raw(),
    actions({
      get: async () => {
        throw new Error("a run number must not be read as a stable ID");
      },
      list: async (_host, _token, _owner, _repo, filter) => {
        filters.push(filter);
        return [run];
      },
      artifacts: async (_host, _token, _owner, _repo, id) => {
        listed.push(id);
        return [{ id: 5, name: "coverage", size_in_bytes: 3 }];
      },
    }),
    undefined,
    undefined,
    store,
  );
  const input = {
    host,
    repo: "octo/demo",
    run: { kind: "number", value: 9 },
    artifact: ["5"],
    dir: directory,
  };
  const planned = await execute(
    {
      command: "run download",
      input,
      requestId: "n",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  const completed = await execute(
    {
      command: "run download",
      input,
      requestId: "n",
      approval: approval(planned),
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  expect(filters.map((filter) => filter.run_number)).toEqual([9]);
  // The repository index selects the run, but the stable ID is what the artifact routes take.
  expect(listed).toEqual([42]);
  expect(completed.result).toMatchObject({
    run: { id: 42, index_in_repo: 9 },
    artifacts: [{ artifact: { id: 5 }, path: join(directory, "coverage.zip") }],
  });
  expect(new Uint8Array(await readFile(join(directory, "coverage.zip")))).toEqual(
    new Uint8Array([1, 2, 3]),
  );
});

test("run download reports a typed not-found for an artifact the run does not have", async () => {
  const catalog = createApiActionsCatalog();
  const { store, directory } = await diskOutput();
  let downloads = 0;
  const caps = capabilities(
    raw(),
    actions({
      artifacts: async () => [{ id: 5, name: "coverage", size_in_bytes: 3 }],
      downloadArtifact: async () => {
        downloads++;
        return bodyStream(new Uint8Array([1]));
      },
    }),
    undefined,
    undefined,
    store,
  );
  const input = {
    host,
    repo: "octo/demo",
    run: { kind: "id", value: 42 },
    artifact: ["absent"],
    dir: directory,
  };
  const planned = await execute(
    {
      command: "run download",
      input,
      requestId: "m",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  const attempted = await execute(
    {
      command: "run download",
      input,
      requestId: "m",
      approval: approval(planned),
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  expect(attempted.error?.code).toBe("artifact.not_found");
  // The same payload shape the run and job selectors use, so a caller reads every selector failure
  // the same way, and the candidates carry the IDs the recovery hint points at.
  expect(attempted.error?.details).toEqual({
    requested: "absent",
    candidates: [{ id: 5, name: "coverage" }],
    recovery: "select from the candidate artifacts",
  });
  expect(downloads).toBe(0);
});

test("run download reports an unfinished artifact walk with its own code and recovery", async () => {
  const catalog = createApiActionsCatalog();
  const { store, directory } = await diskOutput();
  const caps = capabilities(
    raw(),
    actions({
      artifacts: async () => {
        throw {
          code: "actions.too_many_artifacts",
          message: "The run's artifact listing did not end within the pages this client walks",
          details: { pages_walked: 50, recovery: "page the artifacts endpoint through api" },
        };
      },
    }),
    undefined,
    undefined,
    store,
  );
  const input = {
    host,
    repo: "octo/demo",
    run: { kind: "id", value: 42 },
    artifact: ["coverage"],
    dir: directory,
  };
  const planned = await execute(
    {
      command: "run download",
      input,
      requestId: "w",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  const attempted = await execute(
    {
      command: "run download",
      input,
      requestId: "w",
      approval: approval(planned),
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  // A partial walk must not read as "artifact absent", and the caller needs the recovery, so the
  // executor carries the code, message, and details rather than a generic failure.
  expect(attempted.error?.code).toBe("actions.too_many_artifacts");
  expect(attempted.error?.message).toContain("did not end");
  expect(attempted.error?.details).toMatchObject({ recovery: expect.any(String) });
});

test("run download resolves every selector before it writes any of them", async () => {
  const catalog = createApiActionsCatalog();
  const { store, directory } = await diskOutput();
  const downloaded: number[] = [];
  const caps = capabilities(
    raw(),
    actions({
      artifacts: async () => [
        { id: 5, name: "coverage", size_in_bytes: 3 },
        { id: 6, name: "duplicate", size_in_bytes: 3 },
        { id: 7, name: "duplicate", size_in_bytes: 3 },
      ],
      downloadArtifact: async (_host, _token, _owner, _repo, id) => {
        downloaded.push(id);
        return bodyStream(new Uint8Array([1]));
      },
    }),
    undefined,
    undefined,
    store,
  );
  const input = {
    host,
    repo: "octo/demo",
    run: { kind: "id", value: 42 },
    artifact: ["coverage", "duplicate"],
    dir: directory,
  };
  const planned = await execute(
    {
      command: "run download",
      input,
      requestId: "p",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  const attempted = await execute(
    {
      command: "run download",
      input,
      requestId: "p",
      approval: approval(planned),
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  expect(attempted.error?.code).toBe("artifact.ambiguous");
  // The colliding artifacts, not the run's whole list, in the shape the run and job selectors use.
  expect(attempted.error?.details).toEqual({
    requested: "duplicate",
    candidates: [
      { id: 6, name: "duplicate" },
      { id: 7, name: "duplicate" },
    ],
    recovery: "use the stable artifact ID",
  });
  // The ledger declares one effect for the whole list, so it cannot say "one of two landed". No
  // artifact is written unless every selector resolved.
  expect(downloaded).toEqual([]);
  expect(await readdir(directory).catch(() => [])).toEqual([]);
});

test("run list reports real run fields and qualifies a short ref before filtering", async () => {
  const catalog = createApiActionsCatalog();
  const filters: ActionRunFilter[] = [];
  const caps = capabilities(
    raw(),
    actions({
      list: async (_host, _token, _owner, _repo, filter) => {
        filters.push(filter);
        return [run];
      },
    }),
  );
  const listed = await execute(
    {
      command: "run list",
      input: { host, repo: "octo/demo", ref: "main", page: 1, limit: 30 },
      requestId: "runs",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  expect(listed.result).toMatchObject({
    ref: "refs/heads/main",
    items: [
      {
        title: "CI",
        status: "success",
        commit_sha: "abc",
        prettyref: "main",
        created: "2025-01-01T00:00:00Z",
        updated: "2025-01-01T00:01:00Z",
      },
    ],
  });
  const qualified = await execute(
    {
      command: "run list",
      input: { host, repo: "octo/demo", ref: "refs/tags/v1.0.0", page: 1, limit: 30 },
      requestId: "runs-tag",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  expect(qualified.result).toMatchObject({ ref: "refs/tags/v1.0.0" });
  // `prettyref` reports `#12` for a pull ref, so the value a caller reads back round-trips.
  const pull = await execute(
    {
      command: "run list",
      input: { host, repo: "octo/demo", ref: "#12", page: 1, limit: 30 },
      requestId: "runs-pull",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  expect(pull.result).toMatchObject({ ref: "refs/pull/12/head" });
  expect(filters.map((filter) => filter.ref)).toEqual([
    "refs/heads/main",
    "refs/tags/v1.0.0",
    "refs/pull/12/head",
  ]);
  const unfiltered = await execute(
    {
      command: "run list",
      input: { host, repo: "octo/demo", page: 1, limit: 30 },
      requestId: "runs-all",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    caps,
  );
  expect(unfiltered.result).not.toHaveProperty("ref");
  expect(filters[3]?.ref).toBeUndefined();
});

test("run selectors are typed and rerun probes capability before an approved mutation", async () => {
  const catalog = createApiActionsCatalog();
  const selector = await execute(
    {
      command: "run view",
      input: {
        host,
        repo: "octo/demo",
        run: { kind: "id", value: 42 },
        job: { kind: "name", value: "missing" },
      },
      requestId: "selector",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    capabilities(raw()),
  );
  expect(selector.error?.code).toBe("job.not_found");
  let reruns = 0;
  const unsupported = await execute(
    {
      command: "run rerun",
      input: { host, repo: "octo/demo", run: { kind: "id", value: 42 } },
      requestId: "unsupported",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    capabilities(
      raw(),
      actions({
        rerunCapability: async () => undefined,
        rerun: async () => {
          reruns++;
          return { run, jobs: [] };
        },
      }),
    ),
  );
  const attempted = await execute(
    {
      command: "run rerun",
      input: { host, repo: "octo/demo", run: { kind: "id", value: 42 } },
      requestId: "unsupported",
      approval: approval(unsupported),
      dryRun: false,
      mode: "request",
    },
    catalog,
    capabilities(
      raw(),
      actions({
        rerunCapability: async () => undefined,
        rerun: async () => {
          reruns++;
          return { run, jobs: [] };
        },
      }),
    ),
  );
  expect(attempted.error?.code).toBe("capability.unsupported");
  expect(reruns).toBe(0);
  const planned = await execute(
    {
      command: "run rerun",
      input: { host, repo: "octo/demo", run: { kind: "id", value: 42 } },
      requestId: "rerun",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    capabilities(raw()),
  );
  expect(planned.error?.code).toBe("approval.required");
  expect(planned.effects[0]?.details).toMatchObject({ required_capability: "actions-rerun@1" });
});

const multiJobs: ActionJob[] = [
  { id: 3, name: "build", status: "success", attempt: 1 },
  { id: 4, name: "test", status: "failure", attempt: 2 },
  { id: 5, name: "lint", status: "success", attempt: 1 },
];
/** Records which job each per-job log call asked for and answers with that job's own output. */
function jobLogRecorder(): { requested: number[]; written: string[]; gateway: ActionsGateway } {
  const requested: number[] = [];
  const written: string[] = [];
  return {
    requested,
    written,
    gateway: actions({
      jobs: async () => multiJobs,
      jobLogs: async (_host, _token, _owner, _repo, job) => {
        requested.push(job);
        return bodyStream(new TextEncoder().encode(`log for job ${job}`));
      },
    }),
  };
}
function capturing(gateway: ActionsGateway, written: string[]) {
  return {
    ...capabilities(raw(), gateway),
    output: {
      write: async (bytes: Uint8Array, destination: string | undefined) => {
        written.push(new TextDecoder().decode(bytes));
        return destination ?? "/tmp/output";
      },
      stream: async (body: ReadableStream<Uint8Array>, destination: string | undefined) => {
        written.push(new TextDecoder().decode(await collect(body)));
        return destination ?? "/tmp/output";
      },
    },
  };
}
async function viewRun(
  input: Record<string, unknown>,
  caps: ReturnType<typeof capabilities>,
): Promise<Awaited<ReturnType<typeof execute>>> {
  return execute(
    {
      command: "run view",
      input: { host, repo: "octo/demo", run: { kind: "id", value: 42 }, ...input },
      requestId: "view",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createApiActionsCatalog(),
    caps,
  );
}

test("run view reports every job of a multi-job run and resolves one by stable id or by name", async () => {
  const caps = capabilities(raw(), actions({ jobs: async () => multiJobs }));
  const listed = await viewRun({}, caps);
  expect(listed.result).toMatchObject({ id: 42, jobs: multiJobs });
  const byId = await viewRun({ job: { kind: "id", value: 4 } }, caps);
  expect(byId.result).toMatchObject({
    job: { id: 4, name: "test", status: "failure", attempt: 2 },
  });
  const byName = await viewRun({ job: { kind: "name", value: "test" } }, caps);
  expect(byName.result).toMatchObject({ job: { id: 4, name: "test" } });
});

test("run view --log-failed returns the failing job's own log", async () => {
  const recorder = jobLogRecorder();
  const failed = await viewRun({ log_failed: true }, capturing(recorder.gateway, recorder.written));
  expect(failed.result).toMatchObject({
    run: { id: 42 },
    logs: [{ job: { id: 4, name: "test" } }],
  });
  expect(recorder.requested).toEqual([4]);
  expect(recorder.written).toEqual(["log for job 4"]);
});

test("run view --job with --log returns only the selected job's log", async () => {
  const recorder = jobLogRecorder();
  const selected = await viewRun(
    { job: { kind: "name", value: "lint" }, log: true },
    capturing(recorder.gateway, recorder.written),
  );
  expect(selected.result).toMatchObject({ logs: [{ job: { id: 5, name: "lint" } }] });
  expect(recorder.requested).toEqual([5]);
});

test("a job selector that matches nothing reports a typed failure listing the run's real jobs", async () => {
  const absent = await viewRun(
    { job: { kind: "name", value: "missing" } },
    capabilities(raw(), actions({ jobs: async () => multiJobs })),
  );
  expect(absent.error?.code).toBe("job.not_found");
  expect(absent.error?.details).toEqual({
    requested: "missing",
    candidates: [
      { id: 3, name: "build" },
      { id: 4, name: "test" },
      { id: 5, name: "lint" },
    ],
    recovery: "select from the candidate jobs",
  });
});

test("an ambiguous job name reports only the jobs that share it", async () => {
  const duplicated = [...multiJobs, { id: 6, name: "test", status: "success", attempt: 1 }];
  const ambiguous = await viewRun(
    { job: { kind: "name", value: "test" } },
    capabilities(raw(), actions({ jobs: async () => duplicated })),
  );
  expect(ambiguous.error?.code).toBe("job.ambiguous");
  // The caller already named "test"; what they cannot see is which of the jobs carrying that name
  // they have to choose between, so the unrelated jobs of the run are noise here.
  expect(ambiguous.error?.details).toEqual({
    requested: "test",
    candidates: [
      { id: 4, name: "test" },
      { id: 6, name: "test" },
    ],
    recovery: "use the stable job ID",
  });
});

test("every Actions selector reports its candidates in the same shape, cap and recovery", async () => {
  const many = Array.from({ length: 12 }, (_unused, index) => ({
    id: index + 1,
    name: `job-${index + 1}`,
    status: "success",
    attempt: 1,
  }));
  const capped = await viewRun(
    { job: { kind: "name", value: "missing" } },
    capabilities(raw(), actions({ jobs: async () => many })),
  );
  expect(capped.error?.details.candidates).toHaveLength(10);

  const ambiguousRun = await execute(
    {
      command: "run view",
      input: { host, repo: "octo/demo", run: { kind: "number", value: 9 } },
      requestId: "runs",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createApiActionsCatalog(),
    capabilities(raw(), actions({ list: async () => [run, { ...run, id: 43 }] })),
  );
  expect(ambiguousRun.error?.code).toBe("run.ambiguous");
  expect(ambiguousRun.error?.details).toEqual({
    requested: 9,
    candidates: [
      { id: 42, index_in_repo: 9 },
      { id: 43, index_in_repo: 9 },
    ],
    recovery: "use the stable run ID",
  });

  // The Host filtered the listing by run number, so an absent run has no candidates to offer and
  // says so rather than pointing at an empty list.
  const absentRun = await execute(
    {
      command: "run view",
      input: { host, repo: "octo/demo", run: { kind: "number", value: 99 } },
      requestId: "runs",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createApiActionsCatalog(),
    capabilities(raw(), actions({ list: async () => [] })),
  );
  expect(absentRun.error?.code).toBe("run.not_found");
  expect(absentRun.error?.details).toEqual({
    requested: 99,
    candidates: [],
    recovery: "list the runs to find one",
  });
});

test("a failed selection carries its candidates as steps, and an empty branch carries none", async () => {
  const ambiguousJob = await viewRun(
    { job: { kind: "name", value: "test" } },
    capabilities(
      raw(),
      actions({
        jobs: async () => [...multiJobs, { id: 6, name: "test", status: "success", attempt: 1 }],
      }),
    ),
  );
  // Each colliding job becomes the one selector that resolves to it, so a caller re-issues the
  // command from a step instead of rebuilding the selector out of `details.candidates`.
  expect(ambiguousJob.next_steps).toEqual([
    { action: "select", field: "job", value: { kind: "id", value: 4 } },
    { action: "select", field: "job", value: { kind: "id", value: 6 } },
  ]);

  const request = (input: Record<string, unknown>) => ({
    command: "run download",
    input: { host, repo: "octo/demo", dir: "/tmp", ...input },
    requestId: "steps",
    approval: undefined,
    dryRun: false,
    mode: "request" as const,
  });
  const grant = async (input: Record<string, unknown>, gateway: ReturnType<typeof actions>) => {
    const planned = await execute(
      request(input),
      createApiActionsCatalog(),
      capabilities(raw(), gateway),
    );
    const approve = String(planned.error?.details.approve);
    return execute(
      { ...request(input), approval: approve.slice("--approve ".length) },
      createApiActionsCatalog(),
      capabilities(raw(), gateway),
    );
  };
  // `run download` takes a list of selectors, so an artifact step replaces the entry that failed
  // and names the stable ID, which is the one value that cannot collide with another artifact.
  const missingArtifact = await grant(
    { run: { kind: "id", value: 42 }, artifact: ["absent"] },
    actions({ artifacts: async () => [{ id: 7, name: "coverage", size_in_bytes: 3 }] }),
  );
  expect(missingArtifact.error?.code).toBe("artifact.not_found");
  expect(missingArtifact.next_steps).toEqual([{ action: "select", field: "artifact", value: "7" }]);

  // Nothing exists to select, so the list stays empty rather than carrying an invented recovery.
  const emptyArtifacts = await grant(
    { run: { kind: "id", value: 42 }, artifact: ["absent"] },
    actions({ artifacts: async () => [] }),
  );
  expect(emptyArtifacts.error?.code).toBe("artifact.not_found");
  expect(emptyArtifacts.next_steps).toEqual([]);

  // A transport failure knows nothing about what the caller should do next, and says nothing.
  const refused = await viewRun(
    { job: { kind: "name", value: "test" } },
    capabilities(
      raw(),
      actions({
        jobs: async () => {
          throw new Error("actions.request_failed");
        },
      }),
    ),
  );
  expect(refused.error?.code).toBe("actions.request_failed");
  expect(refused.next_steps).toEqual([]);
});

test("a bounded step list cannot let a large candidate list unbound an outcome", async () => {
  const many = Array.from({ length: 40 }, (_unused, index) => ({
    id: index + 1,
    name: `job-${index + 1}`,
    status: "success",
    attempt: 1,
  }));
  const capped = await viewRun(
    { job: { kind: "name", value: "missing" } },
    capabilities(raw(), actions({ jobs: async () => many })),
  );
  expect(capped.error?.details.candidates).toHaveLength(10);
  expect(capped.next_steps).toHaveLength(10);
  expect(capped.next_steps.at(-1)).toEqual({
    action: "select",
    field: "job",
    value: { kind: "id", value: 10 },
  });
});

test("rerunning one job targets that job and reports the attempt the Host started", async () => {
  const targets: Array<number | undefined> = [];
  const gateway = actions({
    jobs: async () => multiJobs,
    rerun: async (_host, _token, _owner, _repo, _run, job) => {
      targets.push(job);
      return { run, jobs: [{ id: 4, name: "test", status: "waiting", attempt: 3 }] };
    },
  });
  const catalog = createApiActionsCatalog();
  const input = {
    host,
    repo: "octo/demo",
    run: { kind: "id", value: 42 },
    job: { kind: "name", value: "test" },
  };
  const planned = await execute(
    {
      command: "run rerun",
      input,
      requestId: "job-rerun",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    capabilities(raw(), gateway),
  );
  expect(planned.error?.code).toBe("approval.required");
  const rerun = await execute(
    {
      command: "run rerun",
      input,
      requestId: "job-rerun",
      approval: approval(planned),
      dryRun: false,
      mode: "request",
    },
    catalog,
    capabilities(raw(), gateway),
  );
  expect(rerun.result).toMatchObject({
    resolved: { run: { id: 42 }, job: { id: 4, name: "test" } },
    jobs: [{ id: 4, attempt: 3 }],
  });
  expect(targets).toEqual([4]);
});

/** Runs one Human invocation and returns the outcome the renderer received. */
async function human(
  argv: string[],
): Promise<{ exit: number; outcome: CommandOutcome | undefined }> {
  let outcome: CommandOutcome | undefined;
  const renderer = {
    isInteractive: false,
    password: async () => undefined,
    select: async () => undefined,
    confirm: async () => false,
    render: (value: CommandOutcome) => void (outcome = value),
  } satisfies HumanInterface;
  const exit = await cli(
    argv,
    "",
    () => {},
    () => {},
    {
      catalog: createApiActionsCatalog(),
      human: renderer,
      capabilities: capabilities(raw(), actions({ jobs: async () => multiJobs })),
    },
  );
  return { exit, outcome };
}

test("Human --job and --job-id resolve a job the same way the Request selector does", async () => {
  const named = await human([
    "run",
    "view",
    "42",
    "--host",
    host,
    "--repo",
    "octo/demo",
    "--job",
    "test",
  ]);
  expect(named.exit).toBe(0);
  expect(named.outcome?.result).toMatchObject({ job: { id: 4, name: "test" } });
  const identified = await human([
    "run",
    "view",
    "42",
    "--host",
    host,
    "--repo",
    "octo/demo",
    "--job-id",
    "5",
  ]);
  expect(identified.exit).toBe(0);
  expect(identified.outcome?.result).toMatchObject({ job: { id: 5, name: "lint" } });
  const both = await human([
    "run",
    "view",
    "42",
    "--host",
    host,
    "--repo",
    "octo/demo",
    "--job",
    "test",
    "--job-id",
    "4",
  ]);
  expect(both.exit).toBe(2);
  expect(both.outcome?.error?.code).toBe("argv.invalid");
});

/** A local workflow gateway that fails the test if dispatch consults the working directory. */
function untouchableWorkflows(): WorkflowGateway {
  return {
    list: async () => {
      throw new Error("workflow.local_read");
    },
    get: async () => {
      throw new Error("workflow.local_read");
    },
  };
}
async function dispatched(
  caps: CapabilitySet,
  extra: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof execute>>> {
  const catalog = createApiActionsCatalog();
  const invocation = {
    command: "workflow run",
    input: { host, repo: "octo/demo", workflow: "ci.yml", ref: "main", ...extra },
    requestId: "dispatch-local-free",
    approval: undefined as string | undefined,
    dryRun: false,
    mode: "request" as const,
  };
  const planned = await execute(invocation, catalog, caps);
  return execute({ ...invocation, approval: approval(planned) }, catalog, caps);
}

test("workflow run dispatches on the Host without reading the local working directory", async () => {
  const dispatches: unknown[] = [];
  const outcome = await dispatched(
    capabilities(
      raw(),
      actions({
        dispatch: async (_host, _token, owner, repo, workflow, ref, inputs) => {
          dispatches.push({ owner, repo, workflow, ref, inputs });
          return run;
        },
      }),
      untouchableWorkflows(),
    ),
    { field: ["environment=production", "count=3"] },
  );
  expect(outcome.error).toBeNull();
  expect(dispatches).toEqual([
    {
      owner: "octo",
      repo: "demo",
      workflow: "ci.yml",
      ref: "main",
      // Dispatch inputs are strings on the wire, so the catalog hands the gateway what was written.
      inputs: { environment: "production", count: "3" },
    },
  ]);
  expect(outcome.effects.map((effect) => [effect.action, effect.state])).toEqual([
    ["workflow.dispatch", "succeeded"],
  ]);
});

test("workflow run --watch polls a dispatched run to completion without a local workflow file", async () => {
  let polls = 0;
  const timing = clockWithSleep();
  const outcome = await dispatched(
    {
      ...capabilities(
        raw(),
        actions({
          dispatch: async () => ({ ...run, status: null }),
          get: async () => {
            polls++;
            return run;
          },
        }),
        untouchableWorkflows(),
      ),
      clock: timing.clock,
      sleep: timing.sleep,
    },
    { watch: true, interval: 5, timeout: 60 },
  );
  expect(outcome.error).toBeNull();
  expect(polls).toBe(1);
  expect(timing.slept).toEqual([5000]);
  expect(outcome.result).toMatchObject({
    run: { id: 42, status: "success" },
    watching: true,
    complete: true,
  });
});

test("dispatching a workflow the Host does not have reports the Host's not-found", async () => {
  const outcome = await dispatched(
    capabilities(
      raw(),
      actions({
        dispatch: async () => {
          throw new Error("actions.not_found");
        },
      }),
      untouchableWorkflows(),
    ),
  );
  expect(outcome.error?.code).toBe("actions.not_found");
  // A dispatch the Host refused never landed, so its effect stays planned rather than succeeded.
  expect(outcome.effects.map((effect) => [effect.action, effect.state])).toEqual([
    ["workflow.dispatch", "planned"],
  ]);
});
