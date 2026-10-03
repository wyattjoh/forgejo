---
name: forgejo
description: 'Routes agent work through deterministic `forgejo --agent` mode instead of Human mode, covering repo, issue, pr, workflow, run, auth, and raw api leaves against a Forgejo host. Triggers on "forgejo", "Forgejo", "forgejo issue", "forgejo pr", "forgejo repo", "forgejo run", "forgejo api", "forgejo auth login", "--agent", "Request mode", "--input-output json", "approval.required", "Codeberg". Not for GitHub repositories, which use `gh`.'
allowed-tools: Bash(forgejo:*), Read
effort: medium
---

# forgejo

`forgejo` is a macOS command-line client for Forgejo 16.0.2 with three modes.
Human mode renders readable output, infers context, and prompts. Agent mode uses
ordinary schema-derived flags while disabling prompts and Host/repository
inference, then writes exactly one typed Command outcome. Request mode retains
the lower-level versioned JSON envelope.

Generated from `forgejo` v0.2.0. This skill supports CLI versions `>=0.2.0 <0.3.0` and Request schema version `1`.

## Use Agent mode, not Human mode

| Don't                                                                    | Do                                                                            | Why it matters                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| `forgejo issue list --repo owner/name`                                   | `forgejo issue list --agent --host https://forgejo.example --repo owner/name` | Without `--agent`, Human mode may infer or prompt |
| Pipe a JSON Request for an ordinary call                                 | Use the leaf's normal flags with `--agent`                                    | Agent mode removes envelope quoting               |
| Scrape Human output                                                      | Parse the single JSON Command outcome                                         | Human rendering is not a contract                 |
| Branch on error prose or the exit code alone                             | Branch on `error.code`                                                        | Codes are stable and namespaced                   |
| Improvise a GitHub-shaped command such as `pr ready` or `issue transfer` | Route only to a leaf in the generated table below                             | An unsupported intent must stop                   |
| Retry a mutation that came back with work already done                   | Read `effects[].state` and reconcile                                          | A blind retry can duplicate completed work        |

### Agent-mode shape

```sh
forgejo <family> <leaf> --agent [normal leaf flags] [--dry-run] [--approve GRANT]
```

`api` remains a single-token family. Required positional values remain
positional: for example, create a repository with
`forgejo repo create NAME --agent --host HOST --owner OWNER`, not `--name NAME`.
Repeat list flags such as `--label`, `--assignee`, `--reviewer`, `--header`, and
`--field`. Agent mode normalizes
numbers, durations, job selectors, and stable numeric run IDs, then the catalog
schema performs authoritative strict validation. It rejects unknown flags,
missing values, Actions run URLs, and `--help`; use help without `--agent`.
Outcomes have `request_id:null`; Agent mode invents neither correlation nor an
idempotency key.

Two positional families are easy to mistake for flags:

```sh
forgejo api ENDPOINT --agent --host HOST
forgejo run view RUN_ID --agent --host HOST --repo OWNER/REPO
forgejo run cancel RUN_ID --agent --host HOST --repo OWNER/REPO
forgejo run delete RUN_ID --agent --host HOST --repo OWNER/REPO
forgejo run download RUN_ID --agent --host HOST --repo OWNER/REPO --artifact NAME --dir DIR
forgejo run watch RUN_ID --agent --host HOST --repo OWNER/REPO
forgejo run rerun RUN_ID --agent --host HOST --repo OWNER/REPO
```

There is no `--endpoint` or `--run` flag. In Agent mode, a numeric `RUN_ID` is
the stable Host-wide run ID. Selecting by repository run number is available
only through Request mode's structured `run` selector.

Agent mode never prompts or selects context. Supply `--host` and `--repo`
explicitly where needed. `FORGEJO_HOST` and Git remotes are Human-mode-only
conveniences. `--token-stdin`, `--body-file`, and `--input` are explicit byte
sources, not inference.

Request mode remains available for callers that require a versioned envelope:

```sh
forgejo <family> <leaf> [--approve GRANT] [--dry-run] --input-output json < request.json
```

## Local setup

- `forgejo` must be on `PATH`. It stores tokens with `Bun.secrets`: the login
  Keychain on macOS, and the Secret Service through libsecret on Linux. A
  missing libsecret or locked keyring surfaces as `keychain.failed`.
- Apple Silicon macOS and x86-64 Linux only. There is no Windows, Intel Mac,
  or ARM Linux build, and no Homebrew distribution.
- One active identity per Forgejo Deployment URL.
- Static shell completions ship in the release archive's `completions/`
  directory.

| Env var              | Purpose                                                       |
| -------------------- | ------------------------------------------------------------- |
| `FORGEJO_HOST`       | Default Host for **Human mode only**. Request mode ignores it |
| `FORGEJO_CONFIG_DIR` | Override the Host profile store directory                     |
| `FORGEJO_CACHE_DIR`  | Override the advertised Swagger contract cache directory      |

