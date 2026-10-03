import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { z } from "zod";
import {
  createSmokeCatalog,
  createAuthCatalog,
  boundedItems,
  compareManifest,
  decodeRequest,
  deliver,
  deliverStream,
  execute,
  isErrorCode,
  serializeOutcome,
  type CommandDefinition,
  type CommandOutcome,
} from "../packages/forgejo/src/runtime";
import { run } from "../packages/forgejo-cli/src/cli";
import { cliVersion } from "../packages/forgejo-cli/src/version";
import {
  createClackHumanInterface,
  type HumanInterface,
} from "../packages/forgejo-cli/src/human-interface";
import { createApiActionsCatalog } from "../packages/forgejo/src/api-actions-catalog";
import { createIssueCatalog } from "../packages/forgejo/src/issue-catalog";
import {
  createPairedCommandReferences,
  renderPairedCommandReference,
  renderPairedVersionSupport,
  supportedVersionRange,
} from "../packages/forgejo-cli/src/paired-skill";
import { createPullRequestCatalog } from "../packages/forgejo/src/pull-request-catalog";
import { createRepositoryCatalog } from "../packages/forgejo/src/repository-catalog";
import {
  boundDiagnostics,
  createCancellation,
  isFresh,
  request,
  requestStream,
  responseReadLimit,
  responseTooLarge,
  validateAdvertisedContract,
} from "../packages/forgejo/src/infrastructure";
import {
  createFileOutputFileSystem,
  createOutputStore,
  type OutputFileSystem,
  type OutputStore,
} from "../packages/forgejo/src/adapters";

const capabilities = {
  gateway: { smoke: async ({ value }: { value: string }) => ({ echoed: value }) },
  host: undefined,
  repositories: undefined,
  git: undefined,
  environment: {},
  cwd: "/tmp",
  clock: { now: () => new Date("2025-01-01T00:00:00.000Z") },
  cancelled: () => false,
};
const approvalFor = ""; // executor returns a recovery digest, which is intentionally observable via the outcome.

test("Request adapter rejects unknown keys while preserving a recoverable request identity", () => {
  const decoded = decodeRequest(
    "smoke echo",
    '{"schema_version":1,"request_id":"r-1","input":{},"extra":true}',
    undefined,
    false,
  );
  expect("status" in decoded && decoded.request_id).toBe("r-1");
});

test("Request adapter reports unsupported schema versions with a recoverable identity", () => {
  const decoded = decodeRequest(
    "smoke echo",
    '{"schema_version":2,"request_id":"r-2","input":{}}',
    undefined,
    false,
  );
  expect("status" in decoded && decoded.error?.code).toBe("request.unsupported_version");
  expect("status" in decoded && decoded.request_id).toBe("r-2");
});

