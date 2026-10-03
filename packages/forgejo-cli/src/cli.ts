import { readFile } from "node:fs/promises";
import { Command, CommanderError } from "commander";
import { z } from "zod";
import {
  createAuthCatalog,
  createSmokeCatalog,
  decodeRequest,
  execute,
  recoverRequestId,
  serializeOutcome,
  type CapabilitySet,
  type CommandDefinition,
  type CommandOutcome,
  type Invocation,
} from "@wyattjoh/forgejo/internal/runtime";
import { schemaVersion } from "@wyattjoh/forgejo/internal/runtime";
import { buildStamp, cliVersion, versionLine } from "./version";
import type { HumanInterface } from "./human-interface";

/** Dependencies injected at the Human and Request CLI boundary. */
export type CliDependencies = {
  capabilities: CapabilitySet;
  catalog: CommandDefinition[];
  human: HumanInterface | undefined;
};

type ParsedHumanCommand = {
  command: string;
  input: Record<string, unknown>;
  approval: string | undefined;
  dryRun: boolean;
};
export type OptionDefinition = readonly [string, string?];

const commonOptions: OptionDefinition[] = [
  ["--approve [grant]", "Approve a planned mutation with its one-time grant"],
  ["--dry-run", "Show planned effects without executing them"],
];

/**
 * Maps an input field to the Human flags that populate it.
 *
 * Every leaf declares a `.strict()` input schema, so its accepted fields are already stated once.
 * Deriving the flag list from that schema is what keeps help honest: a flag can only be advertised
 * where the schema would accept it. The family-wide flag lists this replaced advertised
 * `repo view --push` and `repo create --public`, neither of which any schema accepts.
 *
 * A field maps to several flags when more than one spelling populates it, and to none when the
 * field is not reachable from argv at all.
 */