## Compatibility check

Before every routed invocation, run this no-stdin metadata command and parse its
one JSON outcome:

```sh
forgejo --version --agent
```

argv must be exactly those two tokens in any order. The legacy
`forgejo --version --input-output json` form returns the same metadata. Adding a command or any
other flag returns `argv.invalid`. Proceed only when all four hold:

- `status` is `"success"`,
- `result.cli_version` falls inside the supported range above,
- `result.request_schema_version` is `1`, and
- the exact leaf you intend to run appears as a `result.commands[].name`.

`result.commands` is an array of
`{"name":"issue list","mutation":false,"description":"..."}` objects sorted by
name, so it also reports which leaves are unconditionally approval-gated and
what each one does. Otherwise stop without invoking the target command and tell
the caller to install a compatible `forgejo` release.

`result.build` reports which binary answered, as
`{"commit":"a1b2c3d4e5f6","source":"release"}`. `source` is `release` for a
binary cut by the release workflow, `dev` for one built locally, and `source`
for an unbuilt tree. Read it when a command misbehaves in a way the
documentation says is fixed: `cli_version` alone cannot distinguish two builds
of the same unreleased version, so a `dev` build whose `commit` is behind the
repository is the likely explanation before the defect is. A `commit` ending in
`-dirty` was built from uncommitted changes and describes nothing reproducible.

## Request envelope reference

The rest of this reference documents the lower-level Request envelope. Translate
an `input` field to its same-named kebab-case Agent flag when representable; the
generated table remains the authoritative catalog field list. Use the Request
shape for nested selectors when needed, or the Agent shorthands documented
above.

`api` is the one single-token family: `forgejo api --input-output json`. Request
mode activates when both `--input-output` and `json` appear in argv. There is no
`--input-output human`; omit both mode selectors for Human mode.

## The Request envelope

One UTF-8 JSON object on stdin, at most 1 MiB:

```json
{ "schema_version": 1, "request_id": "issue-list-1", "input": {} }
```

All three keys are required and unknown keys are rejected. `request_id` is a
caller-chosen correlation string matching `^[A-Za-z0-9._:-]{1,128}$`, echoed on
every outcome recoverable enough to carry it. It is neither authorization nor an
idempotency key. A `schema_version` other than `1` returns
`request.unsupported_version`.

**Every command input belongs in `input`.** Never pass command values through
argv, environment variables, or Human-mode prompts. Only the leaf selector,
`--approve <grant>`, `--dry-run`, and `--input-output json` belong on argv, in
any order. Request mode refuses anything else, naming the offending token in an
`argv.invalid` outcome before the command runs: a Human-mode flag such as
`--repo owner/name`, a positional past the leaf, and a valueless `--approve` are
all refused rather than ignored.

### `host` and `repo` are required in Request mode

The generated table lists `host` and `repo` as optional input because they are
optional in the schema, but Request mode refuses to infer either one:

- Every Host-backed leaf needs an explicit `input.host` matching a configured
  profile, or the outcome is `host.required`. `FORGEJO_HOST` and Git-remote
  inference are Human-mode conveniences.
- Every repository-scoped leaf needs an explicit `input.repo` as `OWNER/NAME`,
  or the outcome is `repo.required`. A malformed selector fails the input schema
  first, so it reports `request.invalid` with a regex issue, not `repo.invalid`.

### Input shapes the generated table cannot express