test("executor returns an approval plan before a mutation", async () => {
  const outcome = await execute(
    {
      command: "smoke echo",
      input: { value: "hello" },
      requestId: "r-1",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createSmokeCatalog(),
    capabilities,
  );
  expect(outcome.error?.code).toBe("approval.required");
  expect(outcome.effects[0]?.state).toBe("planned");
  expect(outcome.error?.details.plan_digest).toBeString();
  // The grant is already computed here, so it also arrives as a step and a caller re-issues what
  // it sent rather than slicing the flag back out of `details.approve`.
  expect(outcome.next_steps).toEqual([
    { action: "approve", grant: String(outcome.error?.details.approve).slice("--approve ".length) },
  ]);
});

test("steps are bounded, and a failure with no known recovery keeps an empty list", async () => {
  const flooding: CommandDefinition = {
    name: "smoke echo",
    description: "Return more steps than an outcome may carry",
    input: z.object({ value: z.string().min(1) }).strict(),
    mutation: false,
    plan: (input) => ({ command: "smoke echo", input, targets: [], effects: [] }),
    handler: async () => ({
      result: {},
      next_steps: Array.from({ length: 40 }, (_unused, index) => ({
        action: "select" as const,
        field: "run",
        value: { kind: "id", value: index },
      })),
    }),
  };
  const flooded = await execute(
    {
      command: "smoke echo",
      input: { value: "hello" },
      requestId: "r-1",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    [flooding],
    capabilities,
  );
  expect(flooded.next_steps).toHaveLength(16);
  // The retained steps stay a prefix of what the producer offered, so the most specific recovery
  // is the one that survives the cap.
  expect(flooded.next_steps[0]).toEqual({
    action: "select",
    field: "run",
    value: { kind: "id", value: 0 },
  });

  const bare = await execute(
    {
      command: "smoke echo",
      input: { value: "hello" },
      requestId: "r-1",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    [
      {
        ...flooding,
        handler: async () => {
          throw new Error("transport.failed");
        },
      },
    ],
    capabilities,
  );
  expect(bare.error?.code).toBe("transport.failed");
  expect(bare.next_steps).toEqual([]);
});

test("dry runs preserve planned effects without invoking a gateway", async () => {
  const outcome = await execute(
    {
      command: "smoke echo",
      input: { value: "hello" },
      requestId: "r-1",
      approval: approvalFor,
      dryRun: true,
      mode: "request",
    },
    createSmokeCatalog(),
    capabilities,
  );
  expect(outcome.status).toBe("success");
  expect(outcome.effects[0]?.state).toBe("planned");
});

test("Human adapter renders the same dry-run smoke outcome", async () => {
  let stdout = "";
  const exit = await run(
    ["smoke", "echo", "--value", "hi", "--dry-run"],
    "",
    (text) => {
      stdout += text;
    },
    () => {},
  );
  expect(exit).toBe(0);
  expect(stdout).toContain("{}");
});

test("interactive Human mode confirms and executes a mutation", async () => {
  let confirmation = "";
  let renderedStatus = "";
  const human = {
    isInteractive: true,
    password: async () => undefined,
    select: async () => undefined,
    confirm: async (message) => {
      confirmation = message;
      return true;
    },
    render: (outcome) => {
      renderedStatus = outcome.status;
    },
  } satisfies HumanInterface;
  const exit = await run(
    ["smoke", "echo", "--value", "hi"],
    "",
    () => {},
    () => {},
    { catalog: createSmokeCatalog(), capabilities, human },
  );
  expect(exit).toBe(0);
  expect(confirmation).toContain("Run smoke echo?");
  expect(renderedStatus).toBe("success");
});

test("every Human command exposes Commander help", async () => {
  const catalog = [
    ...createSmokeCatalog(),
    ...createAuthCatalog(),
    ...createRepositoryCatalog(),
    ...createIssueCatalog(),
    ...createPullRequestCatalog(),
    ...createApiActionsCatalog(),
  ];
  for (const definition of catalog) {
    let stdout = "";
    let stderr = "";
    const exit = await run(
      [...definition.name.split(" "), "--help"],
      "",
      (text) => void (stdout += text),
      (text) => void (stderr += text),
      { catalog, capabilities, human: undefined },
    );
    expect(exit).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("--help");
    expect(stderr).toBe("");
  }
});

test("end-to-end Request mode emits exactly one typed outcome", async () => {
  let stdout = "";
  const exit = await run(
    ["smoke", "echo", "--input-output", "json", "--dry-run"],
    '{"schema_version":1,"request_id":"smoke-1","input":{"value":"hi"}}',
    (text) => {
      stdout += text;
    },
    () => {},
  );
  const outcome = JSON.parse(stdout);
  expect(exit).toBe(0);
  expect(stdout.endsWith("\n")).toBe(true);
  expect(outcome.command).toBe("smoke echo");
  expect(outcome.effects[0].state).toBe("planned");
});

test("Agent mode derives typed input from normal flags and emits one outcome", async () => {
  const definition: CommandDefinition = {
    name: "issue list",
    description: "List issues",
    input: z
      .object({
        host: z.string().url(),
        repo: z.string().regex(/^[^/]+\/[^/]+$/),
        label: z.array(z.string()),
        limit: z.number().int().max(100),
      })
      .strict(),
    mutation: false,
    plan: (input) => ({ command: "issue list", input, targets: [], effects: [] }),
    handler: async ({ __mode, ...input }) => ({ result: { ...input, adapter_mode: __mode } }),
  };
  let stdout = "";
  const exit = await run(
    [
      "issue",
      "list",
      "--agent",
      "--host",
      "https://forgejo.example",
      "--repo",
      "acme/app",
      "--label",
      "bug",
      "--label",
      "p1",
      "--limit",
      "20",
    ],
    "",
    (text) => void (stdout += text),
    () => {},
    { catalog: [definition], capabilities, human: undefined },
  );
  const outcome = JSON.parse(stdout) as CommandOutcome;
  expect(exit).toBe(0);
  expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
  expect(outcome.request_id).toBeNull();
  expect(outcome.result).toEqual({
    host: "https://forgejo.example",
    repo: "acme/app",
    label: ["bug", "p1"],
    limit: 20,
    adapter_mode: "request",
  });
});

test("Agent mode only forwards options accepted by the selected leaf", async () => {
  const definition: CommandDefinition = {
    name: "repo list",
    description: "List repositories",
    input: z
      .object({
        host: z.string().url(),
        owner: z.string().optional(),
        limit: z.number().int().max(100),
      })
      .strict(),
    mutation: false,
    plan: (input) => ({ command: "repo list", input, targets: [], effects: [] }),
    handler: async (input) => ({
      result: Object.fromEntries(Object.entries(input).filter(([key]) => key !== "__mode")),
    }),
  };
  for (const selector of [[], ["--owner", "acme"]]) {
    let stdout = "";
    const exit = await run(
      ["repo", "list", "--agent", "--host", "https://forgejo.example", ...selector, "--limit", "5"],
      "",
      (text) => void (stdout += text),
      () => {},
      { catalog: [definition], capabilities, human: undefined },
    );
    const outcome = JSON.parse(stdout) as CommandOutcome;
    expect(exit).toBe(0);
    expect(outcome.result).toEqual({
      host: "https://forgejo.example",
      ...(selector.length > 0 ? { owner: "acme" } : {}),
      limit: 5,
    });
  }
});

test("Agent mode preserves approval without prompting", async () => {
  let confirms = 0;
  const human = {
    isInteractive: true,
    password: async () => undefined,
    select: async () => undefined,
    confirm: async () => {
      confirms += 1;
      return true;
    },
    render: () => {},
  } satisfies HumanInterface;
  let stdout = "";
  const firstExit = await run(
    ["smoke", "echo", "--agent", "--value", "hi"],
    "",
    (text) => void (stdout += text),
    () => {},
    { catalog: createSmokeCatalog(), capabilities, human },
  );
  const planned = JSON.parse(stdout) as CommandOutcome;
  expect(firstExit).toBe(1);
  expect(planned.error?.code).toBe("approval.required");
  expect(confirms).toBe(0);

  stdout = "";
  const grant = planned.next_steps.find((step) => step.action === "approve");
  const secondExit = await run(
    ["smoke", "echo", "--agent", "--value", "hi", "--approve", grant!.grant],
    "",
    (text) => void (stdout += text),
    () => {},
    { catalog: createSmokeCatalog(), capabilities, human },
  );
  expect(secondExit).toBe(0);
  expect((JSON.parse(stdout) as CommandOutcome).result).toEqual({ echoed: "hi" });
  expect(confirms).toBe(0);
});

test("Agent mode does not select a Host or accept a run URL", async () => {
  let selections = 0;
  const definition: CommandDefinition = {
    name: "repo view",
    description: "View a repository",
    input: z.object({ host: z.string().optional(), repo: z.string().optional() }).strict(),
    mutation: false,
    plan: (input) => ({ command: "repo view", input, targets: [], effects: [] }),
    handler: async () => {
      throw new Error("host.required");
    },
  };
  let stdout = "";
  const exit = await run(
    ["repo", "view", "--agent", "acme/app"],
    "",
    (text) => void (stdout += text),
    () => {},
    {
      catalog: [definition],
      capabilities: {
        ...capabilities,
        host: { profiles: async () => [{ url: "https://forgejo.example" }] } as never,
      },
      human: {
        isInteractive: true,
        password: async () => undefined,
        select: async () => {
          selections += 1;
          return "https://forgejo.example";
        },
        confirm: async () => undefined,
        render: () => {},
      },
    },
  );
  expect(exit).toBe(1);
  expect((JSON.parse(stdout) as CommandOutcome).error?.code).toBe("host.required");
  expect(selections).toBe(0);

  stdout = "";
  const runExit = await run(
    ["run", "view", "https://forgejo.example/acme/app/actions/runs/7", "--agent"],
    "",
    (text) => void (stdout += text),
    () => {},
    { catalog: createApiActionsCatalog(), capabilities, human: undefined },
  );
  expect(runExit).toBe(2);
  expect((JSON.parse(stdout) as CommandOutcome).error?.message).toContain("stable run ID");
});

test("Agent mode returns typed argv and schema failures", async () => {
  for (const argv of [
    ["--agent"],
    ["smoke", "echo", "--agent", "--unknown"],
    ["smoke", "echo", "--agent", "--value"],
    ["smoke", "echo", "--agent", "-h"],
  ]) {
    let stdout = "";
    const exit = await run(
      argv,
      "",
      (text) => void (stdout += text),
      () => {},
      { catalog: createSmokeCatalog(), capabilities, human: undefined },
    );
    expect(exit).toBe(2);
    expect((JSON.parse(stdout) as CommandOutcome).error?.code).toBe("argv.invalid");
  }

  let stdout = "";
  const conflictExit = await run(
    [
      "issue",
      "create",
      "--agent",
      "--title",
      "title",
      "--body",
      "inline",
      "--body-file",
      "body.md",
    ],
    "",
    (text) => void (stdout += text),
    () => {},
    { catalog: createIssueCatalog(), capabilities, human: undefined },
  );
  const conflict = JSON.parse(stdout) as CommandOutcome;
  expect(conflictExit).toBe(2);
  expect(conflict.command).toBe("issue create");
  expect(conflict.error?.code).toBe("argv.invalid");
});

test("Agent mode materializes explicit standard-input byte sources", async () => {
  const definition: CommandDefinition = {
    name: "api",
    description: "Echo request bytes",
    input: z.object({ endpoint: z.string(), input: z.string() }).strict(),
    mutation: false,
    plan: (input) => ({ command: "api", input, targets: [], effects: [] }),
    handler: async ({ input }) => ({ result: { input } }),
  };
  let stdout = "";
  const exit = await run(
    ["api", "/echo", "--agent", "--input", "-"],
    "explicit bytes",
    (text) => void (stdout += text),
    () => {},
    { catalog: [definition], capabilities, human: undefined },
  );
  expect(exit).toBe(0);
  expect((JSON.parse(stdout) as CommandOutcome).result).toEqual({ input: "explicit bytes" });
});

test("Agent mode version aliases both emit typed metadata", async () => {
  for (const version of ["--version", "-V"]) {
    let stdout = "";
    const exit = await run(
      ["--agent", version],
      "",
      (text) => void (stdout += text),
      () => {},
      { catalog: createSmokeCatalog(), capabilities, human: undefined },
    );
    expect(exit).toBe(0);
    expect((JSON.parse(stdout) as CommandOutcome).command).toBe("version");
  }
});

const smokeRequest = '{"schema_version":1,"request_id":"smoke-1","input":{"value":"hi"}}';

/**
 * Runs argv through Request mode over a gateway that fails the moment an Effect is attempted.
 *
 * A refusal has to land before execution, so the gateway is the assertion: reaching it turns the
 * outcome into a `command.failed` carrying `gateway.reached` rather than the refusal under test.
 */
async function requestRefusal(argv: string[]): Promise<{ exit: number; outcome: CommandOutcome }> {
  let stdout = "";
  const exit = await run(
    argv,
    smokeRequest,
    (text) => void (stdout += text),
    () => {},
    {
      catalog: createSmokeCatalog(),
      capabilities: {
        ...capabilities,
        gateway: {
          smoke: async () => {
            throw new Error("gateway.reached");
          },
        },
      },
      human: undefined,
    },
  );
  return { exit, outcome: JSON.parse(stdout) as CommandOutcome };
}

test("Request mode refuses a flag it does not read, before any Effect is attempted", async () => {
  const { exit, outcome } = await requestRefusal([
    "smoke",
    "echo",
    "--value",
    "hi",
    "--input-output",
    "json",
  ]);
  expect(exit).toBe(2);
  expect(outcome.command).toBe("smoke echo");
  expect(outcome.error?.code).toBe("argv.invalid");
  expect(outcome.error?.message).toContain("'--value'");
  expect(outcome.effects).toEqual([]);
  // The Request is refused rather than decoded, so the identity it carries has to be read straight
  // out of the body; a caller matching outcomes to invocations still gets its correlation string.
  expect(outcome.request_id).toBe("smoke-1");
});

test("Request mode refuses a positional past the leaf selector", async () => {
  // The selector is itself positional, so the boundary is what this pins: `smoke echo` is read and
  // `hi` is not. `api` closes its selector a token earlier, being the one single-token family.
  const { exit, outcome } = await requestRefusal(["smoke", "echo", "hi", "--input-output", "json"]);
  expect(exit).toBe(2);
  expect(outcome.error?.code).toBe("argv.invalid");
  expect(outcome.error?.message).toContain("'hi'");
  const bare = await requestRefusal(["api", "/user", "--input-output", "json"]);
  expect(bare.outcome.command).toBe("api");
  expect(bare.outcome.error?.message).toContain("/user");
});

test("Request mode refuses a valueless --approve rather than reading no grant", async () => {
  const { exit, outcome } = await requestRefusal([
    "smoke",
    "echo",
    "--approve",
    "--input-output",
    "json",
  ]);
  expect(exit).toBe(2);
  expect(outcome.error?.code).toBe("argv.invalid");
  expect(outcome.error?.message).toContain("--approve");
});

test("Request mode refuses a split --input-output json rather than reading the format elsewhere", async () => {
  // Both tokens appearing anywhere is what selects the mode, so this argv reaches Request mode
  // having chosen it, with a `json` that answers to nothing.
  const { exit, outcome } = await requestRefusal([
    "smoke",
    "echo",
    "--input-output",
    "--dry-run",
    "json",
  ]);
  expect(exit).toBe(2);
  expect(outcome.error?.code).toBe("argv.invalid");
  expect(outcome.error?.message).toContain("--input-output");
  expect(outcome.effects).toEqual([]);
});

test("Request mode reads the leaf, the grant, and the dry run in any argv order", async () => {
  const smokeMode = { catalog: createSmokeCatalog(), capabilities, human: undefined };
  let planned = "";
  await run(
    ["--dry-run", "--input-output", "json", "smoke", "echo"],
    smokeRequest,
    (text) => void (planned += text),
    () => {},
    smokeMode,
  );
  const dryRun = JSON.parse(planned) as CommandOutcome;
  expect(dryRun.command).toBe("smoke echo");
  expect(dryRun.effects[0]?.state).toBe("planned");

  let gated = "";
  await run(
    ["--input-output", "json", "smoke", "echo"],
    smokeRequest,
    (text) => void (gated += text),
    () => {},
    smokeMode,
  );
  const grant = String((JSON.parse(gated) as CommandOutcome).error?.details.approve).replace(
    "--approve ",
    "",
  );

  let stdout = "";
  const exit = await run(
    ["--approve", grant, "--input-output", "json", "smoke", "echo"],
    smokeRequest,
    (text) => void (stdout += text),
    () => {},
    smokeMode,
  );
  const outcome = JSON.parse(stdout) as CommandOutcome;
  expect(exit).toBe(0);
  expect(outcome.status).toBe("success");
  expect(outcome.result).toEqual({ echoed: "hi" });
});

test("Human mode still answers an unknown flag in commander's own words", async () => {
  // Request mode refusing unread argv is not a rule Human mode borrows: commander already reports
  // an unknown flag there, in plain text with the usage after it, and it keeps doing that.
  let stdout = "";
  let stderr = "";
  const exit = await run(
    ["smoke", "echo", "--value", "hi", "--bogus"],
    "",
    (text) => void (stdout += text),
    (text) => void (stderr += text),
    { catalog: createSmokeCatalog(), capabilities, human: undefined },
  );
  expect(exit).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toContain("unknown option '--bogus'");
  expect(stderr).toContain("Usage:");
});

test("typed version metadata exposes every catalog leaf for the Paired skill", async () => {
  const catalog = [
    ...createSmokeCatalog(),
    ...createAuthCatalog(),
    ...createRepositoryCatalog(),
    ...createIssueCatalog(),
    ...createPullRequestCatalog(),
    ...createApiActionsCatalog(),
  ];
  let stdout = "";
  let stderr = "";
  const exit = await run(
    ["--version", "--input-output", "json"],
    "",
    (text) => void (stdout += text),
    (text) => void (stderr += text),
    { catalog, capabilities, human: undefined },
  );
  const outcome = JSON.parse(stdout) as {
    result: { cli_version: string; request_schema_version: number; commands: { name: string }[] };
  };
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  expect(outcome.result.cli_version).toBe(cliVersion);
  expect(outcome.result.request_schema_version).toBe(1);
  expect(outcome.result.commands.map((command) => command.name)).toEqual(
    createPairedCommandReferences(catalog).map((command) => command.name),
  );
});

/** Records the placements an Output store performs over a filesystem seam. */
function placements(): {
  store: OutputStore;
  files: Map<string, Uint8Array>;
  directories: string[];
} {
  const files = new Map<string, Uint8Array>();
  const directories: string[] = [];
  return {
    files,
    directories,
    store: createOutputStore({
      makeDirectory: async (path) => void directories.push(path),
      write: async (path, bytes) => void files.set(path, bytes),
      writeStream: async (path, body) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body) chunks.push(chunk);
        files.set(path, new Uint8Array(Buffer.concat(chunks)));
      },
      temporaryFile: async () => "/tmp/output",
    }),
  };
}

test("an Output store creates the directory a destination names, and only when it names one", async () => {
  const placed = placements();
  const archive = new Uint8Array([1, 2, 3]);
  expect(await placed.store.write(archive, "/downloads/artifacts/coverage.zip")).toBe(
    "/downloads/artifacts/coverage.zip",
  );
  // A bare filename is written where the caller stands, so no directory is invented for it. A
  // prefix of the filename would be worse than none, since it appears in the caller's cwd.
  expect(await placed.store.write(archive, "diff.patch")).toBe("diff.patch");
  // A destination at the root names a directory that already exists, so nothing is created.
  expect(await placed.store.write(archive, "/out.bin")).toBe("/out.bin");
  expect(placed.directories).toEqual(["/downloads/artifacts"]);
  expect([...placed.files.keys()]).toEqual([
    "/downloads/artifacts/coverage.zip",
    "diff.patch",
    "/out.bin",
  ]);
  expect(placed.files.get("diff.patch")).toEqual(archive);
});

/** Feeds fixed chunks to a placement, the way a transport hands over a response body. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull: (controller) => {
      const chunk = chunks[index++];
      return chunk === undefined ? controller.close() : controller.enqueue(chunk);
    },
  });
}
/** The production Output filesystem over a fresh temporary directory of real files. */
async function fileOutput(): Promise<{ filesystem: OutputFileSystem; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "forgejo-output-test-"));
  outputRoots.push(root);
  let unique = 0;
  return {
    root,
    filesystem: createFileOutputFileSystem({
      makeDirectory: mkdir,
      writeFile,
      open,
      remove: rm,
      rename,
      makeTemporaryDirectory: mkdtemp,
      temporaryRoot: tmpdir,
      uniqueSuffix: () => String(++unique),
    }),
  };
}
const outputRoots: string[] = [];
afterEach(async () => {
  for (const root of outputRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("the production Output filesystem streams a whole file into place, readable only by its owner", async () => {
  const { filesystem, root } = await fileOutput();
  const destination = join(root, "artifact.zip");
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  await filesystem.writeStream(destination, streamOf(chunks));
  expect(new Uint8Array(await readFile(destination))).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  expect((await stat(destination)).mode & 0o777).toBe(0o600);
  // A second delivery to the same destination replaces it rather than failing on the file it
  // finds, because the exclusive open is on the temporary sibling, not on the destination.
  await filesystem.writeStream(destination, streamOf([new Uint8Array([9])]));
  expect(new Uint8Array(await readFile(destination))).toEqual(new Uint8Array([9]));
  expect(await readdir(root)).toEqual(["artifact.zip"]);
});

test("a stream that fails part way leaves neither the destination nor a partial file", async () => {
  const { filesystem, root } = await fileOutput();
  const destination = join(root, "artifact.zip");
  const failing = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.error(new Error("connection reset"));
    },
  });
  // The destination is what a caller was told to read, so a half-delivered archive must not be
  // sitting at it, and the temporary sibling must not be left behind either.
  await expect(filesystem.writeStream(destination, failing)).rejects.toThrow("connection reset");
  expect(await readdir(root)).toEqual([]);
});