const fieldOptions: Record<string, OptionDefinition[]> = {
  all: [["--all", "Include all results"]],
  archived: [["--archived <true|false>", "Include archived repositories"]],
  artifact: [["--artifact <name>", "Artifact name, repeatable"]],
  assignee: [["--assignee <login>", "Assignee, repeatable"]],
  author: [["--author <login>", "Author login"]],
  // `--approve` is a common flag already, and `pr review` reads its bare form as the review verdict.
  approve: [],
  base: [["--base <branch>", "Base branch"]],
  binary: [["--binary", "Include binary changes"]],
  body: [
    ["--body <markdown>", "Body text"],
    ["--body-file <path>", "Read body text from a file"],
  ],
  branch: [["--branch <branch>", "Local branch name"]],
  clone: [["--clone", "Clone the fork locally"]],
  comment: [["--comment", "Leave a comment review"]],
  comments: [["--comments", "Include comments"]],
  commit: [["--commit <sha>", "Commit SHA"]],
  default_branch: [["--default-branch <branch>", "Default branch name"]],
  delete_branch: [["--delete-branch", "Delete the branch after merging"]],
  description: [["--description <text>", "Repository description"]],
  dir: [["--dir <path>", "Download directory"]],
  due_date: [["--due-date <date>", "Due date"]],
  event: [["--event <event>", "Workflow event"]],
  exit_status: [["--exit-status", "Exit nonzero when the run fails"]],
  fast_forward_only: [["--fast-forward-only", "Allow only fast-forward merges"]],
  force: [["--force", "Force the operation"]],
  head: [["--head <branch>", "Head branch"]],
  header: [["--header <name:value>", "HTTP header, repeatable"]],
  host: [["--host <host>", "Forgejo host URL or configured host name"]],
  include: [["--include", "Include response headers"]],
  init: [["--init", "Initialize the repository"]],
  input: [["--input <path|->", "Read request bytes from a file or standard input"]],
  job: [
    ["--job <name>", "Job name"],
    ["--job-id <number>", "Job ID"],
  ],
  label: [["--label <label>", "Label, repeatable"]],
  limit: [["--limit <number>", "Maximum results per page"]],
  log: [["--log", "Include job logs"]],
  log_failed: [["--log-failed", "Include failed job logs"]],
  match_head: [["--match-head <branch>", "Match pull requests by head branch"]],
  mention: [["--mention <login>", "Mentioned login"]],
  merge: [["--merge", "Merge with a merge commit"]],
  method: [["--method <method>", "HTTP method"]],
  milestone: [["--milestone <name>", "Milestone name"]],
  name: [["--name <name>", "Repository name"]],
  output: [["--output <path>", "Write output to a file"]],
  owner: [["--owner <owner>", "Repository owner"]],
  interval: [["--interval <duration>", "Polling interval, such as 5s or 1m"]],
  page: [["--page <number>", "Page number"]],
  patch: [["--patch", "Request patch output"]],
  private: [["--private", "Make the repository private"]],
  push: [["--push", "Push the current branch after creation"]],
  raw_field: [["--raw-field <name=value>", "Raw request field, repeatable"]],
  rebase: [["--rebase", "Merge by rebasing"]],
  rebase_merge: [["--rebase-merge", "Rebase then merge"]],
  ref: [["--ref <ref>", "Git ref; run list reads a short name as refs/heads/<branch>"]],
  remote: [["--remote <name>", "Git remote name"]],
  repo: [["--repo <owner/name>", "Repository selector"]],
  request_changes: [["--request-changes", "Request changes"]],
  reviewer: [["--reviewer <login>", "Reviewer, repeatable"]],
  run_number: [["--run-number <number>", "Run number"]],
  search: [["--search <query>", "Search query"]],
  sort: [["--sort <field>", "Sort field"]],
  source: [["--source <owner/name>", "Source repository"]],
  squash: [["--squash", "Squash commits when merging"]],
  state: [["--state <state>", "Issue or pull request state"]],
  status: [["--status <status>", "Run status"]],
  timeout: [["--timeout <duration>", "Polling timeout, such as 5m or 1h"]],
  title: [["--title <title>", "Title"]],
  // The token is never accepted as argv, so it cannot land in shell history or a process listing.
  token: [["--token-stdin", "Read the token from standard input"]],
  type: [["--type <type>", "Issue type"]],
  url: [["--url <url>", "Forgejo host URL"]],
  value: [["--value <value>", "Value to echo"]],
  visibility: [["--visibility <visibility>", "Repository visibility"]],
  watch: [["--watch", "Wait for completion"]],
  website: [["--website <url>", "Repository website URL"]],
  when_checks_succeed: [["--when-checks-succeed", "Wait for required checks"]],
  workflow: [["--workflow <workflow>", "Workflow name or ID"]],
};

/**
 * Overrides a field's flag help for one command, where the same field means different things.
 */
const commandFieldOptions: Record<string, Record<string, OptionDefinition[]>> = {
  api: { field: [["--field <name=value>", "Request field, repeatable"]] },
  // Dispatch inputs are strings on the wire, so `workflow run` has no raw counterpart to `--field`.
  "workflow run": {
    field: [["--field <name=value>", "Workflow input field, sent verbatim, repeatable"]],
  },
};

/** One-line summaries for the command groups, which carry no schema of their own. */
const familyDescriptions: Record<string, string> = {
  smoke: "Verify the request, approval, and output path",
  auth: "Manage credentials for Forgejo hosts",
  repo: "Create, inspect, and manage repositories",
  issue: "Create, inspect, and manage issues",
  pr: "Create, inspect, review, and merge pull requests",
  workflow: "Inspect local workflow files and dispatch them on the Host",
  run: "Inspect and manage Actions runs",
};

/**
 * Runs the supported CLI through Human or strict Request mode adapters.
 *
 * @param argv Command-line arguments without the executable.
 * @param stdin Request document or token bytes from the caller.
 * @param stdout Human or Request standard output destination.
 * @param stderr Human standard error destination.
 * @param dependencies Injectable command catalog and capabilities.
 * @returns Process exit code.
 */