| Input                           | Request shape                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`, `assignee`, `reviewer` | Arrays of strings, not repeated flags: `"label": ["bug", "p1"]`                                                                                             |
| `run`                           | `{"kind":"id","value":1481}` for a stable run ID, or `{"kind":"number","value":7}` for a repository run index. The Actions run URL is Human-mode argv sugar |
| `job`                           | `{"kind":"id","value":45}` or `{"kind":"name","value":"build"}`                                                                                             |
| `interval`, `timeout`           | Numbers of **seconds**, at most 3600; `interval` is at least 1. Agent/Human flags also accept `5s` and `1m` strings                                         |
| `page`, `limit`                 | Integers. `page` defaults to 1 and caps at 1000; `limit` defaults to 30 and caps at 100                                                                     |
| `method` (`api`)                | Defaults to `GET` and is upper-cased before validation                                                                                                      |
| `body_file`, `token_stdin`      | Agent/Human argv only. In Request mode, read the file yourself and send `body` or `token`                                                                   |

## Approval protocol

Every leaf marked `yes` in the table is approval-gated. `api` is marked
`conditional`: read-only for `GET`, approval-gated for every other method it
accepts.

In Agent mode, send the normal flags with no `--approve`, review the typed
outcome, then repeat the same command values and append the `grant` from its
`next_steps` approve action as `--approve <grant>`. The Request-envelope form
uses the equivalent steps below.

1. Send the Request with no `--approve`. An approval-gated command answers
   `status:"error"` with `error.code` of `approval.required`, the planned
   `effects`, `error.details.plan_digest`, and `error.details.approve`.
2. `error.details.approve` is the complete argv pair, for example
   `--approve 9f2c...:2938`. Append those two tokens verbatim to the same argv
   and re-send the byte-identical Request.

Rules:

- Use only the returned grant. Never invent, widen, cache, or reuse one across
  commands.
- The grant is `<plan digest>:<10-minute wall-clock bucket>`, so it can expire
  seconds after it is issued. If the retry answers `approval.required` again,
  read the **new** `error.details.approve` and re-send promptly. Do not loop more
  than once without reporting back to the caller.
- The digest covers the normalized command input. Changing any input value
  invalidates the grant, so reuse the exact Request string rather than
  recomposing it.
- Re-run the compatibility check before the approved invocation.
- `run rerun` runs its Host capability preflight _before_ issuing a grant, so
  `error.details.target` and `error.details.context` describe the real run you
  are about to restart. Read them before approving.

### `pr review` overloads the word "approve"

`input.approve: true` is the review event (`APPROVED`); omit it for a `COMMENT`
review, or send `input.request_changes: true`. The argv `--approve <grant>` is
the mutation approval grant. Keep them separate, and never put a valueless
`--approve` flag in Request-mode argv. Forgejo also rejects a review that
approves your own pull request; expect a `pull_request.*` error, not a no-op.

### Dry runs

`--dry-run` is argv-only in Request mode; there is no `dry_run` input field. It
applies only to approval-gated invocations, so on a read-only leaf it is ignored
and the command really executes. A dry run returns `status:"success"`,
`context.plan_digest`, and the planned `effects`. It does **not** return a usable
grant, so a real run still starts at step 1.

## Reading a Command outcome

Exactly one newline-terminated JSON object on stdout, at most 8 MiB before it is
replaced by `result.too_large`.

| Field         | Read it for                                                                               |
| ------------- | ----------------------------------------------------------------------------------------- |
| `status`      | `"success"` or `"error"`, nothing else                                                    |
| `result`      | Typed payload, or `null` on a total failure                                               |
| `error`       | `{code, message, details}`. Branch on `code`                                              |
| `context`     | Safe provenance such as `plan_digest`, resolved repository, Host selection source         |
| `effects`     | Ordered ledger. Each `state` is `planned`, `skipped`, `succeeded`, `failed`, or `unknown` |
| `diagnostics` | Bounded, redacted supporting output: at most 16 entries, 16 KiB each, 64 KiB total        |
| `next_steps`  | Typed recoveries, only when already known. Often `[]`. See "Error codes and recovery"     |

**A partial outcome has `status:"error"` and a non-null `result`.** Real work
landed. `auth login` returning `auth.git_config_failed` persisted the credential
and the Host profile but failed to configure the Git credential helper.
`issue create` with labels is a two-effect plan that can create the issue and
then fail label replacement. Report exactly which effects succeeded, and never
blind-retry.

### `planned` means no evidence it was sent, `unknown` means maybe

Reconcile against the ledger, and read these two states exactly:

- `planned` on a failed command means this client has no evidence the request
  left it. A failure before the send, including one from a read the command made
  first, lands here.
- `unknown` means the Host answered, or began answering, and this client cannot
  say what came of the request. **Never retry an `unknown` effect.** Read the
  Host's own state first, with `pr view`, `run list`, or `api` against the same
  resource.

An `unknown` carries why it is unknown in its `details`: `transmitted: true`
when the mutation was sent and the failure came after, `scheduled: true` for a
merge the Host accepted and will run later.

**One residual gap.** The evidence is the Host's answer, so a connection that
dies after the request was written but before any answer arrives cannot be told
apart from one that never connected. Both report `planned` under a `*.network`
code. For a non-idempotent mutation, `workflow run` above all, confirm against
the Host with `run list` or the matching read before retrying a `planned` effect
that failed that way.

Exit codes are `0` for success, `2` for `argv.invalid` and `request.invalid`, and
`1` for everything else including a partial outcome. Read the outcome, not the
exit code.

### `pr merge`: read `scheduled` before reporting a merge

With `when_checks_succeed: true`, Forgejo may schedule the merge rather than
perform it. That outcome is `status:"success"` with `result.scheduled: true`
and the merge effect in state `unknown` carrying `details.scheduled: true`: the
Host accepted the merge and will run it later, so nothing has merged yet and no
branch was deleted. Only `scheduled: false` with `succeeded` effects means the
pull request is merged now.

With `delete_branch: true`, Forgejo deletes the head branch inside the merge
call, after the merge itself has landed, and answers a refusal (a protected or
default head branch) as the call's own failure. `pr merge` asks the pull request
what actually happened before reporting, so that outcome is a partial one:
`status:"error"` with `error.code` `pull_request.branch_delete_failed`,
`result.scheduled: false`, and the ledger reading `pull_request.merge`
`succeeded` with `branch.delete` `failed`. The merge is done; delete the branch
yourself or leave it. A merge the Host refused outright reports both effects
`failed`, and one it will not confirm either way reports them `unknown`.

Collections are bounded at 1000 items and set a `truncated` flag.

### Bounded delivery writes bytes to a file

In Request mode, `pr diff`, `run view` with logs, `run download`, and any
non-JSON, non-text `api` response are never inlined. They return
`{"path":..., "bytes":..., "media_type":..., "sha256":...}`. Set `input.output`
to choose the destination, then Read that path. A binary `api` response with no
`output` fails `api.output_required`. On a write, that failure comes after the
Host answered, so the `api.request` effect reports `unknown`: the write landed
and only its answer was undeliverable. Never repeat the call to get the file;
re-read the resource instead.

**Logs and artifacts have no size ceiling; everything else does.** `run view`
logs and `run download` artifacts are streamed straight to the destination, so
they are bounded by the disk they land on rather than by this client, and the
reported `bytes` and `sha256` describe the whole file. Every other response is
read into memory up to 16 MiB. Past that it is refused, never truncated, with
`<namespace>.response_too_large` carrying `details.limit_bytes`,
`details.response_bytes` (null when the Host advertised no length), and
`details.status`. Compare the two sizes to tell whether the request is possible
at all: a body far past the limit needs narrowing with `page` or `limit`, not a
retry. The transport worked in that case, which is why it is not a `*.network`
failure. A `details.status` other than 2xx means an oversized error page, so
treat it as that status rather than as an answer to narrow.

## Common workflows

### Verify the CLI, then read

```sh
forgejo --version --input-output json

