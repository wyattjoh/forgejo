import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../packages/forgejo-cli/src/cli";
import type { HumanInterface } from "../packages/forgejo-cli/src/human-interface";
import { createRepositoryCatalog } from "../packages/forgejo/src/repository-catalog";
import {
  emptyHostConfig,
  HostSession,
  type HostConfig,
  type HostCredentialStore,
} from "../packages/forgejo/src/host-session";
import { execute } from "../packages/forgejo/src/runtime";
import type { RepositoryGateway } from "../packages/forgejo/src/repository-gateway";
import { createGitOperations, type GitOperations } from "../packages/forgejo/src/git-operations";
import {
  resolveRepositoryContext,
  type RepositoryContextError,
} from "../packages/forgejo/src/repository-context";

const host = "https://forgejo.example";
const credentials: HostCredentialStore = {
  get: async () => "synthetic-token",
  put: async () => {},
  remove: async () => {},
};
function session(hosts: string[] = [host]): HostSession {
  let config: HostConfig = {
    ...emptyHostConfig(),
    hosts: hosts.map((url, index) => ({
      url,
      identity: { id: String(index + 1), login: "octo" },
      server_version: "16.0.2",
      swagger_sha256: null,
    })),
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
const repository = {
  host,
  owner: "octo",
  name: "demo",
  full_name: "octo/demo",
  description: null,
  visibility: "public" as const,
  archived: false,
  fork: false,
  default_branch: "main",
  clone_urls: { https: null, ssh: null },
  web_url: `${host}/octo/demo`,
};

test("repository commands return normalized reads and approval-gated mutation plans", async () => {
  const gateway: RepositoryGateway = {
    list: async () => [repository],
    get: async () => repository,
    create: async () => repository,
    edit: async () => repository,
    remove: async () => {},
    fork: async () => repository,
  };
  const capabilities = {
    gateway: { smoke: async ({ value }: { value: string }) => ({ echoed: value }) },
    host: session(),
    repositories: gateway,
    git: undefined,
    environment: {},
    cwd: "/tmp",
    keychainNoUi: true,
    clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    cancelled: () => false,
  };
  const view = await execute(
    {
      command: "repo view",
      input: { host, repo: "octo/demo" },
      requestId: "repo-1",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createRepositoryCatalog(),
    capabilities,
  );
  expect(view.result).toEqual(repository);
  const deletion = await execute(
    {
      command: "repo delete",
      input: { host, repo: "octo/demo" },
      requestId: "repo-2",
      approval: undefined,
      dryRun: false,
      mode: "request",
    },
    createRepositoryCatalog(),
    capabilities,
  );
  expect(deletion.error?.code).toBe("approval.required");
  expect(deletion.effects).toEqual([
    expect.objectContaining({ action: "repository.delete", state: "planned" }),
  ]);
});

function git(): GitOperations {
  return createGitOperations(
    {
      run: async (argv, options) => {
        const child = Bun.spawn(argv, {
          cwd: options.cwd,
          env: { ...process.env, ...options.environment },
          stdin: options.stdin ?? "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          exit_code: await child.exited,
          stdout: await new Response(child.stdout).text(),
          stderr: await new Response(child.stderr).text(),
        };
      },
    },
    {
      read: async () => new Uint8Array(),
      write: async () => {},
      directoryStatus: async (path) => {
        try {
          const info = await stat(path);
          return info.isDirectory() && (await readdir(path)).length === 0 ? "empty" : "nonempty";
        } catch (error) {
          if ((error as { code?: string }).code === "ENOENT") return "missing";
          throw error;
        }
      },
      list: undefined,
    },
    () => false,
  );
}
async function runGit(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
}
function approval(outcome: Awaited<ReturnType<typeof execute>>): string {
  const value = String(outcome.error?.details.approve);
  return value.replace("--approve ", "");
}

test("Human repo list uses one configured Host without prompting", async () => {
  let selectedHost = "";
  let selections = 0;
  const human = {
    isInteractive: true,
    password: async () => undefined,
    select: async () => {
      selections += 1;
      return undefined;
    },
    confirm: async () => false,
    render: () => {},
  } satisfies HumanInterface;
  const exit = await run(
    ["repo", "list", "wyattjoh"],
    "",
    () => {},
    () => {},
    {
      catalog: createRepositoryCatalog(),
      human,
      capabilities: {
        gateway: { smoke: async ({ value }) => ({ echoed: value }) },
        host: session(),
        repositories: {
          list: async (selected) => {
            selectedHost = selected;
            return [];
          },
          get: async () => repository,
          create: async () => repository,
          edit: async () => repository,
          remove: async () => {},
          fork: async () => repository,
        },
        git: undefined,
        environment: {},
        cwd: "/tmp",
        keychainNoUi: true,
        clock: { now: () => new Date("2025-01-01T00:00:00Z") },
        cancelled: () => false,
      },
    },
  );
  expect(exit).toBe(0);
  expect(selectedHost).toBe(host);
  expect(selections).toBe(0);
});

test("Human repo list prompts when multiple Hosts are configured", async () => {
  const secondHost = "https://code.example";
  let selectedHost = "";
  let offered: string[] = [];
  const human = {
    isInteractive: true,
    password: async () => undefined,
    select: async (_message, options) => {
      offered = options;
      return secondHost;
    },
    confirm: async () => false,
    render: () => {},
  } satisfies HumanInterface;
  const exit = await run(
    ["repo", "list", "wyattjoh"],
    "",
    () => {},
    () => {},
    {
      catalog: createRepositoryCatalog(),
      human,
      capabilities: {
        gateway: { smoke: async ({ value }) => ({ echoed: value }) },
        host: session([host, secondHost]),
        repositories: {
          list: async (selected) => {
            selectedHost = selected;
            return [];
          },
          get: async () => repository,
          create: async () => repository,
          edit: async () => repository,
          remove: async () => {},
          fork: async () => repository,
        },
        git: undefined,
        environment: {},
        cwd: "/tmp",
        keychainNoUi: true,
        clock: { now: () => new Date("2025-01-01T00:00:00Z") },
        cancelled: () => false,
      },
    },
  );
  expect(exit).toBe(0);
  expect(offered).toEqual([host, secondHost]);
  expect(selectedHost).toBe(secondHost);
});

test("configured Git remotes infer one safe repository context", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgejo-context-"));
  try {
    await runGit(root, "init");
    await runGit(root, "remote", "add", "origin", "git@forgejo.example:prefix/octo/demo.git");
    await runGit(root, "remote", "add", "backup", "https://forgejo.example/prefix/octo/demo.git");
    const context = await resolveRepositoryContext(
      {
        host: undefined,
        repo: undefined,
        environmentHost: undefined,
        cwd: root,
        requestMode: false,
        requireRepository: true,
      },
      [
        {
          url: "https://forgejo.example/prefix",
          identity: null,
          server_version: null,
          swagger_sha256: null,
        },
      ],
      git(),
    );
    expect(context).toMatchObject({
      deployment_url: "https://forgejo.example/prefix",
      host_selection_source: "git_remote",
      repository: "octo/demo",
      remote_name: "origin",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("repo create accepts the authenticated account as an explicit owner", async () => {
  const organizations: Array<string | undefined> = [];
  const gateway: RepositoryGateway = {
    list: async () => [repository],
    get: async () => repository,
    create: async (_host, _token, input) => {
      organizations.push(input.organization);
      // Forgejo answers 404 on the organization endpoint when the owner is a user.
      if (input.organization !== undefined && input.organization !== "acme")
        throw new Error("repository.not_found");
      const owner = input.organization ?? "octo";
      return { ...repository, owner, full_name: `${owner}/${input.name}`, name: input.name };
    },
    edit: async () => repository,
    remove: async () => {},
    fork: async () => repository,
  };
  const capabilities = {
    gateway: { smoke: async ({ value }: { value: string }) => ({ echoed: value }) },
    host: session(),
    repositories: gateway,
    git: undefined,
    environment: {},
    cwd: "/tmp",
    keychainNoUi: true,
    clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    cancelled: () => false,
  };
  const created = async (owner: string) => {
    const invocation = {
      command: "repo create",
      input: { host, name: "demo", owner },
      requestId: `create-${owner}`,
      approval: undefined as string | undefined,
      dryRun: false,
      mode: "request" as const,
    };
    const planned = await execute(invocation, createRepositoryCatalog(), capabilities);
    return execute(
      { ...invocation, approval: approval(planned) },
      createRepositoryCatalog(),
      capabilities,
    );
  };
  const self = await created("octo");
  expect(self.error).toBeNull();
  expect(self.result).toMatchObject({ full_name: "octo/demo" });
  expect(self.effects).toEqual([
    expect.objectContaining({ effect_id: "repository.create", state: "succeeded" }),
  ]);
  // Forgejo stores one unique lower_name across users and organizations, so a differently cased
  // owner is the same account and must route the same way.
  const cased = await created("Octo");
  expect(cased.error).toBeNull();
  expect(cased.result).toMatchObject({ full_name: "octo/demo" });
  const organization = await created("acme");
  expect(organization.error).toBeNull();
  expect(organization.result).toMatchObject({ full_name: "acme/demo" });
  expect(organizations).toEqual([undefined, undefined, "acme"]);
});

test("repo fork accepts the authenticated account as an explicit owner", async () => {
  const organizations: Array<string | undefined> = [];
  const gateway: RepositoryGateway = {
    list: async () => [repository],
    get: async () => repository,
    create: async () => repository,
    edit: async () => repository,
    remove: async () => {},
    fork: async (_host, _token, _owner, name, organization) => {
      organizations.push(organization);
      // Forgejo resolves the fork's organization against organizations only, so a user name
      // there answers 404 and forks nothing.
      if (organization !== undefined && organization !== "acme")
        throw new Error("repository.not_found");
      const owner = organization ?? "octo";
      return { ...repository, owner, name, full_name: `${owner}/${name}` };
    },
  };
  const capabilities = {
    gateway: { smoke: async ({ value }: { value: string }) => ({ echoed: value }) },
    host: session(),
    repositories: gateway,
    git: undefined,
    environment: {},
    cwd: "/tmp",
    keychainNoUi: true,
    clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    cancelled: () => false,
  };
  const forked = async (owner: string | undefined) => {
    const invocation = {
      command: "repo fork",
      input:
        owner === undefined
          ? { host, repo: "upstream/demo" }
          : { host, repo: "upstream/demo", owner },
      requestId: `fork-${owner ?? "omitted"}`,
      approval: undefined as string | undefined,
      dryRun: false,
      mode: "request" as const,
    };
    const planned = await execute(invocation, createRepositoryCatalog(), capabilities);
    return execute(
      { ...invocation, approval: approval(planned) },
      createRepositoryCatalog(),
      capabilities,
    );
  };
  const omitted = await forked(undefined);
  expect(omitted.error).toBeNull();
  expect(omitted.result).toMatchObject({ full_name: "octo/demo" });
  const self = await forked("octo");
  expect(self.error).toBeNull();
  expect(self.result).toMatchObject({ full_name: "octo/demo" });
  expect(self.effects).toEqual([
    expect.objectContaining({ effect_id: "repository.fork", state: "succeeded" }),
  ]);
  // Forgejo stores one unique lower_name across users and organizations, so a differently cased
  // owner is the same account and must route the same way.
  const cased = await forked("Octo");
  expect(cased.error).toBeNull();
  expect(cased.result).toMatchObject({ full_name: "octo/demo" });
  const organization = await forked("acme");
  expect(organization.error).toBeNull();
  expect(organization.result).toMatchObject({ full_name: "acme/demo" });
  expect(organizations).toEqual([undefined, undefined, undefined, "acme"]);
});

test("Request targeting reports the input that is absent rather than the repository", async () => {
  const profiles = [{ url: host, identity: null, server_version: null, swagger_sha256: null }];
  const failure = async (selection: { host: string | undefined; repo: string | undefined }) =>
    resolveRepositoryContext(
      {
        ...selection,
        environmentHost: undefined,
        cwd: "/tmp",
        requestMode: true,
        requireRepository: true,
      },
      profiles,
      undefined,
    ).then(
      () => undefined,
      (error: unknown) => error as RepositoryContextError,
    );
  const missingHost = await failure({ host: undefined, repo: "octo/demo" });
  expect(missingHost?.code).toBe("host.required");
  expect(missingHost?.details).toEqual({ recovery: "--host HOST" });
  const missingRepository = await failure({ host, repo: undefined });
  expect(missingRepository?.code).toBe("repo.required");
  expect(missingRepository?.details).toEqual({ recovery: "--repo OWNER/NAME" });
  // The prose recovery stays where it is, and the same answer arrives as a step naming the input
  // that was absent, so a caller acts on the field rather than parsing a flag out of a sentence.
  expect(missingHost?.next_steps).toEqual([{ action: "provide", field: "host" }]);
  expect(missingRepository?.next_steps).toEqual([{ action: "provide", field: "repo" }]);
});

test("Host selection reports the codes it raises and a generic for anything else", async () => {
  const profile = (url: string) => ({
    url,
    identity: null,
    server_version: null,
    swagger_sha256: null,
  });
  const selected = async (selector: string, profiles: ReturnType<typeof profile>[]) =>
    resolveRepositoryContext(
      {
        host: selector,
        repo: "octo/demo",
        environmentHost: undefined,
        cwd: "/tmp",
        requestMode: true,
        requireRepository: true,
      },
      profiles,
      undefined,
    ).then(
      () => undefined,
      (error: unknown) => error as RepositoryContextError,
    );
  // The two codes selection raises are the ones a caller branches on, so both keep flowing through.
  expect((await selected("other.example", [profile(host)]))?.code).toBe("host.not_found");
  expect((await selected("forgejo.example", [profile(host), profile(`${host}/git`)]))?.code).toBe(
    "host.ambiguous",
  );
  // A profile whose stored URL cannot be parsed fails selection with a description of the mishap
  // rather than a code. Promoting that message would report `Invalid URL` in the code position,
  // which no caller can branch on and which appears in no catalog.
  const malformed = await selected("forgejo.example", [profile("not a url")]);
  expect(malformed?.code).toBe("host.not_found");
  expect(malformed?.details).toEqual({ recovery: "--host HOST" });
});

test("clone, create source partial failure, and fork clone retain ordered effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgejo-repository-"));
  const source = join(root, "source.git");
  await runGit(root, "init", "--bare", source);
  const localGit = git();
  const localRepository = { ...repository, clone_urls: { https: source, ssh: null } };
  let created = false;
  const gateway: RepositoryGateway = {
    list: async () => [localRepository],
    get: async () => localRepository,
    create: async () => {
      created = true;
      return localRepository;
    },
    edit: async () => localRepository,
    remove: async () => {},
    fork: async () => ({ ...localRepository, name: "forked", full_name: "octo/forked" }),
  };
  const capabilities = {
    gateway: { smoke: async ({ value }: { value: string }) => ({ echoed: value }) },
    host: session(),
    repositories: gateway,
    git: localGit,
    environment: {},
    cwd: root,
    keychainNoUi: true,
    clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    cancelled: () => false,
  };
  try {
    const plannedClone = await execute(
      {
        command: "repo clone",
        input: { host, repo: "octo/demo", directory: "clone" },
        requestId: "clone",
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      createRepositoryCatalog(),
      capabilities,
    );
    const cloned = await execute(
      {
        command: "repo clone",
        input: { host, repo: "octo/demo", directory: "clone" },
        requestId: "clone",
        approval: approval(plannedClone),
        dryRun: false,
        mode: "request",
      },
      createRepositoryCatalog(),
      capabilities,
    );
    expect(cloned.effects).toEqual([
      expect.objectContaining({ effect_id: "git.clone", state: "succeeded" }),
    ]);
    expect(await stat(join(root, "clone", ".git"))).toBeDefined();

    const plannedCreate = await execute(
      {
        command: "repo create",
        input: { host, name: "new", source: join(root, "clone"), remote: "origin" },
        requestId: "create",
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      createRepositoryCatalog(),
      capabilities,
    );
    const createdOutcome = await execute(
      {
        command: "repo create",
        input: { host, name: "new", source: join(root, "clone"), remote: "origin" },
        requestId: "create",
        approval: approval(plannedCreate),
        dryRun: false,
        mode: "request",
      },
      createRepositoryCatalog(),
      capabilities,
    );
    expect(created).toBe(true);
    expect(createdOutcome.error?.code).toBe("git.remote_exists");
    expect(createdOutcome.effects).toEqual([
      expect.objectContaining({ effect_id: "repository.create", state: "succeeded" }),
      expect.objectContaining({ effect_id: "git.remote.add", state: "failed" }),
    ]);

    const plannedFork = await execute(
      {
        command: "repo fork",
        input: { host, repo: "octo/demo", clone: true },
        requestId: "fork",
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      createRepositoryCatalog(),
      capabilities,
    );
    const forked = await execute(
      {
        command: "repo fork",
        input: { host, repo: "octo/demo", clone: true },
        requestId: "fork",
        approval: approval(plannedFork),
        dryRun: false,
        mode: "request",
      },
      createRepositoryCatalog(),
      capabilities,
    );
    expect(forked.effects).toEqual([
      expect.objectContaining({ effect_id: "repository.fork", state: "succeeded" }),
      expect.objectContaining({ effect_id: "git.clone", state: "succeeded" }),
    ]);
    expect(await stat(join(root, "forked", ".git"))).toBeDefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
