import { createHash } from "node:crypto";
import { z } from "zod";
import { abandonBody, type OutputStore } from "./adapters";
import type { HostAccess } from "./host-session";
import type { RepositoryGateway } from "./repository-gateway";
import type { GitOperations } from "./git-operations";
import type { IssuesGateway } from "./issue-gateway";
import type { PullRequestsGateway } from "./pull-request-gateway";
import type { ActionsGateway } from "./actions-gateway";
import type { RawApiGateway } from "./raw-api-gateway";
import type { WorkflowGateway } from "./workflow-gateway";

/** The stable wire version for Request mode outcomes. */
export const schemaVersion = 1;
/** A bounded diagnostic captured while executing a command. */
export type Diagnostic = {
  source: string;
  stream: "stdout" | "stderr";
  content: string;
  original_bytes: number;
  truncated: boolean;
};
/** An externally observable operation in execution order. */
export type Effect = {
  effect_id: string;
  action: string;
  target: string;
  state: "planned" | "skipped" | "succeeded" | "failed" | "unknown";
  details: Record<string, unknown>;
};
/** A stable, safe failure description. */
export type CommandError = { code: string; message: string; details: Record<string, unknown> };
/**
 * One recovery the runtime already knew when it raised the failure that carries it.
 *
 * `action` says what a caller does with the rest of the step. Three of the four re-issue the
 * command that just failed, because that is the recovery the runtime knows, and the outcome's own
 * `command` already names the leaf so no step repeats it. Only `invoke` hands over an argv, and
 * that argv is not always this CLI: a partial `repo clone` recovers through `git`, so `argv[0]`
 * names the program and has to be read rather than assumed.
 */
export type NextStep =
  /** Re-issue the command with `value` in place of the selector sent for `field`. */
  | { action: "select"; field: string; value: unknown }
  /** Re-issue the command with `field` supplied, whose value only the caller knows. */
  | { action: "provide"; field: string }
  /** Re-issue the command unchanged, with this one-time grant passed as `--approve`. */
  | { action: "approve"; grant: string }
  /** Execute this argv. `argv[0]` names the program, which is not always this CLI. */
  | { action: "invoke"; argv: string[] };
/**
 * The shape every catalogued error code shares: a lowercase namespace and member joined by a dot,
 * with underscores allowed in both so `pull_request.not_found` reads as a code.
 */
const errorCodeShape = /^[a-z_]+\.[a-z_]+$/;
/**
 * Reports whether a value is a well-formed error code.
 *
 * This is the single rule every caller uses to decide whether a caught failure is already
 * reporting a code or is only carrying an incidental message. Each caller keeps its own generic
 * code for the values this rejects, because the sensible generic differs by domain, but none of
 * them may keep a private copy of the shape: five copies of it had already drifted apart once,
 * and a sixth site promoted whatever message it was handed into the code position, which is how a
 * caller ended up branching on a code that appears in no catalog.
 *
 * @param value A candidate code, from a typed failure's `code` or a bare `Error`'s message.
 * @returns True when the value can be reported as an error code.
 */
export function isErrorCode(value: unknown): value is string {
  return typeof value === "string" && errorCodeShape.test(value);
}
/**
 * A failure recording that the Host had already received the request it followed.
 *
 * The transport marks it, because only the transport knows whether anything was sent; see
 * `markTransmitted` in `infrastructure`.
 */