printf '%s\n' '{"schema_version":1,"request_id":"issue-list-1","input":{"host":"https://forgejo.example","repo":"wyattjoh/project","state":"open","limit":50}}' \
  | forgejo issue list --input-output json
```

### Log in to a Host

Prefer letting a person run Human mode, which prompts for the token with masked
input and never places it in argv:

```sh
forgejo auth login --url https://forgejo.example
```

`auth login` is the one Request whose `input` carries a secret:

```json
{
  "schema_version": 1,
  "request_id": "auth-1",
  "input": { "url": "https://forgejo.example", "token": "<personal access token>" }
}
```

If you must send it, read the token from a secret store at the point of use,
never persist the Request document to a file or a log, and never place a token
in argv or an environment variable. Outcomes redact token-like keys and
`token=`/`bearer` patterns before serialization, so the secret never reaches
`result`, `effects`, or `diagnostics`. `auth login` is also a mutation, so it
goes through the two-step approval below.

### Approve a mutation, the two-step

```sh
request='{"schema_version":1,"request_id":"issue-create-1","input":{"host":"https://forgejo.example","repo":"wyattjoh/project","title":"Flaky pr checks","body":"Fails on rerun.","label":["bug"]}}'

printf '%s\n' "$request" | forgejo issue create --input-output json
# {"status":"error","error":{"code":"approval.required","details":{"plan_digest":"9f2c...","approve":"--approve 9f2c...:2938"}},"effects":[{"effect_id":"issue.create","state":"planned",...}]}

printf '%s\n' "$request" | forgejo issue create --approve 9f2c...:2938 --input-output json
```

Reuse the same `request` variable. Recomposing the document with any different
value changes the plan digest and invalidates the grant.

### Preview a destructive mutation first

```sh
printf '%s\n' '{"schema_version":1,"request_id":"repo-delete-preview","input":{"host":"https://forgejo.example","repo":"wyattjoh/scratch"}}' \
  | forgejo repo delete --dry-run --input-output json
```

### `workflow list` and `workflow view` are local, not remote

These two leaves take no `host` and no `repo` because they never contact the
Host. They read `.forgejo/workflows/` and `.github/workflows/` from the **current
working directory** and return `result.source: "local"`. Run them from the
checkout you mean, and never present their output as the workflows configured on
a remote repository.
`workflow run`, and the whole `run` family, are genuinely remote and do take
`host` and `repo`.

### Watch an Actions run

```sh
printf '%s\n' '{"schema_version":1,"request_id":"run-watch-1","input":{"host":"https://forgejo.example","repo":"wyattjoh/project","run":{"kind":"id","value":1481},"interval":10,"timeout":900}}' \
  | forgejo run watch --input-output json