export async function run(
  argv: string[],
  stdin: string,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  dependencies: CliDependencies = smokeDependencies(),
): Promise<number> {
  const requestMode = argv.includes("--input-output") && argv.includes("json");
  const agentMode = argv.includes("--agent");
  const typedMode = requestMode || agentMode;
  const agentVersion = agentMode && (argv.includes("--version") || argv.includes("-V"));
  if ((requestMode && argv.includes("--version")) || agentVersion) {
    const versionArgv = agentVersion
      ? argv.map((argument) => (argument === "-V" ? "--version" : argument))
      : argv;
    const outcome = versionOutcome(
      versionArgv,
      dependencies.catalog,
      requestMode ? "--input-output" : "--agent",
    );
    stdout(serializeOutcome(outcome));
    return outcome.status === "success" ? 0 : invalidExit(outcome);
  }
  const decoded = requestMode
    ? decodeRequestArgv(argv, stdin)
    : agentMode && (argv.includes("--help") || argv.includes("-h"))
      ? invalid(commandName(argv), "Help cannot be combined with --agent")
      : await decodeHuman(
          argv,
          stdin,
          stdout,
          stderr,
          dependencies.human,
          dependencies.catalog,
          agentMode,
        );
  if (decoded === undefined) return 0;
  let outcome =
    "status" in decoded
      ? decoded
      : await execute(decoded, dependencies.catalog, dependencies.capabilities);
  if (!typedMode && !("status" in decoded) && outcome.error?.code === "host.required") {
    const profiles = await dependencies.capabilities.host?.profiles();
    const selectedHost =
      profiles?.length === 1
        ? profiles[0]!.url
        : profiles && profiles.length > 1 && dependencies.human?.isInteractive
          ? await dependencies.human.select(
              "Select a Forgejo Host",
              profiles.map((profile) => profile.url),
            )
          : undefined;
    if (selectedHost) {
      decoded.input.host = selectedHost;
      outcome = await execute(decoded, dependencies.catalog, dependencies.capabilities);
    } else if (profiles && profiles.length > 1 && dependencies.human?.isInteractive) {
      outcome = cancelled(decoded.command);
    }
  }
  if (
    !typedMode &&
    !("status" in decoded) &&
    outcome.error?.code === "approval.required" &&
    dependencies.human?.isInteractive
  ) {
    const approved = await dependencies.human.confirm(approvalMessage(outcome));
    if (approved === true) {
      const approval = approvalFrom(outcome);
      outcome = approval
        ? await execute({ ...decoded, approval }, dependencies.catalog, dependencies.capabilities)
        : outcome;
    } else outcome = cancelled(decoded.command);
  }
  if (typedMode) stdout(serializeOutcome(outcome));
  else if (alreadyReported.has(outcome)) {
    // Commander already stated this one in plain text.
  } else if (dependencies.human) dependencies.human.render(outcome);
  else if (outcome.status === "success") stdout(`${JSON.stringify(outcome.result)}\n`);
  else stderr(`${outcome.error?.code}: ${outcome.error?.message}\n`);
  return outcome.status === "success" ? 0 : invalidExit(outcome);
}

/**
 * Reads the four things Request mode takes from argv, and refuses every token beyond them.
 *
 * Request mode reads the leaf selector, `--input-output json`, `--dry-run`, and an `--approve`
 * grant. Anything else used to be discarded without a word, so `issue list --repo owner/name
 * --input-output json` answered `host.required` while never mentioning the flag it ignored. This is
 * the mode that refuses an unknown Request key rather than guessing what the caller meant, and argv
 * is the one place it stopped behaving that way.
 *
 * A stray positional is refused alongside a stray flag. The leaf selector is the only positional
 * argv carries and its length is fixed by the family, so the boundary is exact and the rule stays
 * flat: past the selector, nothing positional is read either.
 */
