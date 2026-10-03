import { z } from "zod";
import {
  isErrorCode,
  requireHostSession,
  type CapabilitySet,
  type CommandDefinition,
  type CommandError,
  type Effect,
  type MutationPlan,
} from "./runtime";
import { resolveRepositoryContext, type RepositoryContext } from "./repository-context";
import type { Issue, IssueInput, IssueListInput, IssuesGateway } from "./issue-gateway";

const selector = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
const index = z.number().int().positive();
const page = z.number().int().positive().max(1000).default(1);
const limit = z.number().int().positive().max(100).default(30);
type Input = Record<string, unknown>;
type Resolved = { context: RepositoryContext; host: string; token: string; gateway: IssuesGateway };

/** Creates the settled v1 issue command catalog. */
export function createIssueCatalog(): CommandDefinition[] {
  return [
    read("issue list", "List issues in a repository", listInput(), async (input, resolved) =>
      list(input, resolved),
    ),
    read(
      "issue view",
      "Show one issue, optionally with its comments",
      scoped({ index, comments: z.boolean().optional() }),
      async (input, resolved) => {
        const item = await issue(input, resolved);
        return input.comments
          ? {
              ...item,
              comments: await resolved.gateway.comments(
                resolved.host,
                resolved.token,
                owner(resolved),
                repo(resolved),
                number(input.index),
              ),
            }
          : item;
      },
    ),
    create(),
    edit(),
    state("issue close", "Close an issue", "closed"),
    state("issue reopen", "Reopen a closed issue", "open"),
    comment(),
    mutation(
      "issue delete",
      "Permanently delete an issue",
      scoped({ index }),
      "issue.delete",
      async (input, resolved) => {
        await resolved.gateway.remove(
          resolved.host,
          resolved.token,
          owner(resolved),
          repo(resolved),
          number(input.index),
        );
        return {};
      },
    ),
    pin("issue pin", "Pin an issue to the top of the list", true),
    pin("issue unpin", "Remove an issue's pin", false),
    read(
      "issue status",
      "Summarize open issues in a repository",
      scoped({}),
      async (input, resolved) => {
        const items = await resolved.gateway.list(
          resolved.host,
          resolved.token,
          owner(resolved),
          repo(resolved),
          { ...toList(input), state: "open", assignees: [] },
        );
        return { open: items.length, items };
      },
    ),
  ];
}
function listInput(): z.ZodType<Input> {
  return scoped({
    state: z.enum(["open", "closed", "all"]).default("open"),
    label: z.array(z.string().min(1)).default([]),
    assignee: z.array(z.string().min(1)).default([]),
    author: z.string().min(1).optional(),
    mention: z.string().min(1).optional(),
    milestone: z.string().min(1).optional(),
    search: z.string().min(1).optional(),
    type: z.enum(["issues", "pulls"]).optional(),
    sort: z.string().min(1).optional(),
    page,
    limit,
    all: z.boolean().optional(),
  });
}
function create(): CommandDefinition {
  const input = scoped({
    title: z.string().min(1),
    body: z.string().optional(),
    assignee: z.array(z.string().min(1)).default([]),
    label: z.array(z.string().min(1)).default([]),
    milestone: z.string().min(1).optional(),
    due_date: z.string().min(1).optional(),
  });
  return multi(
    "issue create",
    "Open an issue, with optional labels and assignees",
    input,
    (value) =>
      labels(value).length
        ? [
            effect("issue.create", "issue.create", String(value.title)),
            effect("issue.labels.replace", "issue.labels.replace", String(value.title)),
          ]
        : [effect("issue.create", "issue.create", String(value.title))],
    async (value, resolved) => {
      const created = await resolved.gateway.create(
        resolved.host,
        resolved.token,
        owner(resolved),
        repo(resolved),
        issueInput(value),
      );
      const effects = [effect("issue.create", "issue.create", target(created), "succeeded")];
      return replaceLabels(value, resolved, created, effects);
    },
  );
}
function edit(): CommandDefinition {
  const input = scoped({
    index,
    title: z.string().min(1).optional(),
    body: z.string().optional(),
    assignee: z.array(z.string().min(1)).optional(),
    label: z.array(z.string().min(1)).optional(),
    milestone: z.string().min(1).optional(),
    due_date: z.string().min(1).optional(),
  }).superRefine((value, context) => {
    if (Object.keys(value).every((key) => ["host", "repo", "index"].includes(key)))
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected an issue change" });
  });
  return multi(
    "issue edit",
    "Change an issue's title, body, labels, assignees, or due date",
    input,
    (value) => {
      const effects = [effect("issue.edit", "issue.edit", String(value.index))];
      if (Array.isArray(value.label))
        effects.push(effect("issue.labels.replace", "issue.labels.replace", String(value.index)));
      return effects;
    },
    async (value, resolved) => {
      const edited = await resolved.gateway.edit(
        resolved.host,
        resolved.token,
        owner(resolved),
        repo(resolved),
        number(value.index),
        issueInput(value),
      );
      return replaceLabels(value, resolved, edited, [
        effect("issue.edit", "issue.edit", target(edited), "succeeded"),
      ]);
    },
  );
}
function state(name: string, description: string, next: "open" | "closed"): CommandDefinition {
  return mutation(name, description, scoped({ index }), `issue.${next}`, async (input, resolved) =>
    resolved.gateway.edit(
      resolved.host,
      resolved.token,
      owner(resolved),
      repo(resolved),
      number(input.index),
      {
        title: undefined,
        body: undefined,
        assignees: undefined,
        milestone: undefined,
        dueDate: undefined,
        state: next,
      },
    ),
  );
}
function comment(): CommandDefinition {
  return mutation(
    "issue comment",
    "Add a comment to an issue",
    scoped({ index, body: z.string().min(1) }),
    "issue.comment.create",
    async (input, resolved) => ({
      comment: await resolved.gateway.comment(
        resolved.host,
        resolved.token,
        owner(resolved),
        repo(resolved),
        number(input.index),
        String(input.body),
      ),
    }),
  );
}
function pin(name: string, description: string, pinned: boolean): CommandDefinition {
  return mutation(
    name,
    description,
    scoped({ index }),
    pinned ? "issue.pin" : "issue.unpin",
    async (input, resolved) => {
      await resolved.gateway.pin(
        resolved.host,
        resolved.token,
        owner(resolved),
        repo(resolved),
        number(input.index),
        pinned,
      );
      return {};
    },
  );
}
function read(
  name: string,
  description: string,
  input: z.ZodType<Input>,
  handler: (input: Input, resolved: Resolved) => Promise<Record<string, unknown>>,
): CommandDefinition {
  return {
    name,
    description,
    input,
    mutation: false,
    plan: emptyPlan(name),
    handler: async (input, capabilities) => {
      const resolved = await resolve(input, capabilities);
      return { result: await handler(input, resolved), context: context(resolved.context) };
    },
  };
}
function mutation(
  name: string,
  description: string,
  input: z.ZodType<Input>,
  action: string,
  handler: (input: Input, resolved: Resolved) => Promise<Record<string, unknown>>,
): CommandDefinition {
  return multi(
    name,
    description,
    input,
    (value) => [effect(action, action, String(value.index))],
    async (input, resolved) => {
      const outcome = await handler(input, resolved);
      // Append rather than assign, so a handler that reports its own extra effect keeps it
      // instead of having it silently dropped here.
      return {
        ...outcome,
        effects: [
          ...(Array.isArray(outcome.effects) ? (outcome.effects as Effect[]) : []),
          effect(action, action, indexTarget(input, resolved), "succeeded"),
        ],
      };
    },
  );
}
function multi(
  name: string,
  description: string,
  input: z.ZodType<Input>,
  planned: (input: Input) => Effect[],
  handler: (input: Input, resolved: Resolved) => Promise<Record<string, unknown>>,
): CommandDefinition {
  return {
    name,
    description,
    input,
    mutation: true,
    plan: (input) => ({
      command: name,
      input,
      targets: planned(input).map((item) => item.target),
      effects: planned(input),
    }),
    handler: async (input, capabilities) => {
      const resolved = await resolve(input, capabilities);
      const handled = await handler(input, resolved);
      const { effects, partial_error, ...result } = handled;
      return {
        result,
        context: context(resolved.context),
        ...(Array.isArray(effects) ? { effects: effects as Effect[] } : {}),
        ...(partial_error ? { partial_error: partial_error as CommandError } : {}),
      };
    },
  };
}
async function list(input: Input, resolved: Resolved): Promise<Record<string, unknown>> {
  const filter = toList(input);
  const items: Issue[] = [];
  let current = filter.page;
  do {
    const next = await resolved.gateway.list(
      resolved.host,
      resolved.token,
      owner(resolved),
      repo(resolved),
      { ...filter, page: current },
    );
    items.push(...next);
    if (!input.all || next.length < filter.limit || items.length >= 1000)
      return {
        items: items.slice(0, 1000),
        truncated: items.length >= 1000 && next.length === filter.limit,
      };
    current += 1;
  } while (current <= 1000);
  return { items: items.slice(0, 1000), truncated: true };
}
async function replaceLabels(
  value: Input,
  resolved: Resolved,
  item: Issue,
  effects: Effect[],
): Promise<Record<string, unknown>> {
  if (!Array.isArray(value.label) || labels(value).length === 0) return { ...item, effects };
  try {
    await resolved.gateway.replaceLabels(
      resolved.host,
      resolved.token,
      owner(resolved),
      repo(resolved),
      item.index,
      labels(value),
    );
    return {
      ...item,
      effects: [
        ...effects,
        effect("issue.labels.replace", "issue.labels.replace", target(item), "succeeded"),
      ],
    };
  } catch (error) {
    return {
      ...item,
      effects: [
        ...effects,
        effect("issue.labels.replace", "issue.labels.replace", target(item), "failed"),
      ],
      partial_error: failure(error),
    };
  }
}
async function resolve(input: Input, capabilities: CapabilitySet): Promise<Resolved> {
  const context = await resolveRepositoryContext(
    {
      host: stringOrUndefined(input.host),
      repo: stringOrUndefined(input.repo),
      environmentHost: capabilities.environment.FORGEJO_HOST,
      cwd: capabilities.cwd,
      requestMode: input.__mode === "request",
      requireRepository: true,
    },
    await requireHostSession(capabilities).profiles(),
    capabilities.git,
  );
  const authenticated = await requireHostSession(capabilities).authenticated(
    context.deployment_url,
    capabilities.keychainNoUi ?? true,
  );
  if (!capabilities.issues) throw new Error("issue.unavailable");
  return {
    context,
    host: authenticated.profile.url,
    token: authenticated.token,
    gateway: capabilities.issues,
  };
}
function scoped(shape: z.ZodRawShape): z.ZodType<Input> {
  return z
    .object({ host: z.string().min(1).optional(), repo: selector.optional(), ...shape })
    .strict();
}
function toList(input: Input): IssueListInput {
  return {
    state: input.state === "closed" || input.state === "all" ? input.state : "open",
    labels: labels(input),
    assignees: strings(input.assignee),
    author: stringOrUndefined(input.author),
    mention: stringOrUndefined(input.mention),
    milestone: stringOrUndefined(input.milestone),
    search: stringOrUndefined(input.search),
    type: input.type === "issues" || input.type === "pulls" ? input.type : undefined,
    sort: stringOrUndefined(input.sort),
    page: number(input.page),
    limit: number(input.limit),
  };
}
function issueInput(input: Input): IssueInput {
  return {
    title: stringOrUndefined(input.title),
    body: stringOrUndefined(input.body),
    assignees: Array.isArray(input.assignee) ? strings(input.assignee) : undefined,
    milestone: stringOrUndefined(input.milestone),
    dueDate: stringOrUndefined(input.due_date),
    state: undefined,
  };
}
function owner(resolved: Resolved): string {
  return required(resolved.context.owner);
}
function repo(resolved: Resolved): string {
  return required(resolved.context.name);
}
function issue(input: Input, resolved: Resolved): Promise<Issue> {
  return resolved.gateway.get(
    resolved.host,
    resolved.token,
    owner(resolved),
    repo(resolved),
    number(input.index),
  );
}
function target(item: Issue): string {
  return `${item.repository}#${item.index}`;
}
function indexTarget(input: Input, resolved: Resolved): string {
  return `${owner(resolved)}/${repo(resolved)}#${number(input.index)}`;
}
function effect(
  effect_id: string,
  action: string,
  target: string,
  state: Effect["state"] = "planned",
): Effect {
  return { effect_id, action, target, state, details: {} };
}
function emptyPlan(command: string): (input: Input) => MutationPlan {
  return (input) => ({ command, input, targets: [], effects: [] });
}
function context(value: RepositoryContext): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
function required(value: string | undefined): string {
  if (!value) throw new Error("repo.required");
  return value;
}
function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function labels(value: Input): string[] {
  return strings(value.label);
}
function failure(error: unknown): CommandError {
  const code =
    error instanceof Error && isErrorCode(error.message) ? error.message : "issue.request_failed";
  return { code, message: "Issue was changed, but a later effect failed", details: {} };
}