```

Watching never fails on a timeout. It returns `result.complete`,
`result.watching`, and `result.attempts`, and `timeout` is its only bound: it
polls at `interval` until the run settles or the budget elapses, whichever comes
first, and never sleeps past the budget. `interval` has a one-second floor.
Check `result.complete` before reporting that a run finished; a run still
`waiting`, `running`, `blocked`, or `unknown` has not.

`run watch`, `workflow run` with `watch: true`, and `pr checks` with
`watch: true` all share one polling loop, so all three treat failure the same
way. A poll that fails **part way through** a watch costs one interval and the
next poll is tried, so a single bad answer from the Host does not discard the
wait. A failure still live when the budget runs out is reported, not disguised
as an unfinished watch, which means a Host that keeps refusing can take up to
the whole `timeout` to surface its error. A failure on the **first** poll is
reported immediately without waiting, since nothing has been established to wait
on and a rejected token or an absent target never becomes transient.

### Gate a merge on `pr checks`

```sh
printf '%s\n' '{"schema_version":1,"request_id":"pr-checks-1","input":{"host":"https://forgejo.example","repo":"wyattjoh/project","index":42,"watch":true,"interval":10,"timeout":600}}' \
  | forgejo pr checks --input-output json
```

Read three result fields together:

- `state` is the Host's own rollup of the head commit's statuses.
- `passing` follows Forgejo's status-check gate: true only when the checks are settled
  and the rollup is `success`. A `skipped` or `warning` rollup is not passing,
  matching what the Host enforces where a branch protection rule requires
  status checks. Where no rule requires them the Host will merge anyway, so
  `passing: false` is the conservative answer rather than a refusal.
- `complete` means settled, **not** passing: no check is still `pending`. A
  failed run is `complete` with `passing: false`.

An empty check list never counts as settled, so a repository with no CI
configured never reports `complete` and `watch: true` runs out its full
`timeout`. Read `total_count` to tell "no CI" from "checks still arriving".

### Rerun a failed run, which needs a Host extension

```sh
printf '%s\n' '{"schema_version":1,"request_id":"run-rerun-1","input":{"host":"https://forgejo.example","repo":"wyattjoh/project","run":{"kind":"id","value":1481}}}' \
  | forgejo run rerun --input-output json
```

`run rerun` needs the versioned, token-authenticated `actions-rerun@1` extension
exposing both the `run` and `job` routes. The probe runs before a grant is
issued, so an unsupported Host returns `capability.unsupported` and no approval.
Do not retry the mutation; upgrade the Host or use a supported command.

### Notes on the Actions surface

- A run reports Forgejo's own field names: `title`, `status`, `commit_sha`,
  `prettyref`, `created`, `updated`. There is no run-level `conclusion` or
  `attempt`; `attempt` exists only per job.
- `run list` accepts a short branch name for `ref` (`"main"` becomes
  `refs/heads/main`) and the `#12` pull form. A tag is indistinguishable from a
  branch once shortened, so it still needs the full `refs/tags/...`.
- `workflow run` dispatches on the Host without reading your working directory,
  and returns the created run. That run is thin, carrying its ids and web URL
  with the remaining fields null, so re-read it with `run view` for its fields.
  With `watch: true` it follows the shared watch-failure rules above, and a
  failure that survives them reports `partial_error` with the dispatch effect
  succeeded: the run is queued, so do not re-dispatch. A dispatch whose answer
  arrives and then cannot be read or understood (`actions.invalid_response`,
  `actions.response_too_large`, and `actions.network` once an answer had begun)
  reports the effect `unknown` with `details.transmitted`, which means the same
  thing: the Host has the request.
  A dispatch that fails with `actions.network` before any answer arrived reports
  `planned`, and that case cannot be distinguished from a connection the Host
  never read. Confirm with `run list` either way rather than dispatching again.
- `workflow run` inputs go through `field` only, as `"field": ["count=3"]`, and
  each value is sent to the Host exactly as written. Forgejo's contract declares
  dispatch inputs as a map of strings, so `count=3` arrives as `"3"` and
  `enabled=true` as `"true"`, and the workflow reads the string the caller
  wrote. Split on the first `=`, so the rest of the value may contain more.
  A value carrying structure is simply its own JSON text
  (`config={"retries":2}`), delivered verbatim for the workflow to parse. There
  is no `raw_field` here: it exists on `api`, whose body is arbitrary JSON, and
  there it is the form that suppresses JSON parsing. Passing `raw_field` to
  `workflow run` fails `request.invalid`.
- Per-job data comes from `run view` with `job`, and failed-job logs from
  `log_failed`. The two are mutually exclusive, since `log_failed` selects the
  failed jobs itself.
- `run cancel` against an already-completed run is a silent no-op success, not
  an error, so it is not evidence that a cancel took effect.
- `artifact` is an array of strings (`"artifact": ["build-output"]`), not a
  bare string. A bare string fails `request.invalid`.

### The `api` escape hatch

```sh
printf '%s\n' '{"schema_version":1,"request_id":"api-1","input":{"host":"https://forgejo.example","endpoint":"/repos/wyattjoh/project/releases","limit":10}}' \
  | forgejo api --input-output json
```