function decodeRequestArgv(argv: string[], stdin: string): Invocation | CommandOutcome {
  const selector: string[] = [];
  let approval: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--input-output") {
      // Both tokens appearing anywhere is what selects this mode, so a separated pair would arrive
      // here having chosen Request mode and left its `json` to be read as something else.
      if (argv[index + 1] !== "json")
        return refused(selector, stdin, "--input-output must be followed by json");
      index += 1;
      continue;
    }
    if (token === "--approve") {
      const grant = argv[index + 1];
      // A valueless `--approve` is the mistake `pr review` invites, and it reads as an approval
      // that never arrives, which is the shape a caller is least able to tell from one that did.
      if (grant === undefined || grant.startsWith("-"))
        return refused(selector, stdin, "--approve requires its one-time grant");
      // The last grant wins. The approval protocol has the caller append the returned
      // `--approve <grant>` to the same argv, so a second one is the retry's live grant and the
      // first is the expired grant it replaces.
      approval = grant;
      index += 1;
      continue;
    }
    if (token.startsWith("-") || selectorComplete(selector))
      return refused(
        selector,
        stdin,
        `Unexpected argument '${token}'; only the leaf, --input-output json, --dry-run, and --approve <grant> belong on Request-mode argv. Send every command input in the Request input object`,
      );
    selector.push(token);
  }
  return decodeRequest(requestLeaf(selector), stdin, approval, dryRun);
}

/**
 * Refuses Request-mode argv, echoing the identity the Request carries but never got to use.
 *
 * The refusal happens before the Request is decoded, so the correlation string is read straight
 * out of the body the caller already sent rather than being dropped for a caller that has to match
 * this outcome to the invocation that produced it.
 */
function refused(selector: string[], stdin: string, message: string): CommandOutcome {
  return invalid(requestLeaf(selector), message, recoverRequestId(stdin));
}

/**
 * Reports whether the leaf selector is already whole, so the next positional is a stray.
 *
 * `api` is the one single-token family; every other leaf is exactly `<family> <leaf>`.
 */
function selectorComplete(selector: string[]): boolean {
  return selector[0] === "api" || selector.length >= 2;
}

/**
 * Names the leaf a Request-mode outcome reports, before the catalog has been consulted.
 *
 * A selector too short to name a leaf still reaches the catalog, which answers `command.not_found`
 * for it. That is a token the mode does read, so it is not argv this refuses.
 */
function requestLeaf(selector: string[]): string {
  return selector.join(" ") || "unknown";
}

/**
 * Records failures whose text has already reached the caller in plain form.
 *
 * Commander writes argv failures and the usage that follows them itself, so the Human interface
 * skips these rather than decorating a second copy of the same line.
 */
const alreadyReported = new WeakSet<CommandOutcome>();

function reportedInvalid(command: string, message: string): CommandOutcome {
  const outcome = invalid(command, message);
  alreadyReported.add(outcome);
  return outcome;
}