export type TransmittedFailure = { transmitted?: boolean };
/** The common Human and Request mode result envelope. */
export type CommandOutcome = {
  schema_version: 1;
  request_id: string | null;
  command: string;
  status: "success" | "error";
  result: Record<string, unknown> | null;
  error: CommandError | null;
  context: Record<string, unknown>;
  effects: Effect[];
  diagnostics: Diagnostic[];
  next_steps: NextStep[];
};
/** An approval-sensitive set of planned effects. */
export type MutationPlan = {
  command: string;
  input: Record<string, unknown>;
  targets: string[];
  effects: Effect[];
};
/** Purpose-built powers exposed to a command handler. */
export type CapabilitySet = {
  gateway: { smoke(input: { value: string }): Promise<{ echoed: string }> };
  host: HostAccess | undefined;
  repositories: RepositoryGateway | undefined;
  git: GitOperations | undefined;
  issues?: IssuesGateway | undefined;
  pullRequests?: PullRequestsGateway | undefined;
  actions?: ActionsGateway | undefined;
  rawApi?: RawApiGateway | undefined;
  workflows?: WorkflowGateway | undefined;
  output?: OutputStore | undefined;
  environment: Record<string, string | undefined>;
  cwd: string;
  keychainNoUi?: boolean;
  clock: { now(): Date };
  /**
   * Suspends a polling loop, seam-injected so watch behaviour is testable without real waiting.
   */
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  cancelled: () => boolean;
};
/** Normalized catalog invocation. */
export type Invocation = {
  command: string;
  input: Record<string, unknown>;
  requestId: string | null;
  approval: string | undefined;
  dryRun: boolean;
  mode: "human" | "request";
};
/** A declarative command entry, the sole source of one leaf contract. */
export type CommandDefinition = {
  name: string;
  /**
   * One-line summary of what this leaf does, in the imperative. This is the single source the
   * Human help text and the Request `--version` catalog both read, so the two cannot disagree.
   */
  description: string;
  input: z.ZodType<Record<string, unknown>>;
  mutation: boolean;
  /**
   * Determines whether a normalized request needs approval beyond its static command class.
   */
  requiresApproval?: (input: Record<string, unknown>) => boolean;
  /**
   * Runs this command's preflight before issuing an Approval grant.
   */
  preflightBeforeApproval?: boolean;
  plan: (input: Record<string, unknown>) => MutationPlan;
  handler: (
    input: Record<string, unknown>,
    capabilities: CapabilitySet,
  ) => Promise<{
    result: Record<string, unknown>;
    effects?: Effect[];
    context?: Record<string, unknown>;
    partial_error?: CommandError;
    diagnostics?: Diagnostic[];
    next_steps?: NextStep[];
  }>;
  preflight?: (
    input: Record<string, unknown>,
    capabilities: CapabilitySet,
  ) => Promise<{
    result?: Record<string, unknown>;
    context?: Record<string, unknown>;
    diagnostics?: Diagnostic[];
  }>;
};

const requestSchema = z
  .object({
    schema_version: z.literal(1),
    request_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
const redact = (value: unknown): unknown => {
  if (typeof value === "string")
    return value.replace(/(?:token|authorization|bearer)[=: ]+[^\s,]+/gi, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|authorization|password|secret/i.test(key) ? "[REDACTED]" : redact(item),
      ]),
    );
  return value;
};
const digest = (plan: MutationPlan): string =>
  createHash("sha256").update(JSON.stringify(plan)).digest("hex");
function bound(diagnostics: Diagnostic[]): Diagnostic[] {
  let total = 0;
  return diagnostics.slice(0, 16).flatMap((diagnostic) => {
    const available = 64 * 1024 - total;
    if (available <= 0) return [];
    const content = String(redact(diagnostic.content));
    const retained = Buffer.from(content)
      .subarray(0, Math.min(Buffer.byteLength(content), 16 * 1024, available))
      .toString();
    total += Buffer.byteLength(retained);
    return [
      { ...diagnostic, content: retained, truncated: diagnostic.truncated || retained !== content },
    ];
  });
}
/**
 * Retains the steps that fit the outcome's step budget, dropping the rest.
 *
 * Steps are bounded for the same reason Diagnostics are: a failed selection reports one step per
 * candidate, so an unbounded list would let one bad selector decide how large an outcome is. A
 * step is dropped whole rather than truncated, because half a recovery is one a caller cannot act
 * on, and the retained steps stay a prefix of what the producer offered so the first and most
 * specific recovery is the one that survives.
 */
function boundSteps(steps: NextStep[]): NextStep[] {
  const retained: NextStep[] = [];
  let total = 0;
  for (const step of steps.slice(0, 16)) {
    const redacted = redact(step) as NextStep;
    total += Buffer.byteLength(JSON.stringify(redacted));
    if (total > 16 * 1024) break;
    retained.push(redacted);
  }
  return retained;
}
/** Reports whether a failure followed a state-changing request the Host had already received. */
export function wasTransmitted(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as TransmittedFailure).transmitted === true
  );
}
/**
 * Reports the effects of a failed command, separating work that may have landed from work that
 * never started.
 *
 * `planned` is the pre-execution state, so a caller reconciling the ledger reads it as never
 * attempted and retries. That reading holds only while nothing has been sent. Once the request has
 * reached the Host, `unknown` is the honest state, the same one a scheduled merge already uses:
 * the Host may have done the work. `details.transmitted` says which of the two an `unknown` is.
 */