test("a delivery that cannot be renamed into place leaves no temporary file behind", async () => {
  const { root } = await fileOutput();
  const failing = createFileOutputFileSystem({
    makeDirectory: mkdir,
    writeFile,
    open,
    remove: rm,
    // The last step of a placement can fail too, and the temporary sibling sits in the caller's
    // own download directory, so it goes with the failure rather than being left as litter.
    rename: async () => {
      throw new Error("EXDEV: cross-device link not permitted");
    },
    makeTemporaryDirectory: mkdtemp,
    temporaryRoot: tmpdir,
    uniqueSuffix: () => "stuck",
  });
  await expect(
    failing.writeStream(join(root, "artifact.zip"), streamOf([new Uint8Array([1])])),
  ).rejects.toThrow("EXDEV");
  expect(await readdir(root)).toEqual([]);
});

test("a short write fails rather than reporting a file that does not hold every byte", async () => {
  const { root } = await fileOutput();
  const destination = join(root, "artifact.zip");
  const truncating = createFileOutputFileSystem({
    makeDirectory: mkdir,
    writeFile,
    // A handle that accepts a chunk but places only part of it: the store's contract is every
    // byte or none, since the checksum it reports describes the bytes it was handed.
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      return {
        write: async (chunk: Uint8Array) => {
          await handle.write(chunk.subarray(0, 1));
          return { bytesWritten: 1 };
        },
        close: () => handle.close(),
      };
    },
    remove: rm,
    rename,
    makeTemporaryDirectory: mkdtemp,
    temporaryRoot: tmpdir,
    uniqueSuffix: () => "short",
  });
  await expect(
    truncating.writeStream(destination, streamOf([new Uint8Array([1, 2, 3])])),
  ).rejects.toThrow("output.write_incomplete");
  expect(await readdir(root)).toEqual([]);
});

