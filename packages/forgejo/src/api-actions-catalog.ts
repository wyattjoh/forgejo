import { z } from "zod";
import type { ActionArtifact, ActionJob, ActionRun, ActionsGateway } from "./actions-gateway";
import type { RawApiGateway } from "./raw-api-gateway";
import type { WorkflowGateway } from "./workflow-gateway";
import {
  deliver,
  deliverStream,
  isErrorCode,
  requireHostSession,
  watchUntilSettled,
  type CapabilitySet,
  type CommandDefinition,
  type CommandError,
  type Diagnostic,
  type Effect,
  type NextStep,
} from "./runtime";
import { resolveRepositoryContext, type RepositoryContext } from "./repository-context";
import { markTransmitted } from "./infrastructure";

// The advertised contract keys its path templates beneath this base path, and the raw gateway
// re-anchors every request there, so endpoints are compared with the prefix removed.
const apiBasePath = "/api/v1";
const pathParameter = /^\{[^{}]+\}$/;
const page = z.number().int().positive().max(1000).default(1);
const limit = z.number().int().positive().max(100).default(30);
const runId = z.number().int().positive();
const selector = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
const runSelector = z.union([
  z.object({ kind: z.literal("id"), value: runId }).strict(),
  z.object({ kind: z.literal("number"), value: runId }).strict(),
]);
const jobSelector = z.union([
  z.object({ kind: z.literal("id"), value: runId }).strict(),
  z.object({ kind: z.literal("name"), value: z.string().min(1) }).strict(),
]);
type Input = Record<string, unknown>;
type Resolved = {
  context: RepositoryContext;
  host: string;
  token: string;
  actions: ActionsGateway;
};

/**
 * Creates selected raw API, local workflow, and Actions run command entries.
 */