async function decodeHuman(
  argv: string[],
  stdin: string,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  human: HumanInterface | undefined,
  catalog: CommandDefinition[],
  agentMode = false,
): Promise<Invocation | CommandOutcome | undefined> {
  let parsed: ParsedHumanCommand | undefined;
  const program = new Command()
    .name("forgejo")
    .description("A safe CLI for Forgejo")
    .version(versionLine(), "-V, --version", "Show the version and the commit it was built on")
    .option("--agent", "Emit one typed JSON outcome without prompting or inference")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: agentMode ? () => {} : stdout,
      writeErr: agentMode ? () => {} : stderr,
      outputError: agentMode ? () => {} : stderr,
    });
  addHumanCommands(
    program,
    catalog,
    (command) => {
      parsed = command;
    },
    agentMode,
  );
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    // Help and version are answers, not failures, and commander has already written them.
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" || error.code === "commander.version")
    )
      return undefined;
    // Commander has already written the message and the usage that follows it, both as plain
    // text. Rendering the same failure again through the Human interface would repeat it inside
    // a decorated block, so this reports the outcome as already stated.
    if (error instanceof CommanderError) return reportedInvalid(commandName(argv), error.message);
    throw error;
  }
  if (!parsed)
    return agentMode ? invalid("unknown", "Agent mode requires an exact command leaf") : undefined;
  const input = await materializeInput(parsed.input, stdin, parsed.command, agentMode);
  if ("schema_version" in input) return input as CommandOutcome;
  if (parsed.command === "auth login" && input.token === undefined) {
    if (agentMode || !human?.isInteractive)
      return invalid(
        parsed.command,
        "Token is required; use an interactive terminal or --token-stdin",
      );
    const token = await human.password("Forgejo personal access token");
    if (token === undefined) return cancelled(parsed.command);
    input.token = token;
  }
  return {
    command: parsed.command,
    input,
    requestId: null,
    approval: parsed.approval,
    dryRun: parsed.dryRun,
    mode: agentMode ? "request" : "human",
  };
}

function addHumanCommands(
  program: Command,
  catalog: CommandDefinition[],
  onCommand: (command: ParsedHumanCommand) => void,
  agentMode: boolean,
): void {
  for (const definition of catalog) addLeaf(program, definition, onCommand, agentMode);
}

/**
 * Reports the positional arguments a leaf accepts, in commander's notation.
 *
 * This is the one statement of which inputs arrive positionally, so it also tells the flag
 * derivation which schema fields to leave out. Keep it in step with `assignPositionals`, which
 * reads the same arguments back into the input record.
 */
function positionalArguments(name: string): string {
  if (name === "repo list") return "[owner]";
  if (name === "repo create" || name === "repo rename") return "<name>";
  if (name === "repo clone") return "[repo] [directory]";
  if (name.startsWith("repo ")) return "[repo]";
  if (name.startsWith("issue "))
    return ["issue list", "issue create", "issue status"].includes(name) ? "" : "<index>";
  if (name.startsWith("pr ")) return ["pr list", "pr create"].includes(name) ? "" : "<index>";
  if (name === "api") return "<endpoint>";
  if (name === "workflow view" || name === "workflow run") return "<workflow>";
  if (name.startsWith("run ")) return name === "run list" ? "" : "<run>";
  return "";
}

/**
 * Reads the field names a positional argument list binds exclusively.
 *
 * Only a required positional claims its field outright, because `assignPositionals` overwrites the
 * field with it. An optional positional falls back to the flag of the same name when it is absent,
 * so that flag stays available and keeps its place in help.
 */
function positionalFields(positional: string): Set<string> {
  return new Set(Array.from(positional.matchAll(/<([^>]+)>/g), (match) => match[1]!));
}

/**
 * Reads the object shape a command's input schema accepts.
 *
 * A schema that refines itself across fields is wrapped in a `ZodEffects`, so unwrap until the
 * object carrying the shape appears rather than reading the wrapper and finding nothing.
 */
function inputShape(schema: CommandDefinition["input"]): Record<string, unknown> {
  let current: unknown = schema;
  while (current instanceof z.ZodEffects) current = current.innerType();
  return current instanceof z.ZodObject ? (current.shape as Record<string, unknown>) : {};
}

/**
 * Reports what a leaf advertises in Human mode: its positional arguments, the input fields its
 * schema accepts, and the flags derived from them. Exported so a test can hold the derivation to
 * the schema, since a field with no flag is silently unreachable from argv.
 */
export function humanSurface(definition: CommandDefinition): {
  positional: string;
  fields: string[];
  options: OptionDefinition[];
} {
  const positional = positionalArguments(definition.name);
  return {
    positional,
    fields: Object.keys(inputShape(definition.input)),
    options: leafOptions(definition, positional),
  };
}