test("bounded delivery fails rather than reporting a checksum for a write that did not happen", async () => {
  const failing: OutputStore = {
    write: async () => {
      throw new Error("ENOSPC: no space left on device");
    },
    stream: async () => {
      throw new Error("ENOSPC: no space left on device");
    },
  };
  expect(deliver(failing, new Uint8Array([1]), "application/zip", "/tmp/a.zip")).rejects.toThrow(
    "ENOSPC",
  );
});

test("outcomes redact token-bearing data and bounded delivery records a checksum", async () => {
  const placed = placements();
  const output = await deliver(placed.store, new TextEncoder().encode("hello"), "text/plain");
  expect(output).toMatchObject({ path: "/tmp/output", bytes: 5, media_type: "text/plain" });
  expect(output.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  expect(
    serializeOutcome({
      schema_version: 1,
      request_id: "r",
      command: "x",
      status: "error",
      result: null,
      error: { code: "x", message: "Bearer token=secret", details: { token: "secret" } },
      context: {},
      effects: [],
      diagnostics: [],
      next_steps: [],
    }),
  ).not.toContain("secret");
});

test("pagination and selected-operation compatibility are bounded", () => {
  expect(boundedItems([[1, 2], [3]], 2)).toEqual({ items: [1, 2], truncated: true });
  expect(
    compareManifest([{ operation_id: "repoGet", method: "GET", path: "/repos/{owner}/{repo}" }], [])
      .compatible,
  ).toBe(false);
});

test("infrastructure caps diagnostics, validates contract caches, and exposes cancellation", async () => {
  const diagnostics = boundDiagnostics(
    Array.from({ length: 17 }, () => ({
      source: "test",
      stream: "stderr" as const,
      content: "Bearer token=secret",
      original_bytes: 19,
      truncated: false,
    })),
  );
  expect(diagnostics).toHaveLength(16);
  expect(diagnostics[0]?.content).toContain("[REDACTED]");
  const cache = validateAdvertisedContract(
    JSON.stringify({ paths: { "/repos/{owner}/{repo}": { get: { operationId: "repoGet" } } } }),
    [{ operation_id: "repoGet", method: "GET", path: "/repos/{owner}/{repo}" }],
    new Date("2025-01-01"),
  );
  expect(isFresh(cache, new Date("2025-01-01T23:59:59Z"))).toBe(true);
  const cancellation = createCancellation();
  cancellation.cancel();
  expect(cancellation.cancelled()).toBe(true);
  expect((await request(async () => new Response("ok"), "https://example.test")).kind).toBe(
    "response",
  );
});

/**
 * Answers one request with a chunked body, recording how much of it was ever produced.
 *
 * The count is how far the read got, not an exact protocol: the transport reads a chunk or so
 * ahead on its own, so a test pins that a bound stops the read well short of the whole body
 * rather than pinning the precise chunk it stopped on.
 */
function chunked(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const pulled: number[] = [];
  let cancelled = false;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      const chunk = chunks[index++];
      if (chunk === undefined) return void controller.close();
      pulled.push(chunk.byteLength);
      controller.enqueue(chunk);
    },
    cancel: () => void (cancelled = true),
  });
  const produced = () => pulled.reduce((total, size) => total + size, 0);
  return {
    produced,
    cancelled: () => cancelled,
    adapter: async () => new Response(body, { headers }),
  };
}