**`endpoint` is relative to the Swagger `basePath`, and the `/api/v1` prefix is
also accepted.** `/version` and `/api/v1/version` resolve to the same advertised
operation. The path must start with a single `/` and contain no `..` segment,
and the operation must be advertised in the Host's cached Swagger contract.

A trailing path parameter may span `/` where the contract describes no deeper
route matching those segments, so a multi-segment `{filepath}` such as
`PUT /repos/{owner}/{repo}/contents/docs/guide.md` resolves, and so does a head
branch containing `/` (such as `feature/login`) on
`/repos/{owner}/{repo}/pulls/{base}/{head}`. A parameter the contract types as an
id never spans `/`, so `/repositories/1/2/3` is refused as
`api.operation_not_advertised` rather than sent and answered with a not found.

A response status that operation does not advertise is
`api.unexpected_response`. `api` validates the advertised contract; it never
turns a private web route into an API capability. `api` serves GET, POST, PUT,
PATCH, and DELETE; `HEAD` and `OPTIONS` are refused as `api.method_unsupported`,
because the contract declares no operation under either, so neither is a way to
test whether something exists. Any method other than GET is approval-gated and
goes through the same two-step. `all` is GET-only: combining it with POST, PUT,
PATCH, or DELETE fails `request.invalid` before approval and before any request
reaches the Host.

`header`, `field`, and `raw_field` are arrays of strings, not objects:
`"field": ["name=value"]`, `"header": ["Accept: application/json"]`.

For an `api` write, send the body as `field`/`raw_field` pairs or as `input`
holding a **JSON-encoded string**. The CLI sends `Content-Type: application/json`
for `field`/`raw_field` bodies, and for an `input` body whose bytes parse as
JSON; any other `input` goes unlabelled. A `Content-Type` in `header` always
wins. On `api`, and only on `api`,
`field` values are JSON-parsed, so a base64 or numeric-looking value needs its
own quoting (`content="aGk="`); `raw_field` keeps a value verbatim, quotes
included. `workflow run` has no `raw_field`, because its `field` already sends
the value verbatim.

### Fetch a pull request diff

```sh
printf '%s\n' '{"schema_version":1,"request_id":"pr-diff-1","input":{"host":"https://forgejo.example","repo":"wyattjoh/project","index":42,"patch":true,"output":"/tmp/pr-42.patch"}}' \
  | forgejo pr diff --input-output json
```

Request mode always delivers the diff as bytes. Read the returned `result.path`;
the inline `diff` string exists only in Human mode.

### `pr checkout` writes to the current working directory

```sh
printf '%s\n' '{"schema_version":1,"request_id":"pr-checkout-1","input":{"host":"https://forgejo.example","repo":"wyattjoh/project","index":42,"remote":"origin"}}' \
  | forgejo pr checkout --input-output json
```

This leaf changes the Git working tree the caller is standing in: it fetches
`pull/<index>/head` into a local branch and switches to it, in the **current
working directory**, moving `HEAD` and rewriting tracked files. `repo clone`,
and `repo fork` with `clone: true`, also write to the filesystem, but they build
a new tree in a subdirectory instead of changing the one you are in. Run this
one from the checkout you mean.

Request mode never infers a Git remote, so `input.remote` is required there, and
an approved invocation missing it answers `git.remote_required` with the
checkout effect `failed`. Name a remote of that directory that points at
`input.repo`, since only the repository holding the pull request publishes that
ref; the CLI passes the name to Git rather than checking it, so a remote
pointing elsewhere fetches from elsewhere. Once a remote is resolved the
checkout effect carries it in `details.remote`, so an outcome names the source
it fetched from; `git.remote_required` is the one that cannot, because it
reports that no remote was resolved.

`input.branch` names the local branch and defaults to `pr-<index>`.
**`input.force: true` destroys work, committed as well as uncommitted.** It
becomes `git fetch --force` and `git switch --force`. Forcing the switch
discards uncommitted changes in the working tree, and forcing the fetch resets
the local branch to the pull request's head, orphaning any commit made on it.
Because the branch name defaults to `pr-<index>` it is reused, so a second
forced checkout of the same pull request is exactly where review fixes
committed on that branch go. Neither is undoable from the outcome. A checkout
that failed is telling you to commit, stash, or pick a different `input.branch`,
not to retry with `force`.

## Error codes and recovery

`next_steps` is present only where the CLI already knew the recovery when it
failed, so **read it first and fall back to the table below when it is empty.**
It arrives populated on a failed `run`, `job`, or `artifact` selection that had
candidates, on `approval.required`, on `host.required` and `repo.required`, and
on a partial `repo clone`, `repo fork`, or `repo create`. Everywhere else,
including every transport failure, it is `[]`: an empty list means the CLI does
not know the recovery, never that none exists. At most 16 steps arrive, in
order, so a selection with many candidates cannot make an outcome unbounded.