/** Reports the flags a leaf advertises, which are exactly those its input schema accepts. */
function leafOptions(definition: CommandDefinition, positional: string): OptionDefinition[] {
  const bound = positionalFields(positional);
  const overrides = commandFieldOptions[definition.name] ?? {};
  return Object.keys(inputShape(definition.input))
    .filter((field) => !bound.has(field))
    .flatMap((field) => overrides[field] ?? fieldOptions[field] ?? []);
}

function addLeaf(
  program: Command,
  definition: CommandDefinition,
  onCommand: (command: ParsedHumanCommand) => void,
  agentMode: boolean,
): void {
  const name = definition.name;
  const positional = positionalArguments(name);
  const [family, leaf] = name.split(" ");
  const parent =
    leaf === undefined
      ? program
      : (program.commands.find((candidate) => candidate.name() === family) ??
        program.command(family!).description(familyDescriptions[family!] ?? ""));
  const command = parent
    .command(`${leaf ?? family}${positional ? ` ${positional}` : ""}`)
    .description(definition.description);
  const approvalValues: unknown[] = [];
  command.on("option:approve", (value: unknown) => approvalValues.push(value));
  const repeated = new Set(repeatableOptions(name));
  for (const [flags, help] of [...commonOptions, ...leafOptions(definition, positional)]) {
    if (repeated.has(flags))
      command.option(
        flags,
        help ?? "Repeatable option",
        (value: string, previous: string[] = []) => [...previous, value],
      );
    else command.option(flags, help);
  }
  command.action((...arguments_: unknown[]) => {
    const commandOptions = arguments_.at(-1) as Command;
    const input = optionInput(commandOptions.opts());
    const positionals = arguments_
      .slice(0, -1)
      .filter((value): value is string => typeof value === "string");
    assignPositionals(name, positionals, input, agentMode);
    const approve = commandOptions.opts().approve;
    if (
      name === "pr review" &&
      (approve === true || approvalValues.some((value) => value === true))
    )
      input.approve = true;
    onCommand({
      command: name,
      input,
      approval:
        [...approvalValues].reverse().find((value): value is string => typeof value === "string") ??
        (typeof approve === "string" ? approve : undefined),
      dryRun: commandOptions.opts().dryRun === true,
    });
  });
}

function repeatableOptions(name: string): string[] {
  if (name.startsWith("issue ") || name.startsWith("pr "))
    return ["--label <label>", "--assignee <login>", "--reviewer <login>"];
  if (name === "api")
    return ["--header <name:value>", "--raw-field <name=value>", "--field <name=value>"];
  if (name.startsWith("workflow ") || name.startsWith("run "))
    return ["--field <name=value>", "--artifact <name>"];
  return [];
}

function optionInput(options: Record<string, unknown>): Record<string, unknown> {
  const aliases: Record<string, string> = {
    bodyFile: "body_file",
    defaultBranch: "default_branch",
    dueDate: "due_date",
    fastForwardOnly: "fast_forward_only",
    jobId: "job_id",
    logFailed: "log_failed",
    matchHead: "match_head",
    rawField: "raw_field",
    rebaseMerge: "rebase_merge",
    runNumber: "run_number",
    tokenStdin: "token_stdin",
    whenChecksSucceed: "when_checks_succeed",
    exitStatus: "exit_status",
    deleteBranch: "delete_branch",
  };
  return Object.fromEntries(
    Object.entries(options)
      .filter(
        ([key, value]) =>
          key !== "agent" && key !== "approve" && key !== "dryRun" && value !== undefined,
      )
      .map(([key, value]) => [aliases[key] ?? key, numericOrDurationValue(key, value)]),
  );
}

function numericOrDurationValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (["page", "limit", "runNumber", "jobId"].includes(key)) return Number(value);
  if (["interval", "timeout"].includes(key)) return durationFlag(value);
  if (key === "archived") return value === "true" ? true : value === "false" ? false : value;
  return value;
}