function ledger(effects: Effect[], transmitted: boolean): Effect[] {
  if (!transmitted) return effects;
  return effects.map((item) =>
    item.state === "planned"
      ? { ...item, state: "unknown" as const, details: { ...item.details, transmitted: true } }
      : item,
  );
}
/**
 * Reports the code and message a schema asked one of its own refusals to carry.
 *
 * `request.invalid` describes input the caller should re-read, which is the whole story for almost
 * every refusal: the issues say what to fix. It is the wrong story for a refusal a caller has to
 * branch on rather than re-read, because one `request.invalid` is indistinguishable from another
 * without parsing prose out of `details.issues`. A schema may therefore name a catalogued code in a
 * custom issue's `params.code`, and the refusal reports that code with that issue's message. The
 * name is held to the shared code shape, so a schema cannot promote arbitrary text into the code
 * position, and the issues stay in `details` either way.
 *
 * Issues are read in the order the schema added them, so the first named one wins over anything
 * beside it. Input can be wrong in more than one way at once, and a named code describes the one
 * refusal a caller cannot diagnose from the issues alone, so it is the more useful of the two
 * answers; the other is still in `details.issues`, and fixing this one reports it next.
 */
function namedRefusal(issues: z.ZodIssue[]): { code: string; message: string } | undefined {
  for (const issue of issues) {
    const code = (issue as { params?: { code?: unknown } }).params?.code;
    if (isErrorCode(code)) return { code, message: issue.message };
  }
  return undefined;
}
function failureFromError(
  command: string,
  requestId: string | null,
  error: unknown,
  effects: Effect[],
): CommandOutcome {
  const typed = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    diagnostics?: unknown;
    next_steps?: unknown;
    effects?: unknown;
  };
  const code = isErrorCode(typed.code)
    ? typed.code
    : error instanceof Error && isErrorCode(error.message)
      ? error.message
      : "command.failed";
  const outcome = failure(
    command,
    requestId,
    code,
    typeof typed.message === "string" && code !== "command.failed"
      ? typed.message
      : code === "command.failed"
        ? "Command failed"
        : "Command could not complete",
    typed.details && typeof typed.details === "object"
      ? (typed.details as Record<string, unknown>)
      : {},
    // A handler that reports its own effects has already said what happened, so only the plan's
    // own effects are reinterpreted here.
    Array.isArray(typed.effects)
      ? (typed.effects as Effect[])
      : ledger(effects, wasTransmitted(error)),
  );
  return {
    ...outcome,
    diagnostics: Array.isArray(typed.diagnostics) ? bound(typed.diagnostics as Diagnostic[]) : [],
    next_steps: Array.isArray(typed.next_steps) ? boundSteps(typed.next_steps as NextStep[]) : [],
  };
}
const failure = (
  command: string,
  requestId: string | null,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  effects: Effect[] = [],
): CommandOutcome => ({
  schema_version: 1,
  request_id: requestId,
  command,
  status: "error",
  result: null,
  error: { code, message, details: redact(details) as Record<string, unknown> },
  context: {},
  effects: redact(effects) as Effect[],
  diagnostics: [],
  next_steps: [],
});

