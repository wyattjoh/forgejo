import { z } from "zod";
import {
  requireHostSession,
  type CapabilitySet,
  type CommandDefinition,
  type CommandError,
  type Effect,
  type MutationPlan,
  type NextStep,
} from "./runtime";
import { resolveRepositoryContext, type RepositoryContext } from "./repository-context";
import type { EditRepositoryInput, Repository, RepositoryGateway } from "./repository-gateway";

const selector = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
const remoteName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const page = z.number().int().positive().max(1000).default(1);
const limit = z.number().int().positive().max(100).default(30);
type Input = Record<string, unknown>;
type Resolved = {
  context: RepositoryContext;
  host: string;
  token: string;
  identity: string | undefined;
  gateway: RepositoryGateway;
};

/** Creates repository command entries from the settled v1 command matrix. */
export function createRepositoryCatalog(): CommandDefinition[] {
  return [
    read(
      "repo list",
      "List repositories for an owner or the authenticated account",
      z
        .object({
          host: z.string().min(1).optional(),
          owner: z.string().min(1).optional(),
          page,
          limit,
          visibility: z.enum(["public", "private", "limited"]).optional(),
          archived: z.boolean().optional(),
        })
        .strict(),
      false,
      async (input, resolved) => {
        const items = await resolved.gateway.list(
          resolved.host,
          resolved.token,
          stringOrUndefined(input.owner),
          number(input.page),
          number(input.limit),
        );
        return {
          items: items.filter(
            (item) =>
              (input.visibility === undefined || item.visibility === input.visibility) &&
              (input.archived === undefined || item.archived === input.archived),
          ),
        };
      },
    ),
    read(
      "repo view",
      "Show a repository's metadata",
      z.object({ host: z.string().min(1).optional(), repo: selector.optional() }).strict(),
      true,
      async (_input, resolved) => repository(resolved),
    ),
    clone(),
    create(),
    mutation(
      "repo edit",
      "Change a repository's description, website, default branch, or visibility",
      z
        .object({
          host: z.string().min(1).optional(),
          repo: selector.optional(),
          description: z.string().optional(),
          website: z.string().url().optional(),
          default_branch: z.string().min(1).optional(),
          visibility: z.enum(["public", "private"]).optional(),
        })
        .strict(),
      "repository.edit",
      async (input, resolved) => edit(input, resolved, {}),
    ),
    mutation(
      "repo rename",
      "Rename a repository",
      z
        .object({
          host: z.string().min(1).optional(),
          repo: selector.optional(),
          name: z.string().min(1),
        })
        .strict(),
      "repository.rename",
      async (input, resolved) => edit(input, resolved, { name: String(input.name) }),
    ),
    mutation(
      "repo archive",
      "Archive a repository, making it read-only",
      scoped(),
      "repository.archive",
      async (input, resolved) => edit(input, resolved, { archived: true }),
    ),
    mutation(
      "repo unarchive",
      "Restore an archived repository to writable",
      scoped(),
      "repository.unarchive",
      async (input, resolved) => edit(input, resolved, { archived: false }),
    ),
    mutation(
      "repo delete",
      "Permanently delete a repository",
      scoped(),
      "repository.delete",
      async (_input, resolved) => {
        await resolved.gateway.remove(
          resolved.host,
          resolved.token,
          required(resolved.context.owner),
          required(resolved.context.name),
        );
        return {};
      },
    ),
    fork(),
  ];
}
function scoped(): z.ZodObject<z.ZodRawShape> {
  return z.object({ host: z.string().min(1).optional(), repo: selector.optional() }).strict();
}
function read(
  name: string,
  description: string,
  input: z.ZodObject<z.ZodRawShape>,
  requireRepository: boolean,
  handler: (input: Input, resolved: Resolved) => Promise<Record<string, unknown>>,
): CommandDefinition {
  return {
    name,
    description,
    input,
    mutation: false,
    plan: emptyPlan(name),
    handler: async (input, capabilities) => {
      const resolved = await resolve(input, capabilities, requireRepository);
      return { result: await handler(input, resolved), context: contextRecord(resolved.context) };
    },
  };
}
function mutation(
  name: string,
  description: string,
  input: z.ZodObject<z.ZodRawShape>,
  action: string,
  handler: (input: Input, resolved: Resolved) => Promise<Record<string, unknown>>,
): CommandDefinition {
  return {
    name,
    description,
    input,
    mutation: true,
    plan: (input) => plan(name, input, [effect(action, action, String(input.repo ?? input.name))]),
    handler: async (input, capabilities) => {
      const resolved = await resolve(input, capabilities, true);
      const result = await handler(input, resolved);
      return {
        result,
        context: contextRecord(resolved.context),
        effects: [
          effect(action, action, resolved.context.repository ?? String(input.name), "succeeded"),
        ],
      };
    },
  };
}
function clone(): CommandDefinition {
  const input = z
    .object({
      host: z.string().min(1).optional(),
      repo: selector.optional(),
      directory: z.string().min(1).optional(),
      remote: remoteName.optional(),
    })
    .strict();
  return {
    name: "repo clone",
    description: "Clone a repository and configure its Git remote",
    input,
    mutation: true,
    plan: (value) =>
      plan("repo clone", value, [
        effect("git.clone", "clone_repository", String(value.repo), "planned", {
          destination: value.directory ?? null,
          remote: value.remote ?? "origin",
        }),
      ]),
    preflight: async (value, capabilities) => {
      const resolved = await resolve(value, capabilities, true);
      const repo = await repository(resolved);
      const destination = stringOrUndefined(value.directory) ?? repo.name;
      const state = await requireGit(capabilities).destination(capabilities.cwd, destination);
      if (state === "nonempty")
        throw commandFailure(
          "git.destination_exists",
          "Clone destination already exists and is not empty",
          { destination },
        );
      return { result: repo, context: contextRecord(resolved.context) };
    },
    handler: async (value, capabilities) => {
      const resolved = await resolve(value, capabilities, true);
      const repo = await repository(resolved);
      const destination = stringOrUndefined(value.directory) ?? repo.name;
      const state = await requireGit(capabilities).destination(capabilities.cwd, destination);
      if (state === "nonempty")
        throw commandFailure(
          "git.destination_exists",
          "Clone destination already exists and is not empty",
          { destination },
        );
      const url = required(repo.clone_urls.https);
      const remote = stringOrUndefined(value.remote) ?? "origin";
      const operation = await requireGit(capabilities).clone(
        capabilities.cwd,
        url,
        destination,
        remote,
      );
      const cloneEffect = effect(
        "git.clone",
        "clone_repository",
        url,
        operation.ok ? "succeeded" : "failed",
        { destination, remote },
      );
      if (!operation.ok)
        return partial(
          repo,
          contextRecord(resolved.context),
          [cloneEffect],
          operation.diagnostics,
          "git.clone_failed",
          "Repository clone failed",
          cloneRecovery(url, destination, remote),
        );
      return {
        result: repo,
        context: contextRecord(resolved.context),
        effects: [cloneEffect],
        diagnostics: operation.diagnostics,
      };
    },
  };
}
function create(): CommandDefinition {
  const input = z
    .object({
      host: z.string().min(1).optional(),
      name: z.string().min(1),
      owner: z.string().min(1).optional(),
      description: z.string().optional(),
      private: z.boolean().optional(),
      init: z.boolean().optional(),
      default_branch: z.string().min(1).optional(),
      source: z.string().min(1).optional(),
      remote: remoteName.optional(),
      push: z.boolean().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.push && !value.source)
        context.addIssue({ code: z.ZodIssueCode.custom, message: "--push requires --source" });
    });
  return {
    name: "repo create",
    description: "Create a repository, optionally wiring it to a local source",
    input,
    mutation: true,
    plan: (value) => {
      const effects = [effect("repository.create", "repository.create", String(value.name))];
      if (value.source)
        effects.push(
          effect("git.remote.add", "add_git_remote", String(value.source), "planned", {
            remote: value.remote ?? "origin",
          }),
        );
      if (value.push)
        effects.push(
          effect("git.push", "push_repository", String(value.source), "planned", {
            remote: value.remote ?? "origin",
          }),
        );
      return plan("repo create", value, effects);
    },
    preflight: async (value, capabilities) => {
      const resolved = await resolve(value, capabilities, false);
      if (!value.source) return { context: contextRecord(resolved.context) };
      const remote = stringOrUndefined(value.remote) ?? "origin";
      const observed = await requireGit(capabilities).remoteNames(String(value.source));
      if (observed.names.includes(remote))
        throw commandFailure("git.remote_exists", "Requested Git remote already exists", {
          source: value.source,
          remote,
          diagnostics: observed.diagnostics,
        });
      return { context: contextRecord(resolved.context), diagnostics: observed.diagnostics };
    },
    handler: async (value, capabilities) => {
      const resolved = await resolve(value, capabilities, false);
      const repo = await resolved.gateway.create(resolved.host, resolved.token, {
        name: String(value.name),
        organization: organization(stringOrUndefined(value.owner), resolved.identity),
        description: stringOrUndefined(value.description),
        private: booleanOrUndefined(value.private),
        init: booleanOrUndefined(value.init),
        defaultBranch: stringOrUndefined(value.default_branch),
      });
      const api = effect("repository.create", "repository.create", repo.full_name, "succeeded");
      if (!value.source)
        return {
          result: repo,
          context: contextRecord(repositoryContext(resolved.context, repo)),
          effects: [api],
        };
      const source = String(value.source);
      const remote = stringOrUndefined(value.remote) ?? "origin";
      const url = required(repo.clone_urls.https);
      const names = await requireGit(capabilities).remoteNames(source);
      if (names.names.includes(remote))
        return partial(
          repo,
          contextRecord(repositoryContext(resolved.context, repo)),
          [api, effect("git.remote.add", "add_git_remote", source, "failed", { remote })],
          names.diagnostics,
          "git.remote_exists",
          "Requested Git remote already exists",
          remoteRecovery(source, remote, url),
        );
      const added = await requireGit(capabilities).addRemote(source, remote, url);
      const addedEffect = effect(
        "git.remote.add",
        "add_git_remote",
        source,
        added.ok ? "succeeded" : "failed",
        { remote, url },
      );
      if (!added.ok)
        return partial(
          repo,
          contextRecord(repositoryContext(resolved.context, repo)),
          [api, addedEffect],
          [...names.diagnostics, ...added.diagnostics],
          "git.remote_add_failed",
          "Repository was created, but adding its Git remote failed",
          remoteRecovery(source, remote, url),
        );
      if (!value.push)
        return {
          result: repo,
          context: contextRecord(repositoryContext(resolved.context, repo)),
          effects: [api, addedEffect],
          diagnostics: [...names.diagnostics, ...added.diagnostics],
        };
      const pushed = await requireGit(capabilities).push(source, remote);
      const pushEffect = effect(
        "git.push",
        "push_repository",
        source,
        pushed.ok ? "succeeded" : "failed",
        { remote },
      );
      if (!pushed.ok)
        return partial(
          repo,
          contextRecord(repositoryContext(resolved.context, repo)),
          [api, addedEffect, pushEffect],
          [...names.diagnostics, ...added.diagnostics, ...pushed.diagnostics],
          "git.push_failed",
          "Repository was created, but pushing source failed",
          { action: "invoke", argv: ["git", "-C", source, "push", "-u", remote, "HEAD"] },
        );
      return {
        result: repo,
        context: contextRecord(repositoryContext(resolved.context, repo)),
        effects: [api, addedEffect, pushEffect],
        diagnostics: [...names.diagnostics, ...added.diagnostics, ...pushed.diagnostics],
      };
    },
  };
}
function fork(): CommandDefinition {
  const input = z
    .object({
      host: z.string().min(1).optional(),
      repo: selector.optional(),
      owner: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      clone: z.boolean().optional(),
      remote: remoteName.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.remote && !value.clone)
        context.addIssue({ code: z.ZodIssueCode.custom, message: "--remote requires --clone" });
    });
  return {
    name: "repo fork",
    description: "Fork a repository under an account or organization",
    input,
    mutation: true,
    plan: (value) => {
      const effects = [effect("repository.fork", "repository.fork", String(value.repo))];
      if (value.clone)
        effects.push(
          effect("git.clone", "clone_repository", String(value.repo), "planned", {
            remote: value.remote ?? "origin",
          }),
        );
      return plan("repo fork", value, effects);
    },
    preflight: async (value, capabilities) => {
      const resolved = await resolve(value, capabilities, true);
      if (!value.clone) return { context: contextRecord(resolved.context) };
      const source = await repository(resolved);
      const destination = stringOrUndefined(value.name) ?? source.name;
      const state = await requireGit(capabilities).destination(capabilities.cwd, destination);
      if (state === "nonempty")
        throw commandFailure(
          "git.destination_exists",
          "Clone destination already exists and is not empty",
          {
            destination,
          },
        );
      return { result: source, context: contextRecord(resolved.context) };
    },
    handler: async (value, capabilities) => {
      const resolved = await resolve(value, capabilities, true);
      const repo = await resolved.gateway.fork(
        resolved.host,
        resolved.token,
        required(resolved.context.owner),
        required(resolved.context.name),
        organization(stringOrUndefined(value.owner), resolved.identity),
        stringOrUndefined(value.name),
      );
      const api = effect("repository.fork", "repository.fork", repo.full_name, "succeeded");
      if (!value.clone)
        return {
          result: repo,
          context: contextRecord(repositoryContext(resolved.context, repo)),
          effects: [api],
        };
      const destination = repo.name;
      const state = await requireGit(capabilities).destination(capabilities.cwd, destination);
      if (state === "nonempty")
        return partial(
          repo,
          contextRecord(repositoryContext(resolved.context, repo)),
          [api, effect("git.clone", "clone_repository", destination, "failed")],
          [],
          "git.destination_exists",
          "Fork was created, but clone destination already exists",
          cloneRecovery(
            required(repo.clone_urls.https),
            destination,
            stringOrUndefined(value.remote) ?? "origin",
          ),
        );
      const remote = stringOrUndefined(value.remote) ?? "origin";
      const url = required(repo.clone_urls.https);
      const cloned = await requireGit(capabilities).clone(
        capabilities.cwd,
        url,
        destination,
        remote,
      );
      const cloneEffect = effect(
        "git.clone",
        "clone_repository",
        url,
        cloned.ok ? "succeeded" : "failed",
        { destination, remote },
      );
      if (!cloned.ok)
        return partial(
          repo,
          contextRecord(repositoryContext(resolved.context, repo)),
          [api, cloneEffect],
          cloned.diagnostics,
          "git.clone_failed",
          "Fork was created, but clone failed",
          cloneRecovery(url, destination, remote),
        );
      return {
        result: repo,
        context: contextRecord(repositoryContext(resolved.context, repo)),
        effects: [api, cloneEffect],
        diagnostics: cloned.diagnostics,
      };
    },
  };
}
async function resolve(
  input: Input,
  capabilities: CapabilitySet,
  requireRepository: boolean,
): Promise<Resolved> {
  const context = await resolveRepositoryContext(
    {
      host: stringOrUndefined(input.host),
      repo: stringOrUndefined(input.repo),
      environmentHost: capabilities.environment.FORGEJO_HOST,
      cwd: capabilities.cwd,
      requestMode: input.__mode === "request",
      requireRepository,
    },
    await requireHostSession(capabilities).profiles(),
    capabilities.git,
  );
  const authenticated = await requireHostSession(capabilities).authenticated(
    context.deployment_url,
    capabilities.keychainNoUi ?? true,
  );
  return {
    context,
    host: authenticated.profile.url,
    token: authenticated.token,
    identity: authenticated.profile.identity?.login,
    gateway: gateway(capabilities),
  };
}
async function repository(resolved: Resolved): Promise<Repository> {
  return resolved.gateway.get(
    resolved.host,
    resolved.token,
    required(resolved.context.owner),
    required(resolved.context.name),
  );
}
async function edit(
  input: Input,
  resolved: Resolved,
  forced: Partial<EditRepositoryInput>,
): Promise<Record<string, unknown>> {
  return resolved.gateway.edit(
    resolved.host,
    resolved.token,
    required(resolved.context.owner),
    required(resolved.context.name),
    {
      description: stringOrUndefined(input.description),
      website: stringOrUndefined(input.website),
      defaultBranch: stringOrUndefined(input.default_branch),
      visibility:
        input.visibility === "public" || input.visibility === "private"
          ? input.visibility
          : undefined,
      archived: undefined,
      name: undefined,
      ...forced,
    },
  );
}
function plan(command: string, input: Input, effects: Effect[]): MutationPlan {
  return { command, input, targets: effects.map((item) => item.target), effects };
}
function effect(
  effect_id: string,
  action: string,
  target: string,
  state: Effect["state"] = "planned",
  details: Record<string, unknown> = {},
): Effect {
  return { effect_id, action, target, state, details };
}
function emptyPlan(command: string): (input: Input) => MutationPlan {
  return (input) => ({ command, input, targets: [], effects: [] });
}
/**
 * Reads a requested owner as an organization, since naming the authenticated account is the
 * same request as omitting the owner and Forgejo serves that one through its own endpoint.
 *
 * Every command that accepts an owner resolves it here, so creation and forking agree on when
 * an owner is an organization and neither can drift from the other.
 *
 * @param owner Requested repository owner.
 * @param identity Login of the authenticated account.
 * @returns The owning organization, or undefined to own it as the authenticated account.
 */