function assignPositionals(
  name: string,
  positionals: string[],
  input: Record<string, unknown>,
  agentMode: boolean,
): void {
  if (name === "repo list") {
    if (positionals[0]) input.owner = positionals[0];
  } else if (name === "repo create" || name === "repo rename") input.name = positionals[0];
  else if (name === "repo clone") {
    input.repo = positionals[0] ?? input.repo;
    if (positionals[1]) input.directory = positionals[1];
  } else if (name.startsWith("repo ")) input.repo = positionals[0] ?? input.repo;
  else if (
    name.startsWith("issue ") &&
    !["issue list", "issue create", "issue status"].includes(name)
  )
    input.index = Number(positionals[0]);
  else if (name.startsWith("pr ") && !["pr list", "pr create"].includes(name))
    input.index = Number(positionals[0]);
  else if (name === "api") input.endpoint = positionals[0];
  else if (name === "workflow view" || name === "workflow run") input.workflow = positionals[0];
  else if (name.startsWith("run ") && name !== "run list")
    input.run = parseRunSelector(name, positionals[0] ?? "", input, agentMode);
}

async function materializeInput(
  input: Record<string, unknown>,
  stdin: string,
  command: string,
  agentMode = false,
): Promise<Record<string, unknown> | CommandOutcome> {
  if (input.token_stdin === true) {
    input.token = stdin.trimEnd();
    delete input.token_stdin;
  }
  if (input.body !== undefined && input.body_file !== undefined)
    return invalid(command, "--body and --body-file are mutually exclusive");
  if (typeof input.body_file === "string") {
    try {
      input.body = await readFile(input.body_file, "utf8");
    } catch {
      return invalid(command, "Could not read --body-file");
    }
    delete input.body_file;
  }
  if (typeof input.input === "string") {
    if (input.input === "-") input.input = stdin;
    else
      try {
        input.input = new Uint8Array(await readFile(input.input));
      } catch {
        return invalid("api", "Could not read --input");
      }
  }
  const job = foldJobSelector(input, command);
  if (job) return job;
  if (agentMode && input.run && typeof input.run === "object" && "schema_version" in input.run)
    return input.run as CommandOutcome;
  return input;
}

/**
 * Folds `--job` and `--job-id` into the one job selector the Actions commands accept.
 *
 * Request mode passes the selector object directly, so Human mode has to build the same shape;
 * without this the flags reach the schema as a bare string and an unknown `job_id` key.
 */
function foldJobSelector(
  input: Record<string, unknown>,
  command: string,
): CommandOutcome | undefined {
  const name = input.job;
  const id = input.job_id;
  if (name === undefined && id === undefined) return undefined;
  if (name !== undefined && id !== undefined)
    return invalid(command, "--job and --job-id are mutually exclusive");
  delete input.job_id;
  if (id === undefined) {
    input.job = { kind: "name", value: String(name) };
    return undefined;
  }
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0)
    return invalid(command, "--job-id must be a positive integer");
  input.job = { kind: "id", value: id };
  return undefined;
}

function parseRunSelector(
  command: string,
  value: string,
  input: Record<string, unknown>,
  agentMode: boolean,
): { kind: "id" | "number"; value: number } | CommandOutcome {
  if (/^\d+$/.test(value)) return { kind: "id", value: Number(value) };
  if (agentMode)
    return invalid(
      command,
      "Agent mode requires a stable run ID and does not infer Host or repository from a URL",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(command, "Run selector must be a stable ID or Actions run URL");
  }
  const match = /^(.*)\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)$/.exec(url.pathname);
  if (!match) return invalid(command, "Job URLs are not valid run selectors");
  const repo = `${match[2]}/${match[3]}`;
  const deployment = `${url.origin}${match[1]}`;
  if (input.repo !== undefined && input.repo !== repo)
    return invalid(command, "Run URL repository conflicts with --repo");
  if (input.host !== undefined) {
    try {
      if (new URL(String(input.host)).origin !== url.origin)
        return invalid(command, "Run URL Host conflicts with --host");
    } catch {
      // Hostname shorthands are resolved by RepositoryContext after URL parsing.
    }
  }
  input.repo = repo;
  input.host ??= deployment;
  return { kind: "number", value: Number(match[4]) };
}