/** Creates the Host-authentication entries for the shared command catalog. */
export function createAuthCatalog(): CommandDefinition[] {
  return [
    {
      name: "auth login",
      description: "Store credentials for a Forgejo host",
      input: z.object({ url: z.string().min(1), token: z.string().min(1) }).strict(),
      mutation: true,
      plan: (input) => ({
        command: "auth login",
        input,
        targets: [String(input.url)],
        effects: [
          {
            effect_id: "credential.persist",
            action: "persist_credential",
            target: String(input.url),
            state: "planned",
            details: {},
          },
          {
            effect_id: "profile.persist",
            action: "persist_host_profile",
            target: String(input.url),
            state: "planned",
            details: {},
          },
          {
            effect_id: "git.credential.configure",
            action: "configure_git_credential_helper",
            target: String(input.url),
            state: "planned",
            details: {},
          },
        ],
      }),
      handler: async (input, capabilities) => {
        const login = await requireHostSession(capabilities).login(
          String(input.url),
          String(input.token),
          capabilities.keychainNoUi ?? true,
        );
        return {
          result: { profile: login.profile },
          effects: [
            {
              effect_id: "credential.persist",
              action: "persist_credential",
              target: login.profile.url,
              state: "succeeded",
              details: {},
            },
            {
              effect_id: "profile.persist",
              action: "persist_host_profile",
              target: login.profile.url,
              state: "succeeded",
              details: {},
            },
            {
              effect_id: "git.credential.configure",
              action: "configure_git_credential_helper",
              target: login.profile.url,
              state:
                login.git_config === "failed"
                  ? "failed"
                  : login.git_config === "not_configured"
                    ? "skipped"
                    : "succeeded",
              details: {},
            },
          ],
          ...(login.git_config === "failed"
            ? {
                partial_error: {
                  code: "auth.git_config_failed",
                  message: "Login succeeded, but Git credential configuration failed",
                  details: {
                    argv: [
                      "git",
                      "config",
                      "--global",
                      `credential.${login.profile.url}.helper`,
                      "osxkeychain",
                    ],
                  },
                },
              }
            : {}),
        };
      },
    },
    {
      name: "auth status",
      description: "Show stored credential and profile status for a host",
      input: z.object({ host: z.string().min(1) }).strict(),
      mutation: false,
      plan: (input) => ({
        command: "auth status",
        input,
        targets: [String(input.host)],
        effects: [],
      }),
      handler: async (input, capabilities) => ({
        result: {
          status: await requireHostSession(capabilities).status(
            String(input.host),
            capabilities.keychainNoUi ?? true,
          ),
        },
      }),
    },
    {
      name: "auth logout",
      description: "Remove stored credentials for a host",
      input: z.object({ host: z.string().min(1) }).strict(),
      mutation: true,
      plan: (input) => ({
        command: "auth logout",
        input,
        targets: [String(input.host)],
        effects: [
          {
            effect_id: "credential.remove",
            action: "remove_credential",
            target: String(input.host),
            state: "planned",
            details: {},
          },
          {
            effect_id: "profile.clear_identity",
            action: "clear_active_identity",
            target: String(input.host),
            state: "planned",
            details: {},
          },
        ],
      }),
      handler: async (input, capabilities) => {
        const profile = await requireHostSession(capabilities).logout(
          String(input.host),
          capabilities.keychainNoUi ?? true,
        );
        return {
          result: { profile },
          effects: [
            {
              effect_id: "credential.remove",
              action: "remove_credential",
              target: profile.url,
              state: "succeeded",
              details: {},
            },
            {
              effect_id: "profile.clear_identity",
              action: "clear_active_identity",
              target: profile.url,
              state: "succeeded",
              details: {},
            },
          ],
        };
      },
    },
  ];
}

export function requireHostSession(capabilities: CapabilitySet): HostAccess {
  if (!capabilities.host) throw new Error("host.unavailable");
  return capabilities.host;
}

/** Creates the minimal smoke-only catalog used to exercise the shared runtime. */
export function createSmokeCatalog(): CommandDefinition[] {
  return [
    {
      name: "smoke echo",
      description: "Echo a value back to verify the request and approval path",
      input: z.object({ value: z.string().min(1) }).strict(),
      mutation: true,
      plan: (input) => ({
        command: "smoke echo",
        input,
        targets: [String(input.value)],
        effects: [
          {
            effect_id: "echo",
            action: "echo",
            target: String(input.value),
            state: "planned",
            details: {},
          },
        ],
      }),
      handler: async (input, capabilities) => ({
        result: await capabilities.gateway.smoke({ value: String(input.value) }),
        effects: [
          {
            effect_id: "echo",
            action: "echo",
            target: String(input.value),
            state: "succeeded",
            details: {},
          },
        ],
      }),
    },
  ];
}

