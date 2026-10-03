# Forgejo v1 capability surface

## Executive summary

Forgejo 16.0.2 exposes a useful but materially smaller surface than the current `gh` vocabulary. The supplied contract contains **506 operations across 326 paths**, but v1 should expose a curated set of repository, issue, pull-request, and Actions operations rather than mirror the contract mechanically. The strongest direct coverage is repository and issue CRUD, pull-request CRUD/review/merge, Actions run inspection/cancellation/artifacts, and workflow dispatch. Authentication and checkout/clone behavior necessarily combine local configuration or Git with small API probes.

The principal gaps are GitHub-specific authentication refresh, issue conversation locking and transfer, explicit pull-request draft/readiness, workflow listing/state management, and run reruns. Generic `api` can provide an escape hatch for documented Forgejo REST endpoints, but not GitHub GraphQL compatibility.

This report uses the current official `gh` command families as vocabulary ([auth](https://cli.github.com/manual/gh_auth), [repo](https://cli.github.com/manual/gh_repo), [issue](https://cli.github.com/manual/gh_issue), [pr](https://cli.github.com/manual/gh_pr), [api](https://cli.github.com/manual/gh_api), [workflow](https://cli.github.com/manual/gh_workflow), [run](https://cli.github.com/manual/gh_run)) and the supplied Forgejo 16.0.2 Swagger as the authority for server behavior.

## Mapping notation

- **D - direct:** one Forgejo REST operation.
- **M - multi-step:** several REST calls and/or local configuration.
- **G - Git/local:** primarily local Git or credential/configuration behavior.
- **O - omit:** no honest Forgejo 16 contract equivalent, or too semantically different for the named command.

## Recommended finite matrix

This is a research recommendation for the command-matrix ticket, not a final scope decision.

### `auth`

| Leaf                | Mapping                                      | Recommended behavior                                                                                                                |
| ------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `login`             | **M** local credential storage + `GET /user` | Accept an explicit self-hosted URL and token; validate identity without pretending Forgejo supports GitHub OAuth refresh semantics. |
| `logout`            | **G**                                        | Remove only the selected host/account credential.                                                                                   |
| `status`            | **M** local profiles + optional `GET /user`  | Report configured host, account and validation result without exposing the token.                                                   |
| `setup-git`         | **G**                                        | Configure Git credential use for the selected Forgejo host.                                                                         |
| `token`             | **G**, exceptional                           | Return the selected stored token only through an explicit secret-bearing operation.                                                 |
| `refresh`, `switch` | **O** initially                              | `refresh` is GitHub OAuth-specific. Account switching could later be a local profile feature, but has no server operation.          |

The contract requires API tokens as `Authorization: token …`; it separately defines Basic authentication, `X-FORGEJO-OTP` for Basic+2FA, and admin-only `Sudo` header/query mechanisms ([Swagger lines 32656–32713](../../swagger.v1.json#L32656)). These are not interchangeable with GitHub’s OAuth scopes or `Bearer` assumptions.

### `repo`

| Leaf                   | Mapping            | Endpoint/local operation                                                                               |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| `create`               | **M**              | `POST /user/repos` or `POST /orgs/{org}/repos`; optional local `git init`, remote setup and safe push. |
| `clone`                | **G/M**            | `GET /repos/{owner}/{repo}` to choose SSH/HTTP URL, then `git clone`.                                  |
| `list`                 | **D**              | `GET /user/repos`, `/users/{username}/repos`, or `/orgs/{org}/repos`.                                  |
| `view`                 | **D**              | `GET /repos/{owner}/{repo}`.                                                                           |
| `edit`                 | **D**              | `PATCH /repos/{owner}/{repo}`.                                                                         |
| `rename`               | **D**              | Same patch with `name`; update a matching local remote only as a separate, reported effect.            |
| `archive`, `unarchive` | **D**              | Same patch with `archived:true/false`.                                                                 |
| `fork`                 | **M**              | `POST /repos/{owner}/{repo}/forks` (202); optionally clone or add remotes locally.                     |
| `delete`               | **D**, destructive | `DELETE /repos/{owner}/{repo}` (204).                                                                  |
| `set-default`          | **G**              | Store a repository target locally; no server mutation.                                                 |

Repository GET/PATCH/DELETE share the canonical owner/name path ([Swagger line 5489](../../swagger.v1.json#L5489)); user repository creation/listing begins at [line 21588](../../swagger.v1.json#L21588). `CreateRepoOption` includes name, visibility, initialization/template inputs, default branch, object format and trust model; `EditRepoOption` additionally exposes Forgejo-specific feature and merge-policy switches.

**Omit initially:** `sync` (GitHub fork-sync semantics do not equal Forgejo mirror sync), `gitignore`, `license`, preview `read-file`/`read-dir`, and nested `autolink`/`deploy-key`. The underlying APIs may remain reachable through `api`. Repository transfer and migration exist in Forgejo but are not current top-level `gh repo` leaves and should not be introduced merely because endpoints exist.

### `issue`

| Leaf              | Mapping            | Endpoint(s)                                                                          |
| ----------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `list`            | **D**              | `GET /repos/{owner}/{repo}/issues`.                                                  |
| `view`            | **D**              | `GET /repos/{owner}/{repo}/issues/{index}`; comments may be fetched separately.      |
| `create`          | **D**              | `POST /repos/{owner}/{repo}/issues`.                                                 |
| `edit`            | **D**              | `PATCH /repos/{owner}/{repo}/issues/{index}`.                                        |
| `close`, `reopen` | **D**              | Same patch with `state`.                                                             |
| `comment`         | **D**              | `POST …/issues/{index}/comments`.                                                    |
| `delete`          | **D**, destructive | `DELETE …/issues/{index}`.                                                           |
| `pin`, `unpin`    | **D**, mutation    | `POST`/`DELETE …/issues/{index}/pin`.                                                |
| `status`          | **M**              | One or more filtered issue-list requests for authored, assigned or mentioned issues. |

The list operation supports `state`, `labels`, free-text `q`, `type`, milestones, time bounds, author/assignee/mention filters, sort, `page`, and `limit` ([Swagger line 10310](../../swagger.v1.json#L10310)). Creation accepts title plus body, assignees, labels, milestone, due date, ref, and initial closed state.

**Omit:** `lock`/`unlock` (no conversation-lock endpoint in the contract), `develop` (no equivalent linked-branch workflow), and `transfer` (no issue-transfer operation). Do not silently approximate these with unrelated block/dependency or repository-transfer APIs.

### `pr`

| Leaf              | Mapping                               | Endpoint/local operation                                                                                                  |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `list`, `view`    | **D**                                 | `GET /repos/{owner}/{repo}/pulls[/{index}]`.                                                                              |
| `create`          | **M**                                 | Safe Git push followed by `POST …/pulls`; reject an existing same-base/head PR before pushing.                            |
| `edit`            | **D**                                 | `PATCH …/pulls/{index}`.                                                                                                  |
| `close`, `reopen` | **D**                                 | Same patch with `state`.                                                                                                  |
| `comment`         | **D**                                 | PR conversation uses `POST …/issues/{index}/comments`.                                                                    |
| `diff`            | **D**, streaming/binary-sensitive     | `GET …/pulls/{index}.{diffType}` with `diff` or `patch`; optional binary inclusion.                                       |
| `checkout`        | **M/G**                               | Fetch PR metadata, select the correct head repository/ref, then perform non-destructive local Git fetch/branch checkout.  |
| `checks`          | **M**                                 | Resolve head SHA, then combine commit status and matching Actions-run data; do not manufacture GitHub check-suite fields. |
| `review`          | **D**                                 | `POST …/pulls/{index}/reviews`.                                                                                           |
| `merge`           | **D**, destructive/approval-sensitive | `POST …/pulls/{index}/merge`.                                                                                             |
| `update-branch`   | **D**, mutation                       | `POST …/pulls/{index}/update`.                                                                                            |
| `status`          | **M**                                 | Filter PR list by current-user relevance.                                                                                 |

Pull-list filters include state, sort, milestone, labels, poster, base and head ([Swagger line 14572](../../swagger.v1.json#L14572)). Merge choices are Forgejo’s `merge`, `rebase`, `rebase-merge`, `squash`, `fast-forward-only`, and `manually-merged`, with optional expected head SHA, branch deletion, forced merge, or merge-when-checks-succeed.

**Omit:** `ready` because neither `CreatePullRequestOption` nor `EditPullRequestOption` has a draft field ([Swagger line 25053](../../swagger.v1.json#L25053)); `lock`/`unlock` because no endpoint exists; and `revert` because it is a local commit/push/new-PR workflow rather than a Forgejo PR operation. Pando confirms the practical Forgejo/Tea draft convention is a `WIP:` title rather than GitHub’s explicit draft field ([Pando PR skill, line 16](../../../pando/skills/pando/references/commands/pr.md#L16)); that convention should not be presented as identical server semantics.

Fork PR heads require `owner:branch`, while same-repository heads use the branch alone. Pando already treats push and provider publication as distinct effects and preserves partial failure ([Pando PR skill, line 14](../../../pando/skills/pando/references/commands/pr.md#L14)); this is the appropriate model for `pr create`.

### `api`

| Leaf  | Mapping            | Recommended behavior                                                                                                                                |
| ----- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api` | **D**, exceptional | Send a request beneath the selected host’s `/api/v1`, supporting method, headers, query fields, JSON body, raw input, pagination and binary output. |

Unlike `gh api`, this is **REST-only**: no Forgejo 16 GraphQL endpoint is established by the supplied contract. GitHub preview headers and GitHub placeholder assumptions must not be carried over blindly. Arbitrary write methods must be classified as mutations before Request-mode execution; unknown write endpoints should require explicit approval or be refused rather than bypassing typed command policy.

### `workflow`

| Leaf                | Mapping         | Endpoint/local operation                                                                                                                                |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`               | **D**, mutation | `POST /repos/{owner}/{repo}/actions/workflows/{workflowfilename}/dispatches` with required `ref`, optional input object and optional `return_run_info`. |
| `list`              | **G**, limited  | Enumerate committed workflow files from the repository checkout; describe this explicitly as file discovery, not server workflow state.                 |
| `view`              | **G**, limited  | Read a selected committed workflow file; no remote enablement/status metadata is available.                                                             |
| `enable`, `disable` | **O**           | No matching Forgejo 16 operation in the supplied contract.                                                                                              |

The sole workflow-specific repository route is dispatch by **workflow filename**, not GitHub workflow numeric ID ([Swagger line 7059](../../swagger.v1.json#L7059)); its request schema requires `ref` ([Swagger line 25771](../../swagger.v1.json#L25771)). Forgejo Actions is broadly GitHub-Actions-inspired but should be treated as its own implementation and compatibility surface ([Forgejo Actions overview](https://forgejo.org/docs/v16.0/user/actions/), [Actions reference](https://forgejo.org/docs/v16.0/user/actions/reference/)).

### `run`

| Leaf       | Mapping                  | Endpoint(s)                                                                                                                |
| ---------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `list`     | **D**                    | `GET …/actions/runs`; filters include event, status, run number, SHA, ref and workflow ID.                                 |
| `view`     | **D/M**                  | `GET …/actions/runs/{run_id}`; optionally jobs and logs.                                                                   |
| `cancel`   | **D**, mutation          | `POST …/actions/runs/{run_id}/cancel`.                                                                                     |
| `delete`   | **D**, destructive       | `DELETE …/actions/runs/{run_id}`; documented for completed runs.                                                           |
| `download` | **M**, binary/filesystem | List run artifacts, then download each selected artifact ZIP.                                                              |
| `watch`    | **M**, polling/streaming | Poll run and jobs with backoff until terminal state; emit bounded observations rather than an unbounded response document. |
| `rerun`    | **O**                    | No rerun operation appears in the Forgejo 16.0.2 contract.                                                                 |

Run endpoints begin at [Swagger lines 6154–7058](../../swagger.v1.json#L6154), with the individual run at [line 6258](../../swagger.v1.json#L6258). Run logs are ZIP-form plaintext; artifacts are separately listed and downloaded. `ActionRun` differs from GitHub’s run object, exposing Forgejo fields such as `workflow_id` as a string, `index_in_repo`, `prettyref`, `need_approval`, `approved_by`, and fork/ref-deletion indicators.

## Semantic constraints

### Repository targeting and self-hosting

1. Accept an explicit `[HOST/]OWNER/REPO` target, but resolve the host through configured Forgejo profiles rather than defaulting to `github.com`.
2. Preserve the configured installation URL, including scheme, port, TLS policy and any path prefix; derive the API root as that installation’s `/api/v1`.
3. Local repository inference must report the selected remote and ambiguity. It must not silently prefer an unrelated remote.
4. Repository identity in effects, approvals and errors should include both canonical host and owner/name. Local Git remote names are not server identities.

### Pull requests are not GitHub pull requests

Forgejo PRs share issue comments and indexes but have their own pull routes and merge choices. Draft readiness is not represented by the supplied request schemas. Checks should expose Forgejo status/run data rather than promise GitHub check-suite parity. Fork head qualification and partial push/publication failures must remain visible.

### Actions are contract-limited

Forgejo 16 provides dispatch and run/artifact APIs, but not the complete GitHub workflow-management vocabulary. Local workflow-file discovery cannot answer whether a workflow is remotely enabled, and `workflow run` takes a filename. A v1 client must not infer missing workflow IDs or synthesize rerun/enable/disable calls.

## Pagination and errors

- Collection pagination is consistently **1-based** `page` plus `limit`; Actions lists document a default maximum page size of 50. The client should expose explicit page/limit and an opt-in all-pages mode with a response-size bound.
- List response shapes are not uniform: issues and PRs are arrays, repositories add `X-Total-Count`, while Actions runs use a `ListActionRunResponse` wrapper ([Swagger line 27812](../../swagger.v1.json#L27812)). Pagination must be endpoint-aware rather than copied from `gh api --paginate`.
- Preserve HTTP status and decoded body. The base `APIError` only guarantees `message` and `url` ([Swagger line 22845](../../swagger.v1.json#L22845)); validation, forbidden, unauthorized, not-found and archived-repository responses have separate schemas.
- Endpoint-specific statuses matter: create commonly returns 201, fork/transfer 202, successful destructive operations 204, PR merge can return 405 or 409, archived repositories can return 423, and validation commonly returns 422.
- Treat 202 as accepted-not necessarily completed-and 204 as success with no result body. Do not fail JSON decoding on empty or binary success responses.
- PR-list documentation warns that an unretrievable selected PR may appear as `null`; consumers must tolerate nullable entries rather than assuming every array element is an object.

## Request-mode exceptional operations

Pando’s protocol is the appropriate baseline: one strict versioned request on stdin, one newline-terminated response, typed result/error, effects, bounded diagnostics and executable next steps; unknown fields, trailing data and mixed argv/request input are rejected ([Pando skill, lines 57–71](../../../pando/skills/pando/SKILL.md#L57)). It is deterministic and noninteractive, never supplies human approval, and represents dry-run mutations as unattempted effects ([ADR 0002, line 7](../../../pando/docs/adr/0002-render-typed-command-outcomes.md#L7)).

| Class                       | Operations                                                                                                                          | Required handling                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Destructive                 | `repo delete`, `issue delete`, `run delete`, possibly artifact deletion through `api`                                               | Dry-run/plan where meaningful; explicit approval-bearing next step; stable effect identity.                                                                    |
| Approval-sensitive mutation | PR merge/force merge/manual merge, branch deletion, archive changes, fork/create push, update branch, run cancel, workflow dispatch | Report exact host/repo/resource and intended method; no implicit confirmation in Request mode.                                                                 |
| Local Git mutation          | create initialization/push, clone, checkout, remote rewrite                                                                         | Separate Git effects from API effects; preserve partial completion and recovery.                                                                               |
| Secret-bearing              | `auth login`, `auth token`, arbitrary Authorization headers                                                                         | Never echo credentials in diagnostics/effects; token output must be explicitly requested and non-cacheable.                                                    |
| Streaming/polling           | `run watch`                                                                                                                         | Observations may stream outside the final typed outcome, but must not authorize mutation or replace the final result.                                          |
| Binary/filesystem           | repo archives, PR binary diffs, logs ZIP, artifact ZIP, `api` binary responses                                                      | Require explicit destination or byte-safe result metadata; avoid embedding unbounded/base64 payloads in the JSON envelope; report checksums and written paths. |
| Arbitrary REST              | mutating `api` methods                                                                                                              | Classify method/path before execution; support dry-run only when honest; require approval for destructive or unknown writes.                                   |

## Facts downstream tickets must honor

- **Command matrix:** absence from the Forgejo 16 contract is not permission to emulate GitHub semantics. Keep the recommended leaf set finite and leave all 506 operations reachable, if at all, through a guarded REST escape hatch.
- **Repository targeting:** host is part of identity; self-hosted URL, owner/name, selected credential and local remote resolution must remain explicit.
- **Protocol:** typed outcomes own effects, errors and recovery. Empty, asynchronous, binary, polling and partially completed operations need distinct result shapes.
- **Capability/version detection:** workflow and run support must be derived from the target Forgejo version or endpoint behavior. Do not assume a newer server’s Actions surface when claiming Forgejo 16 compatibility.
- **Safety:** Request mode cannot itself grant approval. Force, secret disclosure, destructive deletion and arbitrary REST writes require explicit policy and human recovery paths.

## Sources

- Supplied Forgejo 16.0.2 OpenAPI/Swagger: [`swagger.v1.json`](../../swagger.v1.json)
- Official GitHub CLI manuals: [auth](https://cli.github.com/manual/gh_auth), [repo](https://cli.github.com/manual/gh_repo), [issue](https://cli.github.com/manual/gh_issue), [pr](https://cli.github.com/manual/gh_pr), [api](https://cli.github.com/manual/gh_api), [workflow](https://cli.github.com/manual/gh_workflow), [run](https://cli.github.com/manual/gh_run)
- Forgejo 16 documentation: [Actions overview](https://forgejo.org/docs/v16.0/user/actions/), [Actions reference](https://forgejo.org/docs/v16.0/user/actions/reference/)
- Pando Request mode: [`docs/adr/0002-render-typed-command-outcomes.md`](../../../pando/docs/adr/0002-render-typed-command-outcomes.md)
- Pando agent skill: [`skills/pando/SKILL.md`](../../../pando/skills/pando/SKILL.md)
- Pando PR behavior: [`skills/pando/references/commands/pr.md`](../../../pando/skills/pando/references/commands/pr.md)