test("a response past the read bound reports its size rather than a transport failure", async () => {
  const nine = new TextEncoder().encode("123456789");
  const refused = await request(async () => new Response(nine), "https://example.test", {}, 8);
  // A caller that reads `network` here retries a request whose answer is simply too big, so the
  // size has to be its own kind, and it has to name both numbers it was judged against.
  expect(refused.kind).toBe("too_large");
  expect(refused).toMatchObject({ limit: 8 });
  // Nothing partial comes back: a truncated archive or log decodes as corrupt rather than as too
  // large, which is the confusion this bound exists to prevent.
  expect(refused).not.toHaveProperty("response");
});

test("a response exactly at the read bound is delivered whole", async () => {
  const nine = new TextEncoder().encode("123456789");
  const allowed = await request(async () => new Response(nine), "https://example.test", {}, 9);
  expect(allowed.kind).toBe("response");
  expect(allowed.kind === "response" ? allowed.response.body : undefined).toEqual(nine);
});

test("an advertised length past the read bound is refused before the body is read", async () => {
  const oversized = chunked([new Uint8Array(4)], { "content-length": String(64 * 1024 * 1024) });
  const refused = await request(oversized.adapter, "https://example.test", {}, 1024);
  expect(refused).toMatchObject({
    kind: "too_large",
    limit: 1024,
    bytes: 64 * 1024 * 1024,
  });
  // The Host said how big it is, so none of it is worth reading and the body is dropped.
  expect(oversized.cancelled()).toBe(true);
});