/** Executes normalized invocations, enforcing approval, cancellation, and safe outcomes. */
export async function execute(
  invocation: Invocation,
  catalog: CommandDefinition[],
  capabilities: CapabilitySet,
): Promise<CommandOutcome> {
  const definition = catalog.find((entry) => entry.name === invocation.command);
  if (!definition)
    return failure(
      invocation.command,
      invocation.requestId,
      "command.not_found",
      "Unknown command",
    );
  const parsed = definition.input.safeParse(invocation.input);
  if (!parsed.success) {
    const named = namedRefusal(parsed.error.issues);
    return failure(
      invocation.command,
      invocation.requestId,
      named?.code ?? "request.invalid",
      named?.message ?? "Invalid command input",
      { issues: parsed.error.issues },
    );
  }
  if (capabilities.cancelled())
    return failure(
      invocation.command,
      invocation.requestId,
      "command.cancelled",
      "Command cancelled",
    );
  const plan = definition.plan(parsed.data);
  const executionInput = { ...parsed.data, __mode: invocation.mode };
  const planned = plan.effects;
  const mutation = definition.mutation || definition.requiresApproval?.(parsed.data) === true;
  if (mutation && invocation.dryRun) {
    try {
      const preflight = definition.preflight
        ? await definition.preflight(executionInput, capabilities)
        : undefined;
      return {
        schema_version: 1,
        request_id: invocation.requestId,
        command: invocation.command,
        status: "success",
        result: redact(preflight?.result ?? {}) as Record<string, unknown>,
        error: null,
        context: redact({ plan_digest: digest(plan), ...preflight?.context }) as Record<
          string,
          unknown
        >,
        effects: redact(planned) as Effect[],
        diagnostics: preflight?.diagnostics ? bound(preflight.diagnostics) : [],
        next_steps: [],
      };
    } catch (error) {
      return failureFromError(invocation.command, invocation.requestId, error, planned);
    }
  }
  if (mutation) {
    let approvalPreflight:
      | Awaited<ReturnType<NonNullable<CommandDefinition["preflight"]>>>
      | undefined;
    if (definition.preflightBeforeApproval && definition.preflight) {
      try {
        approvalPreflight = await definition.preflight(executionInput, capabilities);
      } catch (error) {
        return failureFromError(invocation.command, invocation.requestId, error, planned);
      }
    }
    const expected = `${digest(plan)}:${Math.floor(capabilities.clock.now().getTime() / 600000)}`;
    if (invocation.approval !== expected)
      return {
        ...failure(
          invocation.command,
          invocation.requestId,
          "approval.required",
          "Approval is required",
          {
            plan_digest: digest(plan),
            approve: `--approve ${expected}`,
            ...(approvalPreflight?.result ? { target: approvalPreflight.result } : {}),
            ...(approvalPreflight?.context ? { context: approvalPreflight.context } : {}),
          },
          planned,
        ),
        // The grant is the whole recovery and it is already computed, so a caller re-issues what it
        // sent rather than reassembling the flag out of `details.approve`.
        next_steps: boundSteps([{ action: "approve", grant: expected }]),
      };
  }
  try {
    const handled = await definition.handler(executionInput, capabilities);
    return {
      schema_version: 1,
      request_id: invocation.requestId,
      command: invocation.command,
      status: handled.partial_error ? "error" : "success",
      result: redact(handled.result) as Record<string, unknown>,
      error: handled.partial_error ? (redact(handled.partial_error) as CommandError) : null,
      context: redact(handled.context ?? {}) as Record<string, unknown>,
      effects: redact(handled.effects ?? []) as Effect[],
      diagnostics: handled.diagnostics ? bound(handled.diagnostics) : [],
      next_steps: boundSteps(handled.next_steps ?? []),
    };
  } catch (error) {
    return failureFromError(invocation.command, invocation.requestId, error, planned);
  }
}

const requestReadLimit = 1024 * 1024;

/**
 * Reads the correlation identity a Request carries, from a body the caller never got to run.
 *
 * A Request refused before it is decoded still names itself, and an outcome the caller cannot
 * correlate is one it has to match by position instead. Exported so the Request-mode argv scan
 * echoes the same identity `decodeRequest` recovers from an envelope it rejects.
 */