function organization(owner: string | undefined, identity: string | undefined): string | undefined {
  if (!owner) return undefined;
  return identity && owner.toLowerCase() === identity.toLowerCase() ? undefined : owner;
}
function gateway(capabilities: CapabilitySet): RepositoryGateway {
  if (!capabilities.repositories) throw new Error("repository.unavailable");
  return capabilities.repositories;
}
function requireGit(capabilities: CapabilitySet) {
  if (!capabilities.git) throw new Error("git.unavailable");
  return capabilities.git;
}
function required(value: string | null | undefined): string {
  if (!value) throw new Error("repository.invalid_response");
  return value;
}
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
function contextRecord(context: RepositoryContext): Record<string, unknown> {
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));
}
function repositoryContext(context: RepositoryContext, repo: Repository): RepositoryContext {
  return {
    ...context,
    owner: repo.owner,
    name: repo.name,
    repository: repo.full_name,
    web_url: repo.web_url,
  };
}
function commandFailure(code: string, message: string, details: Record<string, unknown>) {
  return { code, message, details };
}
function partial(
  result: Repository,
  context: Record<string, unknown>,
  effects: Effect[],
  diagnostics: import("./runtime").Diagnostic[],
  code: string,
  message: string,
  next: NextStep,
) {
  const error: CommandError = { code, message, details: {} };
  return { result, context, effects, diagnostics, partial_error: error, next_steps: [next] };
}
/**
 * Describes the local Git work a partial repository outcome left undone.
 *
 * The Host side already landed, so re-issuing the leaf would re-attempt work that succeeded. What
 * remains is a `git` invocation, which is why an `invoke` step names its program instead of
 * assuming this CLI: there is no leaf that only finishes the local half.
 */
function cloneRecovery(url: string, destination: string, remote: string): NextStep {
  return { action: "invoke", argv: ["git", "clone", "--origin", remote, "--", url, destination] };
}
function remoteRecovery(source: string, remote: string, url: string): NextStep {
  return { action: "invoke", argv: ["git", "-C", source, "remote", "add", remote, url] };
}