test("reading stops at the bound rather than buffering everything past it", async () => {
  const streamed = chunked(Array.from({ length: 10 }, () => new Uint8Array(64)));
  const refused = await request(streamed.adapter, "https://example.test", {}, 100);
  // A Host that advertises no length is read until the bound is passed and no further, so an
  // oversized response costs the bound rather than its full size.
  expect(refused).toMatchObject({ kind: "too_large", limit: 100, bytes: null });
  expect(streamed.cancelled()).toBe(true);
  expect(streamed.produced()).toBeLessThan(640);
});

test("a genuine transport failure still reports as a transport failure", async () => {
  const failed = await request(async () => {
    throw new TypeError("fetch failed");
  }, "https://example.test");
  expect(failed).toMatchObject({ kind: "network" });
  const cancelled = await request(async () => {
    throw new DOMException("aborted", "AbortError");
  }, "https://example.test");
  expect(cancelled).toMatchObject({ kind: "cancelled" });
  const stream = await requestStream(async () => {
    throw new TypeError("fetch failed");
  }, "https://example.test");
  expect(stream).toMatchObject({ kind: "network" });
});

test("a streamed request applies no read bound, so bulk content is never refused for size", async () => {
  const chunks = Array.from({ length: 3 }, () => new Uint8Array(8 * 1024 * 1024));
  const streamed = chunked(chunks, { "content-length": String(24 * 1024 * 1024) });
  const result = await requestStream(streamed.adapter, "https://example.test");
  expect(result.kind).toBe("stream");
  const placed = placements();
  const delivered = await deliverStream(
    placed.store,
    result.kind === "stream" ? result.body : new ReadableStream<Uint8Array>(),
    "application/zip",
    "/downloads/big.zip",
  );
  // Three times the buffered read bound reaches the destination intact, checksum and all.
  expect(delivered.bytes).toBe(24 * 1024 * 1024);
  expect(delivered.bytes).toBeGreaterThan(responseReadLimit);
  expect(delivered.sha256).toBe(createHash("sha256").update(Buffer.concat(chunks)).digest("hex"));
  expect(placed.files.get("/downloads/big.zip")?.byteLength).toBe(24 * 1024 * 1024);
});

test("an over-limit response reaches a caller as a size failure naming the limit", async () => {
  const outcome = await failing(
    responseTooLarge("actions", { limit: responseReadLimit, bytes: null, status: 200 }),
  );
  expect(outcome.error?.code).toBe("actions.response_too_large");
  expect(outcome.error?.details).toMatchObject({
    limit_bytes: responseReadLimit,
    // A Host that advertised no length leaves this null rather than inventing a number.
    response_bytes: null,
    status: 200,
  });
  expect(String(outcome.error?.details.recovery)).toContain("file");
});

test("a body that will not cancel still reports the size that was already established", async () => {
  // The cleanup is the last thing that happens to a response nobody will read. Letting it decide
  // the outcome would put an oversized response straight back on the transport-failure path this
  // bound exists to keep it off.
  const unstoppable = new ReadableStream<Uint8Array>({
    pull: (controller) => controller.enqueue(new Uint8Array(64)),
    cancel: () => {
      throw new Error("cancel blew up");
    },
  });
  const advertised = await request(
    async () =>
      new Response(unstoppable, {
        status: 502,
        headers: { "content-length": String(64 * 1024 * 1024) },
      }),
    "https://example.test",
    {},
    1024,
  );
  expect(advertised).toMatchObject({ kind: "too_large", limit: 1024, status: 502 });
  const unadvertised = await request(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: (controller) => controller.enqueue(new Uint8Array(64)),
          cancel: () => {
            throw new Error("cancel blew up");
          },
        }),
      ),
    "https://example.test",
    {},
    100,
  );
  expect(unadvertised).toMatchObject({ kind: "too_large", limit: 100, status: 200 });
});

test("a delivery that cannot be placed drops the body instead of leaving it open", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => controller.enqueue(new Uint8Array(8)),
    cancel: () => void (cancelled = true),
  });
  const unplaceable: OutputStore = {
    write: async () => "/tmp/output",
    // A store that fails before it reads anything, such as one that cannot create the directory
    // it was pointed at. Nothing consumes the response, so nothing else would close it.
    stream: async () => {
      throw new Error("EACCES: permission denied");
    },
  };
  await expect(
    deliverStream(unplaceable, body, "application/zip", "/nope/big.zip"),
  ).rejects.toThrow("EACCES");
  expect(cancelled).toBe(true);
});

const catalogSources = resolve(import.meta.dir, "../packages/forgejo/src");
const cliSources = resolve(import.meta.dir, "../packages/forgejo-cli/src");
async function sourceFiles(): Promise<string[]> {
  const core = (await readdir(catalogSources, { recursive: true })).filter((name) =>
    name.endsWith(".ts"),
  );
  const cli = (await readdir(cliSources, { recursive: true })).filter((name) =>
    name.endsWith(".ts"),
  );
  return [...core, ...cli.map((name) => `../../forgejo-cli/src/${name}`)];
}
/**
 * Collects every error code and namespace the command catalog raises as a bare Error message,
 * which is the only shape the executor has to classify by itself. Codes raised with a dynamic
 * namespace (`${domain}.not_found`) resolve to namespaces this scan already sees as literals,
 * and codes carried on a typed object reach the executor with their own `code` field.
 */