function durationFlag(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(value);
  if (!match) return Number.NaN;
  const multiplier = match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1;
  return Number(match[1]) * multiplier;
}

function commandName(argv: string[]): string {
  const selector = argv.filter((argument) => argument !== "--agent");
  return selector[0] === "api" ? "api" : selector.slice(0, 2).join(" ") || "unknown";
}

/** Creates the no-stdin typed CLI metadata outcome used by the Paired skill. */
function versionOutcome(
  argv: string[],
  catalog: CommandDefinition[],
  modeFlag: "--agent" | "--input-output",
): CommandOutcome {
  const expected = new Set(
    modeFlag === "--agent" ? ["--version", "--agent"] : ["--version", "--input-output", "json"],
  );
  if (argv.length !== expected.size || argv.some((argument) => !expected.has(argument)))
    return invalid(
      "version",
      `Expected --version ${modeFlag === "--agent" ? "--agent" : "--input-output json"} without command input flags`,
    );
  return {
    schema_version: schemaVersion,
    request_id: null,
    command: "version",
    status: "success",
    result: {
      cli_version: cliVersion,
      // Kept beside `cli_version` rather than folded into it, so the version stays strict semver
      // for a caller checking it against a supported range. Two builds can report the same
      // version, and only the commit tells them apart.
      build: { commit: buildStamp.commit, source: buildStamp.source },
      request_schema_version: schemaVersion,
      commands: catalog
        .map((definition) => ({
          name: definition.name,
          mutation: definition.mutation,
          description: definition.description,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    },
    error: null,
    context: {},
    effects: [],
    diagnostics: [],
    next_steps: [],
  };
}

function approvalMessage(outcome: CommandOutcome): string {
  const effects = outcome.effects.map((effect) => `${effect.action} ${effect.target}`);
  return [`Run ${outcome.command}?`, ...effects].join("\n");
}

function approvalFrom(outcome: CommandOutcome): string | undefined {
  const approve = outcome.error?.details.approve;
  return typeof approve === "string" && approve.startsWith("--approve ")
    ? approve.slice("--approve ".length)
    : undefined;
}

function invalid(
  command: string,
  message: string,
  requestId: string | null = null,
): CommandOutcome {
  return failed(command, "argv.invalid", message, requestId);
}

function cancelled(command: string): CommandOutcome {
  return failed(command, "command.cancelled", "Command cancelled");
}

function failed(
  command: string,
  code: string,
  message: string,
  requestId: string | null = null,
): CommandOutcome {
  return {
    schema_version: 1,
    request_id: requestId,
    command,
    status: "error",
    result: null,
    error: { code, message, details: {} },
    context: {},
    effects: [],
    diagnostics: [],
    next_steps: [],
  };
}
function invalidExit(outcome: CommandOutcome): number {
  return outcome.error?.code === "argv.invalid" || outcome.error?.code === "request.invalid"
    ? 2
    : 1;
}
function smokeDependencies(): CliDependencies {
  return {
    catalog: [...createSmokeCatalog(), ...createAuthCatalog()],
    capabilities: {
      gateway: { smoke: async ({ value }) => ({ echoed: value }) },
      host: undefined,
      repositories: undefined,
      git: undefined,
      issues: undefined,
      pullRequests: undefined,
      environment: {},
      cwd: process.cwd(),
      clock: { now: () => new Date("2025-01-01T00:00:00.000Z") },
      cancelled: () => false,
    },
    human: undefined,
  };
}