export function recoverRequestId(body: string): string | null {
  if (Buffer.byteLength(body) > requestReadLimit) return null;
  try {
    return recoveredRequestId(JSON.parse(body));
  } catch {
    return null;
  }
}

/** Reads a recoverable identity from a parsed body, whatever else is wrong with it. */
function recoveredRequestId(raw: unknown): string | null {
  return raw &&
    typeof raw === "object" &&
    typeof (raw as { request_id?: unknown }).request_id === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/.test((raw as { request_id: string }).request_id)
    ? (raw as { request_id: string }).request_id
    : null;
}

/** Decodes a strict Request-mode JSON document no larger than one MiB. */
export function decodeRequest(
  command: string,
  body: string,
  approval: string | undefined,
  dryRun: boolean,
): Invocation | CommandOutcome {
  if (Buffer.byteLength(body) > requestReadLimit)
    return failure(command, null, "request.invalid", "Request exceeds one MiB");
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return failure(command, null, "request.invalid", "Request must be one JSON object");
  }
  const recovered = recoveredRequestId(raw);
  if (
    raw &&
    typeof raw === "object" &&
    "schema_version" in raw &&
    (raw as { schema_version: unknown }).schema_version !== schemaVersion
  )
    return failure(
      command,
      recovered,
      "request.unsupported_version",
      "Unsupported Request schema version",
      { supported_schema_version: schemaVersion },
    );
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success)
    return failure(command, recovered, "request.invalid", "Invalid Request envelope", {
      issues: parsed.error.issues,
    });
  return {
    command,
    input: parsed.data.input,
    requestId: parsed.data.request_id,
    approval,
    dryRun,
    mode: "request",
  };
}

/** Decodes the smoke fixture's exact argv shape without accepting input fallbacks. */
export function decodeArgv(argv: string[]): Invocation | CommandOutcome {
  const command = argv.slice(0, 2).join(" ");
  const valueIndex = argv.indexOf("--value");
  const approvalIndex = argv.indexOf("--approve");
  const allowed = new Set(["smoke", "echo", "--value", "--approve", "--dry-run"]);
  if (
    argv.some(
      (item, index) =>
        index !== valueIndex + 1 && index !== approvalIndex + 1 && !allowed.has(item),
    ) ||
    command !== "smoke echo" ||
    valueIndex < 0 ||
    valueIndex + 1 >= argv.length
  )
    return failure(command || "unknown", null, "argv.invalid", "Expected smoke echo --value VALUE");
  return {
    command,
    input: { value: argv[valueIndex + 1]! },
    requestId: null,
    approval: approvalIndex >= 0 ? argv[approvalIndex + 1] : undefined,
    dryRun: argv.includes("--dry-run"),
    mode: "human",
  };
}

/** Renders exactly one newline-terminated Request-mode outcome, subject to its size cap. */
export function serializeOutcome(outcome: CommandOutcome): string {
  const encoded = JSON.stringify(redact(outcome));
  if (Buffer.byteLength(encoded) > 8 * 1024 * 1024)
    return (
      JSON.stringify(
        failure(
          outcome.command,
          outcome.request_id,
          "result.too_large",
          "Serialized outcome exceeds eight MiB",
        ),
      ) + "\n"
    );
  return encoded + "\n";
}

/** Pages a normalized collection without exceeding the shared one-thousand-item limit. */
export function boundedItems<T>(pages: T[][], limit = 1000): { items: T[]; truncated: boolean } {
  const items = pages.flat().slice(0, limit);
  return { items, truncated: pages.flat().length > limit };
}

/**
 * Streams bytes to an Output store and returns a checksum-backed safe reference.
 *
 * The size and checksum describe the retrieved bytes. A store either places all of them or
 * throws, so they also describe the file now at `path`, and a caller can verify what it opens.
 */