Branch on `action`. Only `invoke` is an argv, and its `argv[0]` names the
program, which is **not** always `forgejo`: a partial `repo clone` recovers
through `git`. The other three re-issue the leaf named by the outcome's own
`command`, so no step repeats it.

| `action`  | Carries          | Do this                                                                              |
| --------- | ---------------- | ------------------------------------------------------------------------------------ |
| `select`  | `field`, `value` | Re-send the same input with `value` in place of the selector you sent for `field`    |
| `provide` | `field`          | Re-send the same input with `field` added; only you hold its value                   |
| `approve` | `grant`          | Re-send the identical request with `--approve <grant>` on argv                       |
| `invoke`  | `argv`           | Execute `argv` yourself. Read `argv[0]`; it is the program, and may not be `forgejo` |

A `select` `value` is shaped for the field it names, so it substitutes and never
converts. `run` and `job` take the whole field. `run download`'s `artifact` is a
list, so its `value` is one element and replaces only the entry that failed:
keep the list, and do not assign the bare string to `artifact`.

Where no step is offered, the code itself is the recovery:

| Code                                                                                                        | Recovery                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `argv.invalid`                                                                                              | Fix argv, not the Request. The message names the offending token. Reachable from any token argv does not read: a stray flag or positional, a valueless `--approve`, a split `--input-output json`, or `--version` with extras      |
| `request.invalid`                                                                                           | Fix the envelope or `input`. `error.details.issues` carries the validation issues                                                                                                                                                  |
| `request.unsupported_version`                                                                               | Send `schema_version: 1`                                                                                                                                                                                                           |
| `command.not_found`                                                                                         | The leaf is not in the catalog. Stop; do not improvise                                                                                                                                                                             |
| `host.required`, `host.not_found`, `host.ambiguous`                                                         | Send an explicit `input.host` matching one configured profile                                                                                                                                                                      |
| `repo.required`, `repo.invalid`                                                                             | Send `input.repo` as `OWNER/NAME`                                                                                                                                                                                                  |
| `git.remote_required`                                                                                       | `pr checkout` only. Send `input.remote` naming a Git remote of the current working directory that points at `input.repo`, and run the command from that checkout                                                                   |
| `repository.not_found`, `issue.*_not_found`, `pull_request.not_found`, `run.not_found`, `actions.not_found` | The target does not exist on the Host. Re-read before mutating                                                                                                                                                                     |
| `workflow.not_found`                                                                                        | Local only, from `workflow view`: the file is absent from the working directory's `.forgejo/workflows/` and `.github/workflows/`. A workflow the Host does not have reports `actions.not_found`                                    |
| `auth.required`, `auth.rejected`, `auth.forbidden`                                                          | Log in again with `auth login`, or use a token carrying the needed scope                                                                                                                                                           |
| `pull_request.branch_delete_failed`                                                                         | The pull request is merged and its head branch is not deleted. Never re-merge; delete the branch yourself or leave it                                                                                                              |
| `host.contract_incompatible`, `host.version`                                                                | The Host does not satisfy the pinned Forgejo contract. Stop                                                                                                                                                                        |
| `capability.unsupported`                                                                                    | Do not retry the mutation. Upgrade the Host or use a supported command                                                                                                                                                             |
| `approval.required`                                                                                         | Review the planned effects, then re-send with the returned grant                                                                                                                                                                   |
| `command.cancelled`                                                                                         | Stop. Do not retry automatically                                                                                                                                                                                                   |
| `api.method_unsupported`                                                                                    | The contract declares no operation under that method. `api` serves `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`                                                                                                                     |
| `api.operation_not_advertised`, `api.unexpected_response`                                                   | The endpoint or status is absent from the advertised contract. Use a curated leaf                                                                                                                                                  |
| `api.output_required`                                                                                       | Set `input.output` so the binary response can be delivered to a file                                                                                                                                                               |
| `actions.too_many_artifacts`                                                                                | The run's artifact listing never reached its end. Page `/repos/{owner}/{repo}/actions/runs/{run_id}/artifacts` through `api`                                                                                                       |
| `result.too_large`                                                                                          | Narrow the request with `page`, `limit`, or `output`                                                                                                                                                                               |
| `<namespace>.response_too_large`                                                                            | The response is past the 16 MiB read limit, not a transport fault. Narrow it with `page` or `limit`, or fetch the content with a command that delivers to a file. An answer arrived, so read the ledger before retrying a mutation |
| `command.failed`                                                                                            | Unclassified. Report `diagnostics` and stop                                                                                                                                                                                        |

## Maintaining this skill

The routing, safety, and workflow sections are hand-written policy in
`skills/forgejo/SKILL.template.md`. The compatibility statement and the command
reference are generated from `package.json` and the Command catalog. Never edit
`SKILL.md` directly; `check:paired-skill` fails as soon as it drifts from the
template.