export function createApiActionsCatalog(): CommandDefinition[] {
  return [
    api(),
    workflowList(),
    workflowView(),
    workflowRun(),
    runList(),
    runView(),
    runCancel(),
    runDelete(),
    runDownload(),
    runWatch(),
    runRerun(),
  ];
}
function api(): CommandDefinition {
  const input = z
    .object({
      host: z.string().min(1).optional(),
      endpoint: z.string().min(1),
      method: z.string().toUpperCase().default("GET"),
      header: z.array(z.string().min(3)).default([]),
      raw_field: z.array(z.string().min(3)).default([]),
      field: z.array(z.string().min(3)).default([]),
      input: z.union([z.string(), z.instanceof(Uint8Array)]).optional(),
      // Raw API calls must not acquire pagination parameters when callers omit them.
      page: page.unwrap().optional(),
      limit: limit.unwrap().optional(),
      all: z.boolean().optional(),
      include: z.boolean().optional(),
      output: z.string().min(1).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (!validPath(value.endpoint))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Endpoint must be a path such as /version or /api/v1/version",
        });
      if (unservedMethod(value.method))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${value.method} reaches no advertised operation, since the contract declares none under it`,
          params: { code: "api.method_unsupported" },
        });
      else if (!acceptedMethod(value.method))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Method is not a supported REST method",
        });
      if (value.all && writeMethod(value.method))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "--all is only supported for GET requests",
        });
      if (value.input !== undefined && (value.field.length || value.raw_field.length))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "--input and field flags are mutually exclusive",
        });
    });
  return {
    name: "api",
    description: "Call an advertised Forgejo API operation directly",
    input,
    mutation: false,
    requiresApproval: (value) => writeMethod(String(value.method)),
    plan: (value) => ({
      command: "api",
      input: value,
      targets: [String(value.endpoint)],
      effects: writeMethod(String(value.method))
        ? [effect("api.request", "api.request", String(value.endpoint))]
        : [],
    }),
    handler: async (value, capabilities) => {
      const context = await rawContext(value, capabilities);
      const swagger = await requireHostSession(capabilities).advertisedSwagger(
        context.host,
        capabilities.keychainNoUi ?? true,
      );
      const operation = rawOperation(swagger, String(value.endpoint), String(value.method));
      const payload = body(value);
      const headers = withDefaultContentType(parseHeaders(strings(value.header)), value, payload);
      const call = (currentPage: number | undefined) =>
        raw(capabilities).call(
          context.host,
          context.token,
          path(String(value.endpoint), currentPage, value.limit),
          {
            method: String(value.method),
            headers,
            ...(payload === undefined ? {} : { body: inputBody(payload) }),
          },
        );
      const response = await call(typeof value.page === "number" ? value.page : undefined);
      // Everything past here reads an answer the Host has already given, so a requested write has
      // landed by now and its effect must not report as never attempted.
      const answered = <E>(error: E): E => markTransmitted(error, { method: String(value.method) });
      if (!operationAccepts(operation, response.status))
        throw answered(
          selectorError(
            "api.unexpected_response",
            "Response status is absent from advertised Swagger",
            // The Host answered with something its own contract does not describe, so nothing here
            // knows what a caller should do about it and no step is invented to say otherwise.
            { details: { status: response.status }, next_steps: [] },
          ),
        );
      const bodiless = response.body.byteLength === 0;
      const binary =
        !bodiless && !/^(?:application\/(?:json|[^;]+\+json)|text\/)/i.test(response.media_type);
      if (binary && value.output === undefined) throw answered(new Error("api.output_required"));
      let responseBody: unknown = bodiless
        ? null
        : binary
          ? // Delivering the bytes is local work over an answer the Host already gave, so an
            // unwritable destination must not read as a write that never happened either.
            await delivery(
              capabilities,
              response.body,
              response.media_type,
              string(value.output),
            ).catch((error: unknown) => {
              throw answered(error);
            })
          : decodeJsonOrText(response.body);
      let truncated = false;
      if (value.all) {
        if (!Array.isArray(responseBody)) throw answered(new Error("api.all_requires_array"));
        const items = [...responseBody];
        let last = responseBody;
        const size = typeof value.limit === "number" ? value.limit : 30;
        let current = (typeof value.page === "number" ? value.page : 1) + 1;
        while (items.length < 1000 && last.length === size) {
          const next = await call(current);
          if (!/^application\/(?:json|[^;]+\+json)/i.test(next.media_type))
            throw answered(new Error("api.all_requires_array"));
          const decoded = decodeJsonOrText(next.body);
          if (!Array.isArray(decoded)) throw answered(new Error("api.all_requires_array"));
          last = decoded;
          items.push(...decoded);
          current += 1;
        }
        truncated = items.length >= 1000 && last.length === size;
        responseBody = items.slice(0, 1000);
      }
      return {
        result: {
          status: response.status,
          headers: value.include ? response.headers : {},
          body: responseBody,
          ...(value.all ? { truncated } : {}),
        },
        context: rawContextRecord(context),
        // An advertised status is not necessarily a successful one. A write answered 4xx changed
        // nothing, so its effect must not read as though the write landed.
        effects: writeMethod(String(value.method))
          ? [
              effect(
                "api.request",
                "api.request",
                String(value.endpoint),
                response.status >= 200 && response.status < 300 ? "succeeded" : "failed",
              ),
            ]
          : [],
      };
    },
  };
}
function workflowList(): CommandDefinition {
  return local(
    "workflow list",
    "List workflow files in the local working directory",
    z.object({}).strict(),
    async (_value, capabilities) => ({
      source: "local",
      workflows: (await workflows(capabilities).list(capabilities.cwd)).map(({ name, path }) => ({
        name,
        path,
      })),
    }),
  );
}
function workflowView(): CommandDefinition {
  return local(
    "workflow view",
    "Show a workflow file from the local working directory",
    z.object({ workflow: z.string().min(1) }).strict(),
    async (value, capabilities) => ({
      source: "local",
      workflow: await workflows(capabilities).get(capabilities.cwd, String(value.workflow)),
    }),
  );
}
function workflowRun(): CommandDefinition {
  const input = scoped({
    workflow: z.string().min(1),
    ref: z.string().min(1),
    // The contract declares dispatch inputs as a map of strings, so `field` is the only form and
    // it never interprets its value. `raw_field` exists on `api`, whose body is arbitrary JSON.
    field: z.array(z.string().min(3)).default([]),
    watch: z.boolean().optional(),
    // A one-second floor bounds the loop without hammering the Host.
    interval: duration.min(1).default(5),
    timeout: duration.default(300),
  });
  return mutation(
    "workflow run",
    "Dispatch a workflow on the Host",
    input,
    (value) => [effect("workflow.dispatch", "workflow.dispatch", String(value.workflow))],
    // Dispatch is a Host-side operation, so it never reads the local working directory. The
    // workflow inspection commands are the local ones, and the Host answers not-found itself.
    async (value, resolved, capabilities) => {
      const created = await resolved.actions.dispatch(
        resolved.host,
        resolved.token,
        owner(resolved),
        repo(resolved),
        String(value.workflow),
        String(value.ref),
        dispatchInputs(value),
      );
      if (!created) return { run: null, watching: false, complete: false, attempts: 0 };
      if (value.watch !== true)
        return { run: created, watching: false, complete: complete(created), attempts: 1 };
      try {
        return await watch(created, value, resolved, capabilities);
      } catch (error) {
        // The run is already queued, so a failed poll must not report the dispatch as unfinished.
        // Re-dispatching on that reading would queue the job a second time.
        return {
          run: created,
          watching: false,
          complete: false,
          attempts: 1,
          partial_error: partial(error, "Workflow was dispatched, but watching its run failed"),
        };
      }
    },
  );
}
function runList(): CommandDefinition {
  const input = scoped({
    workflow: z.string().min(1).optional(),
    event: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
    commit: z.string().min(1).optional(),
    run_number: runId.optional(),
    page,
    limit,
    all: z.boolean().optional(),
  });
  return read("run list", "List Actions runs in a repository", input, async (value, resolved) => {
    const ref = qualifyRef(string(value.ref));
    const items: ActionRun[] = [];
    let current = number(value.page);
    while (items.length < 1000) {
      const next = await resolved.actions.list(
        resolved.host,
        resolved.token,
        owner(resolved),
        repo(resolved),
        {
          page: current,
          limit: number(value.limit),
          workflow: string(value.workflow),
          event: string(value.event),
          status: string(value.status),
          ref,
          commit: string(value.commit),
          run_number: typeof value.run_number === "number" ? value.run_number : undefined,
        },
      );
      items.push(...next);
      if (!value.all || next.length < number(value.limit)) break;
      current++;
    }
    return {
      items: items.slice(0, 1000),
      truncated: items.length >= 1000,
      ...(ref === undefined ? {} : { ref }),
    };
  });
}
function runView(): CommandDefinition {
  const input = scoped({
    run: runSelector,
    job: jobSelector.optional(),
    log: z.boolean().optional(),
    log_failed: z.boolean().optional(),
    output: z.string().min(1).optional(),
  }).superRefine((value, context) => {
    if (value.log && value.log_failed)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "--log and --log-failed are mutually exclusive",
      });
    // --log-failed selects the failed jobs itself, so a job selector would be silently discarded.
    if (value.job && value.log_failed)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "--job and --log-failed are mutually exclusive",
      });
  });
  return read(
    "run view",
    "Show one Actions run, optionally with job logs",
    input,
    async (value, resolved, capabilities) => {
      const selected = await resolveRun(value, resolved);
      const jobs = await resolved.actions.jobs(
        resolved.host,
        resolved.token,
        owner(resolved),
        repo(resolved),
        selected.id,
      );
      const chosen = value.job ? selectJob(value.job, jobs) : undefined;
      if (!value.log && !value.log_failed)
        return { ...selected, jobs, ...(chosen ? { job: chosen } : {}) };
      // Forgejo has no job-level conclusion; a failed job reports `failure` as its status.
      const logJobs = value.log_failed
        ? jobs.filter((item) => item.status === "failure")
        : chosen
          ? [chosen]
          : jobs;
      if (value.log && chosen === undefined)
        return streamedDelivery(
          capabilities,
          await resolved.actions.logs(
            resolved.host,
            resolved.token,
            owner(resolved),
            repo(resolved),
            selected.id,
          ),
          "application/zip",
          string(value.output),
        );
      const logs = await Promise.all(
        logJobs.map(async (item) => ({
          job: item,
          log: await streamedDelivery(
            capabilities,
            await resolved.actions.jobLogs(
              resolved.host,
              resolved.token,
              owner(resolved),
              repo(resolved),
              item.id,
            ),
            "text/plain",
            string(value.output),
          ),
        })),
      );
      return { run: selected, logs };
    },
  );
}
function runCancel(): CommandDefinition {
  return runMutation(
    "run cancel",
    "Cancel an in-progress Actions run",
    "run.cancel",
    async (run, resolved) => {
      await resolved.actions.cancel(
        resolved.host,
        resolved.token,
        owner(resolved),
        repo(resolved),
        run.id,
      );
      return {};
    },
  );
}
function runDelete(): CommandDefinition {
  return runMutation(
    "run delete",
    "Delete an Actions run and its logs",
    "run.delete",
    async (run, resolved) => {
      await resolved.actions.remove(
        resolved.host,
        resolved.token,
        owner(resolved),
        repo(resolved),
        run.id,
      );
      return {};
    },
  );
}
function runDownload(): CommandDefinition {
  const input = scoped({
    run: runSelector,
    artifact: z.array(z.string().min(1)).min(1),
    dir: z.string().min(1),
  });
  return mutation(
    "run download",
    "Download an Actions run's artifacts",
    input,
    (value) => [effect("artifact.download", "artifact.download", JSON.stringify(value.artifact))],
    async (value, resolved, capabilities) => {
      const run = await resolveRun(value, resolved);
      const available = await resolved.actions.artifacts(
        resolved.host,
        resolved.token,
        owner(resolved),
        repo(resolved),
        run.id,
        undefined,
      );
      // Every selector resolves before the first download, because the ledger declares one
      // `artifact.download` effect for the whole list and so cannot report that some of the
      // requested artifacts landed and some did not.
      const selected = strings(value.artifact).map((requested) =>
        selectArtifact(requested, available),
      );
      const result = [];
      for (const item of selected) {
        result.push({
          artifact: item,
          ...(await streamedDelivery(
            capabilities,
            await resolved.actions.downloadArtifact(
              resolved.host,
              resolved.token,
              owner(resolved),
              repo(resolved),
              item.id,
            ),
            "application/zip",
            `${String(value.dir).replace(/\/$/, "")}/${safeName(item.name)}.zip`,
          )),
        });
      }
      return { run, artifacts: result };
    },
  );
}
function runWatch(): CommandDefinition {
  return read(
    "run watch",
    "Poll an Actions run until it settles",
    scoped({
      run: runSelector,
      // A one-second floor bounds the loop without hammering the Host.
      interval: duration.min(1).default(5),
      timeout: duration.default(300),
      exit_status: z.boolean().optional(),
    }),
    async (value, resolved, capabilities) =>
      watch(await resolveRun(value, resolved), value, resolved, capabilities),
  );
}
function runRerun(): CommandDefinition {
  const input = scoped({ run: runSelector, job: jobSelector.optional() });
  const planned = (value: Input) => [
    effect("actions.rerun", "actions.rerun", JSON.stringify(value.run), "planned", {
      required_capability: "actions-rerun@1",
    }),
  ];
  return {
    name: "run rerun",
    description: "Rerun an Actions run, which needs a Host extension",
    input,
    mutation: true,
    preflightBeforeApproval: true,
    plan: (value) => ({
      command: "run rerun",
      input: value,
      targets: planned(value).map((item) => item.target),
      effects: planned(value),
    }),
    preflight: async (value, capabilities) => {
      const resolved = await resolve(value, capabilities);
      const target = await rerunTarget(value, resolved);
      return { result: target, context: context(resolved.context) };
    },
    handler: async (value, capabilities) => {
      const resolved = await resolve(value, capabilities);
      const target = await rerunTarget(value, resolved);
      const result = await resolved.actions.rerun(
        resolved.host,
        resolved.token,
        owner(resolved),
        repo(resolved),
        target.run.id,
        target.job?.id,
      );
      return {
        result: { ...result, resolved: target },
        context: context(resolved.context),
        effects: planned(value).map((item) => ({ ...item, state: "succeeded" as const })),
      };
    },
  };
}
async function rerunTarget(
  value: Input,
  resolved: Resolved,
): Promise<{ run: ActionRun; job: ActionJob | null }> {
  const run = await resolveRun(value, resolved);
  const jobs = await resolved.actions.jobs(
    resolved.host,
    resolved.token,
    owner(resolved),
    repo(resolved),
    run.id,
  );
  const selected = value.job ? selectJob(value.job, jobs) : undefined;
  const capability = await resolved.actions.rerunCapability(resolved.host, resolved.token);
  if (
    !capability ||
    capability.name !== "actions-rerun" ||
    capability.version !== 1 ||
    !capability.routes.includes("run") ||
    !capability.routes.includes("job")
  )
    throw selectorError(
      "capability.unsupported",
      "This Host does not provide the required Actions rerun extension",
      // A Host that lacks the extension cannot be talked into it by re-issuing anything, so this
      // one carries no step: dispatching a fresh run is a different command with different
      // effects, and offering it as a recovery would invent one this failure does not have.
      { details: { required: "actions-rerun@1", next: "workflow run" }, next_steps: [] },
    );
  return { run, job: selected ?? null };
}
function runMutation(
  name: string,
  description: string,
  action: string,
  handler: (run: ActionRun, resolved: Resolved) => Promise<Record<string, unknown>>,
): CommandDefinition {
  return mutation(
    name,
    description,
    scoped({ run: runSelector }),
    (value) => [effect(action, action, JSON.stringify(value.run))],
    async (value, resolved) => handler(await resolveRun(value, resolved), resolved),
  );
}
function read(
  name: string,
  description: string,
  input: z.ZodType<Input>,
  handler: (
    value: Input,
    resolved: Resolved,
    capabilities: CapabilitySet,
  ) => Promise<Record<string, unknown>>,
): CommandDefinition {
  return {
    name,
    description,
    input,
    mutation: false,
    plan: (value) => ({ command: name, input: value, targets: [], effects: [] }),
    handler: async (value, capabilities) => {
      const resolved = await resolve(value, capabilities);
      return {
        result: await handler(value, resolved, capabilities),
        context: context(resolved.context),
      };
    },
  };
}
function mutation(
  name: string,
  description: string,
  input: z.ZodType<Input>,
  planned: (value: Input) => Effect[],
  handler: (
    value: Input,
    resolved: Resolved,
    capabilities: CapabilitySet,
  ) => Promise<Record<string, unknown>>,
): CommandDefinition {
  return {
    name,
    description,
    input,
    mutation: true,
    plan: (value) => ({
      command: name,
      input: value,
      targets: planned(value).map((item) => item.target),
      effects: planned(value),
    }),
    handler: async (value, capabilities) => {
      const resolved = await resolve(value, capabilities);
      const handled = await handler(value, resolved, capabilities);
      // A handler may report its own effects and an explicit partial failure, so an effect that
      // already landed stays visible when a later step fails.
      const { effects, partial_error, diagnostics, ...result } = handled;
      return {
        result,
        context: context(resolved.context),
        effects: Array.isArray(effects)
          ? (effects as Effect[])
          : planned(value).map((item) => ({ ...item, state: "succeeded" as const })),
        ...(partial_error ? { partial_error: partial_error as CommandError } : {}),
        ...(Array.isArray(diagnostics) ? { diagnostics: diagnostics as Diagnostic[] } : {}),
      };
    },
  };
}
function local(
  name: string,
  description: string,
  input: z.ZodType<Input>,
  handler: (value: Input, capabilities: CapabilitySet) => Promise<Record<string, unknown>>,
): CommandDefinition {
  return {
    name,
    description,
    input,
    mutation: false,
    plan: (value) => ({ command: name, input: value, targets: [], effects: [] }),
    handler: async (value, capabilities) => ({ result: await handler(value, capabilities) }),
  };
}
function scoped(shape: z.ZodRawShape): z.ZodType<Input> {
  return z
    .object({ host: z.string().min(1).optional(), repo: selector.optional(), ...shape })
    .strict();
}
async function resolve(value: Input, capabilities: CapabilitySet): Promise<Resolved> {
  const context = await resolveRepositoryContext(
    {
      host: string(value.host),
      repo: string(value.repo),
      environmentHost: capabilities.environment.FORGEJO_HOST,
      cwd: capabilities.cwd,
      requestMode: value.__mode === "request",
      requireRepository: true,
    },
    await requireHostSession(capabilities).profiles(),
    capabilities.git,
  );
  const authenticated = await requireHostSession(capabilities).authenticated(
    context.deployment_url,
    capabilities.keychainNoUi ?? true,
  );
  if (!capabilities.actions) throw new Error("actions.unavailable");
  return {
    context,
    host: authenticated.profile.url,
    token: authenticated.token,
    actions: capabilities.actions,
  };
}
async function rawContext(
  value: Input,
  capabilities: CapabilitySet,
): Promise<{ host: string; token: string }> {
  const context = await resolveRepositoryContext(
    {
      host: string(value.host),
      repo: undefined,
      environmentHost: undefined,
      cwd: capabilities.cwd,
      requestMode: true,
      requireRepository: false,
    },
    await requireHostSession(capabilities).profiles(),
    capabilities.git,
  );
  const authenticated = await requireHostSession(capabilities).authenticated(
    context.deployment_url,
    capabilities.keychainNoUi ?? true,
  );
  return { host: authenticated.profile.url, token: authenticated.token };
}
async function resolveRun(value: Input, resolved: Resolved): Promise<ActionRun> {
  const selector = value.run as { kind: "id" | "number"; value: number };
  if (selector.kind === "id")
    return resolved.actions.get(
      resolved.host,
      resolved.token,
      owner(resolved),
      repo(resolved),
      selector.value,
    );
  const candidates = await resolved.actions.list(
    resolved.host,
    resolved.token,
    owner(resolved),
    repo(resolved),
    {
      page: 1,
      limit: 100,
      workflow: undefined,
      event: undefined,
      status: undefined,
      ref: undefined,
      commit: undefined,
      run_number: selector.value,
    },
  );
  if (candidates.length !== 1)
    // The Host filtered the listing by run number, so the runs it returned are the matches and the
    // available runs both. An absent run therefore carries no candidates, which is the one branch
    // that has nothing to offer the caller.
    throw selectorError(
      candidates.length ? "run.ambiguous" : "run.not_found",
      "Run number did not identify exactly one run",
      selectorCandidates(
        "run",
        selector.value,
        candidates,
        candidates,
        (item) => ({ id: item.id, index_in_repo: item.index_in_repo }),
        (item) => ({ kind: "id", value: item.id }),
      ),
    );
  return candidates[0]!;
}
function selectArtifact(requested: string, available: ActionArtifact[]): ActionArtifact {
  const matches = available.filter(
    (item) => String(item.id) === requested || item.name === requested,
  );
  if (matches.length !== 1)
    throw selectorError(
      matches.length ? "artifact.ambiguous" : "artifact.not_found",
      "Artifact selector did not identify exactly one artifact",
      selectorCandidates(
        "artifact",
        requested,
        matches,
        available,
        (item) => ({ id: item.id, name: item.name }),
        // `run download` takes a list of artifact selectors, so the step replaces the one entry
        // that failed rather than the whole field, and the stable ID is what cannot collide.
        (item) => String(item.id),
      ),
    );
  return matches[0]!;
}
function selectJob(selector: unknown, jobs: ActionJob[]): ActionJob {
  const selected = selector as { kind: "id" | "name"; value: number | string };
  const matches = jobs.filter((item) =>
    selected.kind === "id" ? item.id === selected.value : item.name === selected.value,
  );
  if (matches.length !== 1)
    throw selectorError(
      matches.length ? "job.ambiguous" : "job.not_found",
      "Job selector did not identify exactly one job",
      selectorCandidates(
        "job",
        selected.value,
        matches,
        jobs,
        (item) => ({ id: item.id, name: item.name }),
        (item) => ({ kind: "id", value: item.id }),
      ),
    );
  return matches[0]!;
}
async function watch(
  initial: ActionRun,
  value: Input,
  resolved: Resolved,
  capabilities: CapabilitySet,
): Promise<Record<string, unknown>> {
  // The caller already holds a freshly read run, so the first attempt reuses it instead of
  // spending a request re-reading what it just read. Every later attempt reads by stable ID, so
  // a run selected by number is not searched for again.
  const { value: run, attempts } = await watchUntilSettled(
    capabilities,
    { watch: true, interval: number(value.interval), timeout: number(value.timeout) },
    async (attempt) =>
      attempt === 1
        ? initial
        : resolved.actions.get(
            resolved.host,
            resolved.token,
            owner(resolved),
            repo(resolved),
            initial.id,
          ),
    complete,
  );
  return { run, watching: true, complete: complete(run), attempts };
}
/**
 * The run statuses Forgejo will not revise, its `DoneStatuses` in `models/actions/status.go`.
 */
export const settledRunStatuses: readonly string[] = ["success", "failure", "cancelled", "skipped"];
/**
 * The run statuses Forgejo may still revise, its `PendingStatuses` in `models/actions/status.go`.
 *
 * "blocked" is a fork pull request waiting on approval and "unknown" is a run the Host has
 * recorded but not yet placed, so both are runs that have not started rather than runs that
 * finished. Treating either as finished ends a watch the moment it begins.
 */
export const pendingRunStatuses: readonly string[] = ["unknown", "waiting", "running", "blocked"];
/**
 * Reports whether a run has reached a status the Host will not revise.
 *
 * The two sets above partition the run-status enum the contract advertises, and a test holds them
 * to it, so a status a later Host adds fails that test rather than silently reading as finished
 * here. An unrecognized status is unfinished for the same reason a null one is: a watch that
 * keeps waiting on a name it does not know costs a timeout, while one that stops costs the caller
 * a completion that never happened.
 */
function complete(run: ActionRun): boolean {
  return run.status !== null && settledRunStatuses.includes(run.status);
}
async function delivery(
  capabilities: CapabilitySet,
  bytes: Uint8Array,
  media: string,
  output: string | undefined,
): Promise<Record<string, unknown>> {
  if (!capabilities.output) throw new Error("output.unavailable");
  return deliver(capabilities.output, bytes, media, output);
}
/**
 * Delivers bulk content that was never read into memory.
 *
 * Logs and artifacts always end up in a file, so they are streamed to the destination rather than
 * buffered and handed over: their size is bounded by that destination, not by what this client
 * will hold, and an artifact larger than the read bound is written out instead of refused.
 */
async function streamedDelivery(
  capabilities: CapabilitySet,
  body: ReadableStream<Uint8Array>,
  media: string,
  output: string | undefined,
): Promise<Record<string, unknown>> {
  if (!capabilities.output) throw new Error("output.unavailable");
  return deliverStream(capabilities.output, body, media, output);
}
function owner(resolved: Resolved): string {
  if (!resolved.context.owner) throw new Error("repo.required");
  return resolved.context.owner;
}
function repo(resolved: Resolved): string {
  if (!resolved.context.name) throw new Error("repo.required");
  return resolved.context.name;
}
function context(value: RepositoryContext): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
function rawContextRecord(value: { host: string }): Record<string, unknown> {
  return { deployment_url: value.host };
}
function workflows(capabilities: CapabilitySet): WorkflowGateway {
  if (!capabilities.workflows) throw new Error("workflow.unavailable");
  return capabilities.workflows;
}
function raw(capabilities: CapabilitySet): RawApiGateway {
  if (!capabilities.rawApi) throw new Error("api.unavailable");
  return capabilities.rawApi;
}
function parseHeaders(values: string[]): Record<string, string> {
  return Object.fromEntries(
    values.map((value) => {
      const index = value.indexOf(":");
      if (index < 1) throw new Error("api.invalid_header");
      return [value.slice(0, index), value.slice(index + 1)];
    }),
  );
}
function body(value: Input): string | Uint8Array | undefined {
  if (typeof value.input === "string" || value.input instanceof Uint8Array) return value.input;
  const fields = [
    ...strings(value.raw_field).map(pair),
    ...strings(value.field).map((item) => {
      const [key, raw] = pair(item);
      try {
        return [key, JSON.parse(raw)] as [string, unknown];
      } catch {
        return [key, raw] as [string, unknown];
      }
    }),
  ];
  return fields.length ? JSON.stringify(Object.fromEntries(fields)) : undefined;
}
/**
 * Defaults `Content-Type: application/json` for a JSON body the caller did not label.
 *
 * Forgejo's API binder ignores an unlabelled body, so a write would fail as 422. `field` and
 * `raw_field` bodies are always JSON; an `input` body is labelled only when its bytes parse as
 * JSON, so arbitrary bytes are never mislabelled. A caller's own Content-Type always wins. The
 * header derives only from the approved input, so an approved replay sends the same request.
 */
function withDefaultContentType(
  headers: Record<string, string>,
  value: Input,
  payload: string | Uint8Array | undefined,
): Record<string, string> {
  if (payload === undefined) return headers;
  if (Object.keys(headers).some((name) => name.trim().toLowerCase() === "content-type"))
    return headers;
  const fromInput = typeof value.input === "string" || value.input instanceof Uint8Array;
  if (fromInput && !parsesAsJson(payload)) return headers;
  return { ...headers, "Content-Type": "application/json" };
}
function parsesAsJson(payload: string | Uint8Array): boolean {
  try {
    JSON.parse(
      typeof payload === "string"
        ? payload
        : new TextDecoder("utf-8", { fatal: true }).decode(payload),
    );
    return true;
  } catch {
    return false;
  }
}
function inputBody(value: string | Uint8Array): BodyInit {
  if (typeof value === "string") return value;
  const bytes = value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
  return new Blob([bytes]);
}
/**
 * Builds the dispatch inputs for `workflow run`.
 *
 * `DispatchWorkflowOption.inputs` advertises `additionalProperties: {"type": "string"}`, so every
 * value goes out exactly as it was written. JSON-parsing it first sent `count=3` as a number and
 * `enabled=true` as a boolean, and the Host rejected the whole dispatch. A value carrying
 * structure is its own JSON text, which the workflow receives verbatim as a string.
 */
function dispatchInputs(value: Input): Record<string, string> {
  return Object.fromEntries(strings(value.field).map(pair));
}
function pair(value: string): [string, string] {
  const index = value.indexOf("=");
  if (index < 1) throw new Error("api.invalid_field");
  return [value.slice(0, index), value.slice(index + 1)];
}
function path(endpoint: string, pageValue: unknown, limitValue: unknown): string {
  const url = new URL(endpoint, "https://forgejo.invalid");
  if (pageValue !== undefined) url.searchParams.set("page", String(pageValue));
  if (limitValue !== undefined) url.searchParams.set("limit", String(limitValue));
  return `${withoutBasePath(url.pathname)}${url.search}`;
}
function withoutBasePath(pathname: string): string {
  if (pathname === apiBasePath) return "/";
  return pathname.startsWith(`${apiBasePath}/`) ? pathname.slice(apiBasePath.length) : pathname;
}
function rawOperation(swagger: string, endpoint: string, method: string): Record<string, unknown> {
  try {
    const document = JSON.parse(swagger) as { paths?: Record<string, Record<string, unknown>> };
    const paths = document.paths ?? {};
    const target = withoutBasePath(new URL(endpoint, "https://forgejo.invalid").pathname);
    const operation = matchingTemplates(paths, target)
      .map((template) => paths[template]?.[method.toLowerCase()])
      // `typeof null` is "object", so a null method entry would end the search and report the
      // operation as unadvertised even when a later matching template advertises it.
      .find((entry) => entry !== null && typeof entry === "object");
    if (!operation) throw new Error("api.operation_not_advertised");
    return operation as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === "api.operation_not_advertised") throw error;
    throw new Error("host.contract_incompatible");
  }
}
function matchingTemplates(
  paths: Record<string, Record<string, unknown>>,
  target: string,
): string[] {
  const templates = Object.keys(paths);
  const exact = templates.filter((template) => templatePattern(template, false).test(target));
  if (exact.length) return exact;
  // Fall back to a trailing parameter that spans segments, such as {filepath}, preferring the
  // most specific template so a shallow one cannot claim a deeper endpoint.
  return templates
    .filter((template) => templatePattern(template, true).test(target))
    .filter((template) => spansSegments(paths, template, target))
    .sort((left, right) => segments(right).length - segments(left).length);
}
function templatePattern(template: string, spanning: boolean): RegExp {
  const body = segments(template)
    .map((segment, index, all) =>
      spanning && index === all.length - 1 && pathParameter.test(segment)
        ? "[^/]+(?:/[^/]+)*"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^{}]+\\\}/g, "[^/]+"),
    )
    .join("/");
  return new RegExp(`^/${body}$`);
}
// This decides what counts as an advertised API capability, so both directions matter. A trailing
// parameter may absorb slashes only when the contract declares it as a string, since a value that
// spans segments can never satisfy a parameter typed as an id, and only when no template reaching
// deeper actually matches the target, since the extra segments are then route structure the
// contract already describes. Resemblance between two templates is not evidence: a deeper template
// whose literals diverge from the target describes a different route and cannot claim it.
// The contract carries no signal for a string parameter the host serves as a single segment, such
// as {username}, so one of those still absorbs and answers a not found rather than being refused.
function spansSegments(
  paths: Record<string, Record<string, unknown>>,
  template: string,
  target: string,
): boolean {
  const parts = segments(template);
  const trailing = parts[parts.length - 1] ?? "";
  if (!pathParameter.test(trailing)) return false;
  if (!stringParameter(paths[template], trailing)) return false;
  const values = segments(target);
  return !Object.keys(paths).some((other) => {
    const candidate = segments(other);
    return (
      candidate.length > parts.length &&
      candidate.slice(0, parts.length).every((segment, index) => describes(segment, values[index]))
    );
  });
}
// A template segment describes a target segment when it is a parameter, which accepts any single
// value, or the identical literal.
function describes(segment: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  return pathParameter.test(segment) || segment === value;
}
function stringParameter(item: Record<string, unknown> | undefined, parameter: string): boolean {
  const name = parameter.slice(1, -1);
  // A path item may declare parameters its operations share, so read the item itself as well as
  // each operation. Reading only the operations would leave the parameter undeclared, and an
  // undeclared parameter never spans, so every multi-segment call would be refused.
  const declared = [item, ...Object.values(item ?? {})]
    .flatMap((source) => declaredParameters(source))
    .filter((entry) => entry.in === "path" && entry.name === name);
  return declared.length > 0 && declared.every((entry) => entry.type === "string");
}
function declaredParameters(source: unknown): { in?: string; name?: string; type?: string }[] {
  if (!source || typeof source !== "object") return [];
  const entries = (source as { parameters?: unknown }).parameters;
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => entry !== null && typeof entry === "object");
}
function segments(template: string): string[] {
  return template.split("/").slice(1);
}
function operationAccepts(operation: Record<string, unknown>, status: number): boolean {
  const responses = operation.responses;
  if (!responses || typeof responses !== "object") return true;
  const codes = Object.keys(responses as Record<string, unknown>);
  return codes.includes("default") || codes.includes(String(status));
}
function validPath(endpoint: string): boolean {
  try {
    const url = new URL(endpoint, "https://forgejo.invalid");
    return (
      endpoint.startsWith("/") &&
      !endpoint.startsWith("//") &&
      !url.pathname.split("/").includes("..") &&
      (url.pathname === "/" || url.pathname.startsWith("/"))
    );
  } catch {
    return false;
  }
}
/**
 * Reports a method `api` will send, which is one the contract declares operations under.
 *
 * This is narrower than the standard REST methods, and deliberately so: it is the set the resolver
 * can reach, not the set HTTP defines, so a method the contract has no operations under is refused
 * here rather than sent and answered.
 */
function acceptedMethod(method: string): boolean {
  return ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method);
}
/**
 * Reports a method the resolver can never find an operation under.
 *
 * The contract declares operations under get, post, delete, patch and put, and none at all under
 * head or options, so `rawOperation` resolves nothing for either on any route, including a route
 * that resolves perfectly under GET. Answering that with `api.operation_not_advertised` sends a
 * caller to re-examine a path that has nothing wrong with it, so the method is refused by name
 * instead, at the schema, before anything reaches the Host. A test holds the pinned contract to
 * declaring no operation under either method.
 */
function unservedMethod(method: string): boolean {
  return ["HEAD", "OPTIONS"].includes(method);
}
/**
 * Reports whether an accepted method asks the Host to change state, which approval gates.
 *
 * GET is the only accepted method that does not. HEAD and OPTIONS are absent because the schema
 * refuses them: classifying them read-only here described them as the cheap way to test whether
 * something exists, which no route could ever answer.
 */
function writeMethod(method: string): boolean {
  return method !== "GET";
}
function decodeJsonOrText(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
/**
 * Qualifies a run list ref filter, which the Host matches exactly against the stored ref.
 *
 * A listed run reports the short `prettyref`, so the value a caller reads back, such as `main`,
 * is not the value the filter accepts. `prettyref` reports `#12` for a pull ref, which maps back
 * exactly, so that form round-trips. A tag and a branch are indistinguishable once shortened, so
 * any other short form is taken as a branch; pass `refs/tags/v1` explicitly for a tag. The
 * applied ref is reported in the result.
 */
function qualifyRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("refs/")) return value;
  const pull = /^#(\d+)$/.exec(value);
  return pull ? `refs/pull/${pull[1]}/head` : `refs/heads/${value}`;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
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
/** A recovery a failure already knows, as the details and the steps that report it. */
type Recovery = { details: Record<string, unknown>; next_steps: NextStep[] };
function selectorError(
  code: string,
  message: string,
  recovery: Recovery,
): { code: string; message: string; details: Record<string, unknown>; next_steps: NextStep[] } {
  return { code, message, ...recovery };
}
/** The most candidates any selector failure carries, so one bad selector cannot flood an outcome. */
const CANDIDATE_LIMIT = 10;
/**
 * Builds the recovery every Actions selector reports on a failed selection, so a caller reads the
 * run, artifact and job failures the same way. An ambiguous selector lists the candidates that
 * collide, because those are the ones the caller must choose between; a selector that matched
 * nothing lists what the target actually holds, because the caller has to see what exists. The
 * recovery hint names the one action that resolves the branch it belongs to.
 *
 * The same bounded candidate list becomes one `select` step each, carrying the stable identity
 * that resolves to exactly that candidate. The prose hint stays where it is, because a human
 * reading a terminal still wants it; the steps are what an agent acts on without parsing it. A
 * branch with no candidates yields no steps, because there is nothing to select.
 */
function selectorCandidates<T>(
  noun: string,
  requested: string | number,
  matches: T[],
  available: T[],
  describe: (item: T) => Record<string, unknown>,
  identify: (item: T) => unknown,
): Recovery {
  const ambiguous = matches.length > 1;
  const candidates = (ambiguous ? matches : available).slice(0, CANDIDATE_LIMIT);
  return {
    details: {
      requested,
      candidates: candidates.map(describe),
      recovery: ambiguous
        ? `use the stable ${noun} ID`
        : candidates.length
          ? `select from the candidate ${noun}s`
          : `list the ${noun}s to find one`,
    },
    next_steps: candidates.map((item) => ({
      action: "select" as const,
      field: noun,
      value: identify(item),
    })),
  };
}
/** Describes a failure that followed an effect which already landed on the Host. */
function partial(error: unknown, message: string): CommandError {
  const typed = error as { code?: unknown };
  const code = isErrorCode(typed?.code)
    ? typed.code
    : error instanceof Error && isErrorCode(error.message)
      ? error.message
      : "actions.request_failed";
  return { code, message, details: {} };
}
const duration = z.number().positive().max(3600);