async function raisedFailures(): Promise<{ codes: string[]; namespaces: string[] }> {
  // Deliberately shape-agnostic: a code the executor would reject is collected rather than
  // skipped, so a namespace of an unexpected shape fails here instead of degrading silently.
  const literal = /new Error\(\s*"([^"\s]+\.[^"\s]+)"/g;
  const interpolated = /new Error\(\s*`([^`\s.$]+)\./g;
  const codes = new Set<string>();
  const namespaces = new Set<string>();
  const files = await sourceFiles();
  for (const name of files) {
    const source = await readFile(join(catalogSources, name), "utf8");
    for (const [, code] of source.matchAll(literal)) {
      if (!code) continue;
      codes.add(code);
      namespaces.add(code.slice(0, code.indexOf(".")));
    }
    for (const [, namespace] of source.matchAll(interpolated))
      if (namespace) namespaces.add(namespace);
  }
  return { codes: [...codes].sort(), namespaces: [...namespaces].sort() };
}
async function failing(error: unknown): Promise<Awaited<ReturnType<typeof execute>>> {
  const catalog: CommandDefinition[] = [
    {
      name: "probe fail",
      description: "Fail on purpose",
      input: z.object({}).strict(),
      mutation: false,
      plan: (input) => ({ command: "probe fail", input, targets: [], effects: [] }),
      handler: async () => {
        throw error;
      },
    },
  ];
  return await execute(
    {
      command: "probe fail",
      input: {},
      requestId: "probe-1",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    catalog,
    capabilities,
  );
}

/** Renders one outcome through the Human adapter and returns what it wrote to the error stream. */
function renderedError(outcome: Awaited<ReturnType<typeof execute>>): string {
  let written = "";
  const sink = new Writable({
    write(chunk, _encoding, done) {
      written += String(chunk);
      done();
    },
  });
  createClackHumanInterface({
    input: new Readable({ read() {} }),
    output: sink,
    errorOutput: sink,
    isInteractive: false,
  }).render({ ...outcome, effects: [] });
  return written;
}

test("Human mode renders a failure whose message only repeats its code once", async () => {
  const outcome = await failing(new Error("api.output_required"));
  // A bare code carries itself as its message, so the typed outcome legitimately holds both. Only
  // the Human line collapses; Request mode reads exactly what it read before.
  expect(outcome.error).toMatchObject({
    code: "api.output_required",
    message: "api.output_required",
  });
  expect(JSON.parse(serializeOutcome(outcome)).error).toEqual({
    code: "api.output_required",
    message: "api.output_required",
    details: {},
  });
  const rendered = renderedError(outcome);
  expect(rendered).toContain("api.output_required");
  expect(rendered.match(/api\.output_required/g)).toHaveLength(1);
});

test("Human mode still renders a failure that carries a message of its own", async () => {
  const outcome = await failing({
    code: "job.not_found",
    message: "Job selector did not identify exactly one job",
    details: {},
  });
  expect(JSON.parse(serializeOutcome(outcome)).error).toEqual({
    code: "job.not_found",
    message: "Job selector did not identify exactly one job",
    details: {},
  });
  expect(renderedError(outcome)).toContain(
    "job.not_found: Job selector did not identify exactly one job",
  );
});

test("every error code the command catalog raises survives the executor unchanged", async () => {
  const { codes } = await raisedFailures();
  // Guards against a scan that silently matches nothing and passes vacuously. The floor is well
  // below the count at the time of writing (54), so it catches a scan that quietly narrows,
  // which the named codes alone would not: they would keep being found while coverage shrank.
  expect(codes.length).toBeGreaterThan(40);
  expect(codes).toContain("pull_request.not_found");
  expect(codes).toContain("repository.not_found");
  for (const code of codes) expect((await failing(new Error(code))).error?.code).toBe(code);
});

test("every error namespace the command catalog raises survives the executor unchanged", async () => {
  const { namespaces } = await raisedFailures();
  // `paired_skill` is only ever raised through an interpolated message, so it also guards the
  // half of the scan that reads template literals.
  expect(namespaces.length).toBeGreaterThan(12);
  expect(namespaces).toContain("pull_request");
  expect(namespaces).toContain("paired_skill");
  for (const namespace of namespaces) {
    const code = `${namespace}.future_code`;
    expect((await failing(new Error(code))).error?.code).toBe(code);
  }
});

test("an unclassified failure still reports the generic command failure", async () => {
  const outcome = await failing(new Error("the gateway went away"));
  expect(outcome.error?.code).toBe("command.failed");
  expect(outcome.error?.message).toBe("Command failed");
});

test("a typed failure keeps the code and message it carries", async () => {
  const outcome = await failing({
    code: "issue.label_not_found",
    message: "Requested label was not found",
    details: { label: "missing" },
  });
  expect(outcome.error?.code).toBe("issue.label_not_found");
  expect(outcome.error?.message).toBe("Requested label was not found");
  expect(outcome.error?.details).toEqual({ label: "missing" });
});

test("a typed failure carrying a system code reports the generic failure instead", async () => {
  // A filesystem failure reaches the executor as a typed object, since `main` rethrows anything
  // that is not ENOENT. Its `code` is a real field, but it names an errno rather than a catalogued
  // code, and its message embeds an absolute path. Trusting the field reported both to a caller.
  const outcome = await failing({
    code: "EACCES",
    message: "EACCES: permission denied, stat '/private/var/root/.config/forgejo/hosts.json'",
    details: {},
  });
  expect(outcome.error?.code).toBe("command.failed");
  expect(outcome.error?.message).toBe("Command failed");
});

test("a schema names the code its own refusal reports, and only a code-shaped name is taken", async () => {
  const refused = async (params: Record<string, unknown>) =>
    await execute(
      {
        command: "probe refuse",
        input: {},
        requestId: "refuse-1",
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      [
        {
          name: "probe refuse",
          description: "Refuse its input on purpose",
          input: z
            .object({})
            .strict()
            .superRefine((_value, context) =>
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Refused on purpose",
                params,
              }),
            ),
          mutation: true,
          plan: (input) => ({
            command: "probe refuse",
            input,
            targets: ["target"],
            effects: [
              {
                effect_id: "probe",
                action: "probe",
                target: "target",
                state: "planned",
                details: {},
              },
            ],
          }),
          handler: async () => ({ result: {} }),
        },
      ],
      capabilities,
    );
  const named = await refused({ code: "api.method_unsupported" });
  expect(named.error?.code).toBe("api.method_unsupported");
  expect(named.error?.message).toBe("Refused on purpose");
  expect(named.error?.details.issues).toHaveLength(1);
  // The refusal precedes the approval gate and every planned effect, so a caller reads a mutation
  // it named a code for as never attempted rather than as one awaiting a grant.
  expect(named.effects).toEqual([]);
  // A schema that names prose rather than a code would otherwise put that prose in the code
  // position, which is the one thing the shared shape rule exists to prevent.
  const prose = await refused({ code: "Method is not a supported REST method" });
  expect(prose.error?.code).toBe("request.invalid");
  expect(prose.error?.message).toBe("Invalid command input");
});