After an intentional catalog or version change, run
`bun run generate:paired-skill`, review the resulting reference, and require both
`bun run check:paired-skill` and `bun test test/request-fixtures.test.ts` in
validation. The fixture suite derives one schema-valid Request sample for every
exact leaf and exercises its success, invalid-input, typed-failure,
cancellation, and, for mutations, approval path. It includes partial-effect
outcomes only for leaves whose Mutation plan contains multiple Effects, so it
never invents partial work for a read-only or single-effect command.

## Generated command reference

`host` and `repo` are listed as optional input because the schema allows their
absence, but Request mode requires both. `remote` on `pr checkout` is listed the
same way and is required there for the same reason. Approval column: `yes` is
always approval-gated, `no` is read-only, and `conditional` is gated by input.

| Exact leaf       | Required Request input | Optional Request input                                                                                             | Approval-gated |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------- |
| `api`            | endpoint               | host, method, header, raw_field, field, input, page, limit, all, include, output                                   | conditional    |
| `auth login`     | url, token             | none                                                                                                               | yes            |
| `auth logout`    | host                   | none                                                                                                               | yes            |
| `auth status`    | host                   | none                                                                                                               | no             |
| `issue close`    | index                  | host, repo                                                                                                         | yes            |
| `issue comment`  | index, body            | host, repo                                                                                                         | yes            |
| `issue create`   | title                  | host, repo, body, assignee, label, milestone, due_date                                                             | yes            |
| `issue delete`   | index                  | host, repo                                                                                                         | yes            |
| `issue edit`     | index                  | host, repo, title, body, assignee, label, milestone, due_date                                                      | yes            |
| `issue list`     | none                   | host, repo, state, label, assignee, author, mention, milestone, search, type, sort, page, limit, all               | no             |
| `issue pin`      | index                  | host, repo                                                                                                         | yes            |
| `issue reopen`   | index                  | host, repo                                                                                                         | yes            |
| `issue status`   | none                   | host, repo                                                                                                         | no             |
| `issue unpin`    | index                  | host, repo                                                                                                         | yes            |
| `issue view`     | index                  | host, repo, comments                                                                                               | no             |
| `pr checkout`    | index                  | host, repo, branch, force, remote                                                                                  | yes            |
| `pr checks`      | index                  | host, repo, watch, interval, timeout                                                                               | no             |
| `pr comment`     | index, body            | host, repo                                                                                                         | yes            |
| `pr create`      | title, base            | host, repo, body, head, assignee, label, milestone, reviewer                                                       | yes            |
| `pr diff`        | index                  | host, repo, patch, binary, output                                                                                  | no             |
| `pr edit`        | index                  | host, repo, title, body, base, assignee, label, milestone                                                          | yes            |
| `pr list`        | none                   | host, repo, state, base, head, author, label, milestone, sort, page, limit, all                                    | no             |
| `pr merge`       | index                  | host, repo, merge, rebase, rebase_merge, squash, fast_forward_only, delete_branch, match_head, when_checks_succeed | yes            |
| `pr review`      | index                  | host, repo, approve, request_changes, comment, body                                                                | yes            |
| `pr view`        | index                  | host, repo, comments                                                                                               | no             |
| `repo archive`   | none                   | host, repo                                                                                                         | yes            |
| `repo clone`     | none                   | host, repo, directory, remote                                                                                      | yes            |
| `repo create`    | name                   | host, owner, description, private, init, default_branch, source, remote, push                                      | yes            |
| `repo delete`    | none                   | host, repo                                                                                                         | yes            |
| `repo edit`      | none                   | host, repo, description, website, default_branch, visibility                                                       | yes            |
| `repo fork`      | none                   | host, repo, owner, name, clone, remote                                                                             | yes            |
| `repo list`      | none                   | host, owner, page, limit, visibility, archived                                                                     | no             |
| `repo rename`    | name                   | host, repo                                                                                                         | yes            |
| `repo unarchive` | none                   | host, repo                                                                                                         | yes            |
| `repo view`      | none                   | host, repo                                                                                                         | no             |
| `run cancel`     | run                    | host, repo                                                                                                         | yes            |
| `run delete`     | run                    | host, repo                                                                                                         | yes            |
| `run download`   | run, artifact, dir     | host, repo                                                                                                         | yes            |
| `run list`       | none                   | host, repo, workflow, event, status, ref, commit, run_number, page, limit, all                                     | no             |
| `run rerun`      | run                    | host, repo, job                                                                                                    | yes            |
| `run view`       | run                    | host, repo, job, log, log_failed, output                                                                           | no             |
| `run watch`      | run                    | host, repo, interval, timeout, exit_status                                                                         | no             |
| `smoke echo`     | value                  | none                                                                                                               | yes            |
| `workflow list`  | none                   | none                                                                                                               | no             |
| `workflow run`   | workflow, ref          | host, repo, field, watch, interval, timeout                                                                        | yes            |
| `workflow view`  | workflow               | none                                                                                                               | no             |