export async function deliver(
  output: OutputStore,
  bytes: Uint8Array,
  mediaType: string,
  destination: string | undefined = undefined,
): Promise<Record<string, unknown>> {
  return {
    path: await output.write(bytes, destination),
    bytes: bytes.byteLength,
    media_type: mediaType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Streams a response body to an Output store and returns the same safe reference `deliver` does.
 *
 * Nothing is buffered: the size and checksum are computed from the bytes as they pass through, so
 * content larger than the client's in-memory read bound still reaches a caller intact instead of
 * being refused for a size that only ever mattered while it was held in memory. A store that
 * cannot finish placing the bytes throws, so a reference is only ever returned for a whole file.
 */
export async function deliverStream(
  output: OutputStore,
  body: ReadableStream<Uint8Array>,
  mediaType: string,
  destination: string | undefined = undefined,
): Promise<Record<string, unknown>> {
  const checksum = createHash("sha256");
  let bytes = 0;
  const measured = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        checksum.update(chunk);
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  // A store that fails before it reads anything, such as one that cannot create the directory it
  // was pointed at, would otherwise leave the Host's connection open with nobody reading it.
  const path = await output.stream(measured, destination).catch(async (error: unknown) => {
    await abandonBody(measured);
    throw error;
  });
  return { path, bytes, media_type: mediaType, sha256: checksum.digest("hex") };
}

/**
 * Polls a subject until it settles or the supplied budget elapses, whichever comes first.
 *
 * The budget is an upper bound on elapsed time and never a lower one: elapsed time is read from
 * the injected clock, and each sleep is clamped to what remains, so an interval longer than the
 * budget cannot overrun it. Nothing else bounds the loop, because a poll count would quietly end a
 * long watch early while still reporting an unremarkable unfinished result. A one-second floor on
 * the interval is what keeps an otherwise unbounded loop from spinning against the Host, and it is
 * enforced here as well as in each caller's schema, so a new caller cannot omit it.
 *
 * A failed poll part way through is an unsettled attempt rather than the end of the watch: a Host
 * that answers one request badly usually answers the next one fine, and throwing away a whole wait
 * over one blip costs the caller far more than waiting one further interval. A failure still live
 * when the budget runs out is not transient, so it is thrown rather than reported as an unfinished
 * watch.
 *
 * A *first* poll that throws is different, and is reported at once. Nothing has been established
 * to wait on yet: the Host refused the very request the caller just made, and a refusal like a
 * rejected token or an absent pull request cannot become transient. Retrying it would spend the
 * whole budget re-asking a question already answered, which is what a caller who passed no watch
 * flag would see too.
 *
 * Because the budget is the only bound, the injected clock has to advance for the loop to end. A
 * test that watches a subject which never settles must therefore inject a sleep that moves its
 * clock, as the watch tests do, rather than the frozen clock the other command tests share.
 */
export async function watchUntilSettled<T>(
  capabilities: CapabilitySet,
  options: { watch: boolean; interval: number; timeout: number },
  poll: (attempt: number) => Promise<T>,
  settled: (value: T) => boolean,
): Promise<{ value: T; attempts: number }> {
  const sleep =
    capabilities.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const started = capabilities.clock.now().getTime();
  const timeout = options.timeout * 1000;
  const interval = Math.max(options.interval, 1) * 1000;
  let attempts = 0;
  while (true) {
    attempts += 1;
    let outcome: { value: T } | { error: unknown };
    try {
      outcome = { value: await poll(attempts) };
    } catch (error) {
      outcome = { error };
    }
    if ("error" in outcome && attempts === 1) throw outcome.error;
    const done = "value" in outcome && settled(outcome.value);
    const elapsed = capabilities.clock.now().getTime() - started;
    if (options.watch && !done && elapsed < timeout) {
      await sleep(Math.min(interval, timeout - elapsed));
      continue;
    }
    if ("error" in outcome) throw outcome.error;
    return { value: outcome.value, attempts };
  }
}

/** Compares selected signatures and reports whether an advertised contract remains compatible. */
export function compareManifest(
  expected: Array<{ operation_id: string; method: string; path: string }>,
  advertised: Array<{ operation_id: string; method: string; path: string }>,
): { compatible: boolean; missing: string[] } {
  const actual = new Set(
    advertised.map((item) => `${item.operation_id}:${item.method}:${item.path}`),
  );
  const missing = expected
    .filter((item) => !actual.has(`${item.operation_id}:${item.method}:${item.path}`))
    .map((item) => item.operation_id);
  return { compatible: missing.length === 0, missing };
}