/**
 * Every statement in src/ that reads a caught failure's message without routing it through the
 * shared shape rule. A message is the only shape a code can arrive in that nothing has classified
 * yet, so a read that neither classifies it nor compares it against a code it already names is a
 * site that can promote arbitrary text into the code position.
 *
 * Each entry here has to visibly do something other than promote the message.
 */
const unclassifiedMessageReads = [
  'actions-gateway.ts: if (error instanceof Error && error.message === "actions.not_found") return undefined;',
  'api-actions-catalog.ts: if (error instanceof Error && error.message === "api.operation_not_advertised") throw error;',
  "cli.ts: if (error instanceof CommanderError) return reportedInvalid(commandName(argv), error.message);",
  'host-contract-cache.ts: if (error instanceof Error && error.message.startsWith("cache.")) throw error;',
];
/**
 * Collects every read of a caught failure's message across src/, as `file: statement`.
 *
 * A ternary that tests on one line and yields on the next is one statement, so a continuation
 * line is joined to the line above it before the guard is looked for.
 */
async function messageReads(): Promise<string[]> {
  const read = /\b[A-Za-z]*[eE]rror\.message\b/;
  const files = (await sourceFiles()).sort();
  const reads: string[] = [];
  for (const name of files) {
    const lines = (await readFile(join(catalogSources, name), "utf8"))
      .split("\n")
      .map((line) => line.trim());
    for (const [index, line] of lines.entries()) {
      if (!read.test(line)) continue;
      const continuation = /^[?:]/.test(line);
      reads.push(
        `${name.split("/").at(-1)}: ${continuation ? `${lines[index - 1] ?? ""} ${line}` : line}`,
      );
    }
  }
  return reads;
}

test("every site that turns a failure message into a code uses the one shared rule", async () => {
  const reads = await messageReads();
  // Guards against a scan that silently matches nothing and passes vacuously. The floor sits below
  // the count at the time of writing (12), so a scan that quietly narrows fails here rather than
  // reporting an empty set of unclassified reads.
  expect(reads.length).toBeGreaterThan(8);
  // Enumerating rather than spot-checking: a seventh site added without a guard shows up here,
  // whichever file it lands in, instead of hiding behind the sites that are already correct.
  expect(reads.filter((entry) => !entry.includes("isErrorCode(")).sort()).toEqual(
    unclassifiedMessageReads,
  );
});

test("every caught failure is bound as `error`, which is the name the read scan looks for", async () => {
  // The scan above finds a read by name, so a site that bound its failure as anything else would
  // be invisible to it. Nothing else enforces the convention (oxlint runs on defaults, with no
  // naming rule), so the enumeration asserts it rather than assuming it. A rejection handler
  // passed to `.catch` binds a failure just as a `catch` clause does, so both forms are read.
  const binding = /\bcatch\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/g;
  const files = (await readdir(catalogSources, { recursive: true }))
    .filter((name) => name.endsWith(".ts"))
    .sort();
  const names = new Set<string>();
  let bindings = 0;
  for (const name of files) {
    const source = await readFile(join(catalogSources, name), "utf8");
    for (const [, bound] of source.matchAll(binding)) {
      if (!bound) continue;
      bindings += 1;
      names.add(bound);
    }
  }
  // A floor below the count at the time of writing (29), so a scan that stops matching fails here
  // rather than reporting an empty set of names.
  expect(bindings).toBeGreaterThan(20);
  expect([...names]).toEqual(["error"]);
});

test("the error-code shape is written once, so the sites cannot drift apart again", async () => {
  // Five copies of the same literal had already drifted: ticket 01 found the executor rejecting
  // codes the others accepted. A copy pasted into a new site is what this catches, since the
  // read-level enumeration above only sees a site that skips the guard entirely.
  const literal = /\][+*]?\\\./;
  const files = (await readdir(catalogSources, { recursive: true }))
    .filter((name) => name.endsWith(".ts"))
    .sort();
  const copies: string[] = [];
  for (const name of files) {
    const lines = (await readFile(join(catalogSources, name), "utf8")).split("\n");
    for (const line of lines) if (literal.test(line)) copies.push(`${name}: ${line.trim()}`);
  }
  expect(copies).toEqual(["runtime.ts: const errorCodeShape = /^[a-z_]+\\.[a-z_]+$/;"]);
});

test("the shared rule accepts a catalogued code and rejects anything else", () => {
  expect(isErrorCode("pull_request.not_found")).toBe(true);
  expect(isErrorCode("host.ambiguous")).toBe(true);
  // A description of a mishap, a partial code, a code carrying a detail, and a non-string are all
  // values that reached a code position through one site or another.
  expect(isErrorCode('"not a url" cannot be parsed as a URL.')).toBe(false);
  expect(isErrorCode("host")).toBe(false);
  expect(isErrorCode("paired_skill.unsupported_version:0.1.0")).toBe(false);
  expect(isErrorCode(undefined)).toBe(false);
  expect(isErrorCode(new Error("host.not_found"))).toBe(false);
});

test("the Paired skill pins a caret version range and marks conditional approval", () => {
  expect(supportedVersionRange("0.1.0").exclusive_maximum).toBe("0.2.0");
  expect(supportedVersionRange("0.0.7").exclusive_maximum).toBe("0.0.8");
  expect(supportedVersionRange("2.4.1").exclusive_maximum).toBe("3.0.0");
  expect(() => supportedVersionRange("nightly")).toThrow("paired_skill.unsupported_version");
  expect(renderPairedVersionSupport("0.1.0", 1)).toContain("`>=0.1.0 <0.2.0`");

  const catalog = createApiActionsCatalog();
  const references = createPairedCommandReferences(catalog);
  const api = references.find((command) => command.name === "api");
  expect(api).toMatchObject({ mutation: false, conditional_approval: true });
  expect(
    references.filter((command) => command.mutation && command.conditional_approval),
  ).toHaveLength(0);
  expect(renderPairedCommandReference(catalog)).toContain("conditional");
});
