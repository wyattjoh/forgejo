import { z } from "zod";
import {
  deliver,
  isErrorCode,
  requireHostSession,
  wasTransmitted,
  watchUntilSettled,
  type CapabilitySet,
  type CommandDefinition,
  type CommandError,
  type Effect,
  type MutationPlan,
} from "./runtime";
import { resolveRepositoryContext, type RepositoryContext } from "./repository-context";
import type { IssuesGateway } from "./issue-gateway";
import type {
  CombinedStatus,
  MergeOutcome,
  PullRequest,
  PullRequestInput,
  PullRequestListInput,
  PullRequestsGateway,
} from "./pull-request-gateway";

const selector = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
const index = z.number().int().positive();
const page = z.number().int().positive().max(1000).default(1);
const limit = z.number().int().positive().max(100).default(30);
const duration = z.number().positive().max(3600);
const remoteName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
type Input = Record<string, unknown>;
type Resolved = {
  context: RepositoryContext;
  host: string;
  token: string;
  gateway: PullRequestsGateway;
  issues: IssuesGateway;
  git: CapabilitySet["git"];
  cwd: string;
};

/** Creates the settled v1 pull-request command catalog. */
export function createPullRequestCatalog(): CommandDefinition[] {
  return [
    read(
      "pr list",
      "List pull requests in a repository",
      scoped({
        state: z.enum(["open", "closed", "all"]).default("open"),
        base: z.string().min(1).optional(),
        head: z.string().min(1).optional(),
        author: z.string().min(1).optional(),
        label: z.array(z.string().min(1)).default([]),
        milestone: z.string().min(1).optional(),
        sort: z.string().min(1).optional(),
        page,
        limit,
        all: z.boolean().optional(),
      }),
      list,
    ),
    read(
      "pr view",
      "Show one pull request, optionally with its comments",
      scoped({ index, comments: z.boolean().optional() }),
      async (input, resolved) => {
        const item = await pull(input, resolved);
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
    mutation(
      "pr comment",
      "Add a comment to a pull request",
      scoped({ index, body: z.string().min(1) }),
      "pull_request.comment.create",
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
    ),
    read(
      "pr diff",
      "Fetch a pull request's diff or patch",
      scoped({
        index,
        patch: z.boolean().optional(),
        binary: z.boolean().optional(),
        output: z.string().min(1).optional(),
      }),
      diff,
    ),
    checkout(),
    read(
      "pr checks",
      "Report check runs for a pull request",
      scoped({
        index,
        watch: z.boolean().optional(),
        // A one-second floor bounds the loop without hammering the Host.
        interval: duration.min(1).default(5),
        timeout: duration.default(300),
      }),
      checks,
    ),
    review(),
    merge(),
  ];
}
function create(): CommandDefinition {
  const input = scoped({
    title: z.string().min(1),
    body: z.string().optional(),
    base: z.string().min(1),
    head: z.string().min(1).optional(),
    assignee: z.array(z.string().min(1)).default([]),
    label: z.array(z.string().min(1)).default([]),
    milestone: z.string().min(1).optional(),
    reviewer: z.array(z.string().min(1)).default([]),
  });
  return multi(
    "pr create",
    "Open a pull request from a head branch onto a base",
    input,
    (value) => {
      const effects = [effect("pull_request.create", "pull_request.create", String(value.title))];
      if (labels(value).length)
        effects.push(
          effect("pull_request.labels.replace", "pull_request.labels.replace", String(value.title)),
        );
      if (reviewers(value).length)
        effects.push(
          effect(
            "pull_request.reviewers.request",
            "pull_request.reviewers.request",
            String(value.title),
          ),
        );
      return effects;
    },
    async (input, resolved) => {
      const created = await resolved.gateway.create(
        resolved.host,
        resolved.token,
        owner(resolved),
        repo(resolved),
        pullInput(input),
      );
      const effects = [
        effect("pull_request.create", "pull_request.create", target(created), "succeeded"),
      ];
      const labeled = await replaceLabels(input, resolved, created, effects);
      if (labeled.partial_error || reviewers(input).length === 0) return labeled;
      try {
        await resolved.gateway.reviewers(
          resolved.host,
          resolved.token,
          owner(resolved),
          repo(resolved),
          created.index,
          reviewers(input),
        );
        return {
          ...labeled,
          effects: [
            ...(labeled.effects as Effect[]),
            effect(
              "pull_request.reviewers.request",
              "pull_request.reviewers.request",
              target(created),
              "succeeded",
            ),
          ],
        };
      } catch (error) {
        return {
          ...labeled,
          effects: [
            ...(labeled.effects as Effect[]),
            effect(
              "pull_request.reviewers.request",
              "pull_request.reviewers.request",
              target(created),
              "failed",
            ),
          ],
          partial_error: partial(
            error,
            "Pull request was created, but requesting reviewers failed",
          ),
        };
      }
    },
  );
}
function edit(): CommandDefinition {
  const input = scoped({
    index,
    title: z.string().min(1).optional(),
    body: z.string().optional(),
    base: z.string().min(1).optional(),
    assignee: z.array(z.string().min(1)).optional(),
    label: z.array(z.string().min(1)).optional(),
    milestone: z.string().min(1).optional(),
  });
  return multi(
    "pr edit",
    "Change a pull request's title, body, base, labels, or assignees",
    input,
    (value) => {
      const effects = [effect("pull_request.edit", "pull_request.edit", String(value.index))];
      if (Array.isArray(value.label))
        effects.push(
          effect("pull_request.labels.replace", "pull_request.labels.replace", String(value.index)),
        );
      return effects;
    },
    async (input, resolved) => {
      const edited = await resolved.gateway.edit(
        resolved.host,
        resolved.token,
        owner(resolved),
        repo(resolved),
        number(input.index),
        pullInput(input),
      );
      return replaceLabels(input, resolved, edited, [
        effect("pull_request.edit", "pull_request.edit", target(edited), "succeeded"),
      ]);
    },
  );
}
function checkout(): CommandDefinition {
  const input = scoped({
    index,
    branch: z.string().min(1).optional(),
    force: z.boolean().optional(),
    remote: remoteName.optional(),
  });
  return multi(
    "pr checkout",
    "Check out a pull request's head branch locally",
    input,
    // The remote is where the fetch reads from, so the plan names it before it is approved. It
    // reads null for the inferred form, which the plan cannot resolve without the working
    // directory.
    (value) => [
      effect("git.checkout", "checkout_pull_request", String(value.index), "planned", {
        remote: value.remote ?? null,
      }),
    ],
    async (value, resolved) => {
      // Remote inference runs in exactly one configuration: Human mode, no explicit repository,
      // and a working directory whose remote matches a configured Host profile. An explicit
      // remote is the only way the same Git work is reachable anywhere else, Request mode above
      // all, so it takes precedence over whatever inference found. Either way the name refers to
      // a remote of the working directory, which is where the fetch and the switch land.
      const remote = stringOrUndefined(value.remote) ?? resolved.context.remote_name;
      if (!remote)
        return {
          effects: [effect("git.checkout", "checkout_pull_request", String(value.index), "failed")],
          partial_error: {
            code: "git.remote_required",
            message: "Pull request checkout requires a Git remote",
            // Naming `--remote` to a Request-mode caller would describe argv it cannot send, and
            // this leaf can be reached by both callers.
            details: { recovery: value.__mode === "human" ? "--remote NAME" : "input.remote" },
          },
        };
      if (!resolved.git)
        return {
          effects: [
            effect("git.checkout", "checkout_pull_request", String(value.index), "failed", {
              remote,
            }),
          ],
          partial_error: {
            code: "git.unavailable",
            message: "Git checkout support is unavailable",
            details: {},
          },
        };
      const branch = stringOrUndefined(value.branch) ?? `pr-${number(value.index)}`;
      const checkedOut = await resolved.git.checkoutPull(
        resolved.cwd,
        remote,
        number(value.index),
        branch,
        value.force === true,
      );
      if (!checkedOut.ok)
        return {
          effects: [
            effect("git.checkout", "checkout_pull_request", String(value.index), "failed", {
              remote,
            }),
          ],
          diagnostics: checkedOut.diagnostics,
          partial_error: {
            code: "git.checkout_failed",
            message: "Pull request fetch or checkout failed",
            details: { branch },
          },
        };
      return {
        branch,
        effects: [
          effect("git.checkout", "checkout_pull_request", String(value.index), "succeeded", {
            remote,
          }),
        ],
        diagnostics: checkedOut.diagnostics,
      };
    },
  );
}
function review(): CommandDefinition {
  const input = scoped({
    index,
    approve: z.boolean().optional(),
    request_changes: z.boolean().optional(),
    comment: z.boolean().optional(),
    body: z.string().optional(),
  }).superRefine((value, context) => {
    if ([value.approve, value.request_changes, value.comment].filter(Boolean).length !== 1)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose exactly one review action",
      });
  });
  return mutation(
    "pr review",
    "Submit a review approving, commenting, or requesting changes",
    input,
    "pull_request.review",
    async (input, resolved) => {
      const event = input.approve
        ? "APPROVED"
        : input.request_changes
          ? "REQUEST_CHANGES"
          : "COMMENT";
      await resolved.gateway.review(
        resolved.host,
        resolved.token,
        owner(resolved),
        repo(resolved),
        number(input.index),
        event,
        stringOrUndefined(input.body),
      );
      return {};
    },
  );
}
function merge(): CommandDefinition {
  const input = scoped({
    index,
    merge: z.boolean().optional(),
    rebase: z.boolean().optional(),
    rebase_merge: z.boolean().optional(),
    squash: z.boolean().optional(),
    fast_forward_only: z.boolean().optional(),
    delete_branch: z.boolean().optional(),
    match_head: z.string().min(1).optional(),
    when_checks_succeed: z.boolean().optional(),
  }).superRefine((value, context) => {
    if (
      [value.merge, value.rebase, value.rebase_merge, value.squash, value.fast_forward_only].filter(
        Boolean,
      ).length !== 1
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Choose exactly one merge method" });
  });
  const planned = (value: Input) => mergeEffects(value, String(value.index));
  return multi(
    "pr merge",
    "Merge a pull request using exactly one merge method",
    input,
    planned,
    async (input, resolved) => {
      const method = input.merge
        ? "merge"
        : input.rebase
          ? "rebase"
          : input.rebase_merge
            ? "rebase-merge"
            : input.squash
              ? "squash"
              : "fast-forward-only";
      const target = indexTarget(input, resolved);
      let merged: MergeOutcome;
      try {
        merged = await resolved.gateway.merge(
          resolved.host,
          resolved.token,
          owner(resolved),
          repo(resolved),
          number(input.index),
          method,
          input.delete_branch === true,
          stringOrUndefined(input.match_head),
          input.when_checks_succeed === true,
        );
      } catch (error) {
        return reconcileMerge(error, input, resolved, target);
      }
      // A scheduled merge has not merged and has deleted nothing, so only the merge itself is
      // reported. Its outcome is unknown rather than planned: the Host accepted it and will run it
      // later, which is not the same as never having tried.
      if (merged.scheduled)
        return {
          scheduled: true,
          effects: [
            effect("pull_request.merge", "pull_request.merge", target, "unknown", {
              scheduled: true,
            }),
          ],
        };
      return {
        scheduled: false,
        effects: mergeEffects(input, target).map((item) => ({
          ...item,
          state: "succeeded" as const,
        })),
      };
    },
  );
}
/**
 * Reports what a failed merge call actually did, since its failure is not evidence that it did
 * nothing.
 *
 * Forgejo deletes the head branch inside the merge call, after the merge itself has landed, and
 * answers a refused deletion as the call's own failure. The statuses it answers with also cover a
 * refusal to merge at all, so the pull request is asked what happened rather than the status being
 * read as an answer it cannot give.
 *
 * Three answers rethrow instead, which leaves the executor to state the plan's own effects: a
 * failure raised before the request reached the Host, which merged nothing; a Host that will not
 * answer the question, which leaves the outcome unresolved; and an unmerged pull request under
 * `when_checks_succeed`, since that is also what a merge the Host accepted and scheduled looks
 * like.
 */
async function reconcileMerge(
  error: unknown,
  input: Input,
  resolved: Resolved,
  target: string,
): Promise<Record<string, unknown>> {
  if (!wasTransmitted(error)) throw error;
  const item = await pull(input, resolved).catch(() => undefined);
  if (item === undefined) throw error;
  if (!item.merged) {
    if (input.when_checks_succeed === true) throw error;
    throw {
      ...partial(error, "Merging the pull request failed"),
      effects: mergeEffects(input, target).map((effect) => ({
        ...effect,
        state: "failed" as const,
      })),
    };
  }
  const deleting = input.delete_branch === true;
  return {
    scheduled: false,
    effects: [
      effect("pull_request.merge", "pull_request.merge", target, "succeeded"),
      ...(deleting ? [effect("branch.delete", "branch.delete", target, "failed")] : []),
    ],
    // The read says the pull request is merged, not that this call is what merged it, so the
    // message states the state rather than narrating an attempt.
    partial_error: deleting
      ? {
          code: "pull_request.branch_delete_failed",
          message: "Pull request is merged, but its head branch was not deleted",
          details: { cause: errorCode(error) },
        }
      : partial(error, "Pull request is merged, but the merge call reported a failure"),
  };
}
/**
 * Plans the merge and, when requested, the Host-side branch deletion it performs in the same call.
 */
function mergeEffects(input: Input, target: string): Effect[] {
  const effects = [effect("pull_request.merge", "pull_request.merge", target)];
  if (input.delete_branch === true) effects.push(effect("branch.delete", "branch.delete", target));
  return effects;
}
function read(
  name: string,
  description: string,
  input: z.ZodType<Input>,
  handler: (
    input: Input,
    resolved: Resolved,
    capabilities: CapabilitySet,
  ) => Promise<Record<string, unknown>>,
): CommandDefinition {
  return {
    name,
    description,
    input,
    mutation: false,
    plan: emptyPlan(name),
    handler: async (input, capabilities) => {
      const resolved = await resolve(input, capabilities);
      return {
        result: await handler(input, resolved, capabilities),
        context: context(resolved.context),
      };
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
      const { effects, partial_error, diagnostics, ...result } = handled;
      return {
        result,
        context: context(resolved.context),
        ...(Array.isArray(effects) ? { effects: effects as Effect[] } : {}),
        ...(partial_error ? { partial_error: partial_error as CommandError } : {}),
        ...(Array.isArray(diagnostics)
          ? { diagnostics: diagnostics as import("./runtime").Diagnostic[] }
          : {}),
      };
    },
  };
}
async function list(input: Input, resolved: Resolved): Promise<Record<string, unknown>> {
  const filter = toList(input);
  const items: PullRequest[] = [];
  let current = filter.page;
  do {
    const next = await resolved.gateway.list(
      resolved.host,
      resolved.token,
      owner(resolved),
      repo(resolved),
      { ...filter, page: current },
    );
    items.push(
      ...next.filter((item) => labels(input).every((label) => item.labels.includes(label))),
    );
    if (!input.all || next.length < filter.limit || items.length >= 1000)
      return {
        items: items.slice(0, 1000),
        truncated: items.length >= 1000 && next.length === filter.limit,
      };
    current += 1;
  } while (current <= 1000);
  return { items: items.slice(0, 1000), truncated: true };
}
async function diff(
  input: Input,
  resolved: Resolved,
  capabilities: CapabilitySet,
): Promise<Record<string, unknown>> {
  const bytes = await resolved.gateway.diff(
    resolved.host,
    resolved.token,
    owner(resolved),
    repo(resolved),
    number(input.index),
    input.patch === true,
    input.binary === true,
  );
  if (input.__mode === "human")
    return {
      diff: new TextDecoder().decode(bytes),
      bytes: bytes.byteLength,
      media_type: "text/plain",
    };
  if (!capabilities.output) throw new Error("output.unavailable");
  return deliver(capabilities.output, bytes, "text/plain", stringOrUndefined(input.output));
}
async function checks(
  input: Input,
  resolved: Resolved,
  capabilities: CapabilitySet,
): Promise<Record<string, unknown>> {
  const { value, attempts } = await watchUntilSettled(
    capabilities,
    {
      watch: input.watch === true,
      interval: number(input.interval),
      timeout: number(input.timeout),
    },
    async () => {
      const item = await pull(input, resolved);
      const combined = item.head_sha
        ? await resolved.gateway.statuses(
            resolved.host,
            resolved.token,
            owner(resolved),
            repo(resolved),
            item.head_sha,
          )
        : { state: null, total_count: 0, statuses: [] };
      return { item, combined };
    },
    settledChecks,
  );
  const statuses = value.combined.statuses;
  const settled = settledChecks(value);
  return {
    pull_request: value.item,
    statuses,
    actions_runs: [],
    watching: input.watch === true,
    complete: settled,
    state: value.combined.state,
    // `complete` and `passing` answer different questions, and a caller gating a merge needs
    // both. `passing` is the verdict, read from the Host's own rollup. It deliberately mirrors
    // the Host's merge gate rather than being this CLI's own opinion: IsPullCommitStatusPass
    // answers with state.IsSuccess(), so "success" passes and every other state, "skipped"
    // included, does not. Keep the two in step, or this command answers the merge question
    // differently from the Host that decides it.
    passing: settled && value.combined.state === "success",
    total_count: value.combined.total_count,
    attempts,
  };
}
/**
 * Reports whether every check on a head has reached a state the Host will not revise.
 *
 * Settledness is read from the per-check list: "pending" is the contract's only unsettled
 * CommitStatusState, and an empty list is not settled either, because the Host writes no status
 * row until a check registers, so it means "nothing has reported yet", never "green". Watching
 * therefore runs to the timeout on a head that never gets a check. The rollup cannot stand in for
 * settledness, since it reports the worst check and so says "failure" while others still run.
 */
function settledChecks(polled: { combined: CombinedStatus }): boolean {
  const statuses = polled.combined.statuses;
  return statuses.length > 0 && !statuses.some((status) => status.state === "pending");
}
async function replaceLabels(
  value: Input,
  resolved: Resolved,
  item: PullRequest,
  effects: Effect[],
): Promise<Record<string, unknown>> {
  if (!Array.isArray(value.label) || labels(value).length === 0) return { ...item, effects };
  try {
    await resolved.issues.replaceLabels(
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
        effect(
          "pull_request.labels.replace",
          "pull_request.labels.replace",
          target(item),
          "succeeded",
        ),
      ],
    };
  } catch (error) {
    return {
      ...item,
      effects: [
        ...effects,
        effect(
          "pull_request.labels.replace",
          "pull_request.labels.replace",
          target(item),
          "failed",
        ),
      ],
      partial_error: partial(error, "Pull request was changed, but replacing labels failed"),
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
  if (!capabilities.pullRequests) throw new Error("pull_request.unavailable");
  if (!capabilities.issues) throw new Error("issue.unavailable");
  return {
    context,
    host: authenticated.profile.url,
    token: authenticated.token,
    gateway: capabilities.pullRequests,
    issues: capabilities.issues,
    git: capabilities.git,
    cwd: capabilities.cwd,
  };
}
function scoped(shape: z.ZodRawShape): z.ZodType<Input> {
  return z
    .object({ host: z.string().min(1).optional(), repo: selector.optional(), ...shape })
    .strict();
}
function toList(input: Input): PullRequestListInput {
  return {
    state: input.state === "closed" || input.state === "all" ? input.state : "open",
    base: stringOrUndefined(input.base),
    head: stringOrUndefined(input.head),
    author: stringOrUndefined(input.author),
    milestone: stringOrUndefined(input.milestone),
    sort: stringOrUndefined(input.sort),
    page: number(input.page),
    limit: number(input.limit),
  };
}
function pullInput(input: Input): PullRequestInput {
  return {
    title: stringOrUndefined(input.title),
    body: stringOrUndefined(input.body),
    base: stringOrUndefined(input.base),
    head: stringOrUndefined(input.head),
    assignees: Array.isArray(input.assignee) ? strings(input.assignee) : undefined,
    milestone: stringOrUndefined(input.milestone),
  };
}
function pull(input: Input, resolved: Resolved): Promise<PullRequest> {
  return resolved.gateway.get(
    resolved.host,
    resolved.token,
    owner(resolved),
    repo(resolved),
    number(input.index),
  );
}
function owner(resolved: Resolved): string {
  return required(resolved.context.owner);
}
function repo(resolved: Resolved): string {
  return required(resolved.context.name);
}
function target(item: PullRequest): string {
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
  details: Record<string, unknown> = {},
): Effect {
  return { effect_id, action, target, state, details };
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
function reviewers(value: Input): string[] {
  return strings(value.reviewer);
}
function partial(error: unknown, message: string): CommandError {
  return { code: errorCode(error), message, details: {} };
}
/**
 * Reads the code a failure reports, whichever of the two shapes it arrived in.
 *
 * A bare `Error` carries its code as the message, while a typed failure carries an explicit
 * `code` and is the only shape that can also carry details. Reading only the message turned every
 * typed failure reaching a merge reconciliation into a generic request failure, which is how a
 * caller told that a merge landed lost the reason the call reported one.
 */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (isErrorCode(code)) return code;
  return error instanceof Error && isErrorCode(error.message)
    ? error.message
    : "pull_request.request_failed";
}
