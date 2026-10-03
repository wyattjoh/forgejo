import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FetchAdapter } from "../packages/forgejo/src/infrastructure";
import { createIssuesGateway } from "../packages/forgejo/src/issue-gateway";
import { createPullRequestsGateway } from "../packages/forgejo/src/pull-request-gateway";

const contract = JSON.parse(
  await readFile(resolve(import.meta.dir, "../swagger.v1.json"), "utf8"),
) as { paths: Record<string, Record<string, unknown>> };
const commentsPath = "/repos/{owner}/{repo}/issues/{index}/comments";
const combinedStatusPath = "/repos/{owner}/{repo}/commits/{ref}/status";
const host = "https://forgejo.example";
const token = "synthetic-token";
const owner = "octo";
const repo = "demo";
const index = 7;
const sha = "9f2c1ab";
type Observed = { method: string; path: string };

/** Rewrites one observed request URL back into its advertised Swagger path template. */
function template(url: string): string {
  return new URL(url).pathname
    .replace(/^\/api\/v1/, "")
    .split("/")
    .map((segment) =>
      segment === owner
        ? "{owner}"
        : segment === repo
          ? "{repo}"
          : segment === String(index)
            ? "{index}"
            : segment === sha
              ? "{ref}"
              : segment,
    )
    .join("/");
}

/** Records the paths a gateway requests without reaching a Forgejo host. */
function recorder(observed: Observed[]): FetchAdapter {
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    observed.push({ method, path: template(String(input)) });
    // The contract advertises 201 for the comment POST, so answer with it rather than a default
    // 200, which would leave a decoder that only accepted 200 passing here and failing on a host.
    return method === "GET"
      ? Response.json([])
      : Response.json({ id: 1, body: "hello" }, { status: 201 });
  };
}

/** Reports the observed requests the committed contract does not advertise. */
function unadvertised(observed: Observed[]): Observed[] {
  return observed.filter((entry) => !contract.paths[entry.path]?.[entry.method.toLowerCase()]);
}

test("pull-request comment operations use the advertised issue comments path", async () => {
  const observed: Observed[] = [];
  const gateway = createPullRequestsGateway(recorder(observed));
  await gateway.comments(host, token, owner, repo, index);
  await gateway.comment(host, token, owner, repo, index, "hello");
  expect(observed).toEqual([
    { method: "GET", path: commentsPath },
    { method: "POST", path: commentsPath },
  ]);
  expect(unadvertised(observed)).toEqual([]);
});

test("issue comment operations reach the same advertised path as their pull-request peers", async () => {
  const observed: Observed[] = [];
  const gateway = createIssuesGateway(recorder(observed));
  await gateway.comments(host, token, owner, repo, index);
  await gateway.comment(host, token, owner, repo, index, "hello");
  expect(observed).toEqual([
    { method: "GET", path: commentsPath },
    { method: "POST", path: commentsPath },
  ]);
  expect(unadvertised(observed)).toEqual([]);
});

test("pull-request checks read the advertised combined status path", async () => {
  const observed: Observed[] = [];
  const gateway = createPullRequestsGateway(recorder(observed));
  await gateway.statuses(host, token, owner, repo, sha);
  expect(observed).toEqual([{ method: "GET", path: combinedStatusPath }]);
  expect(unadvertised(observed)).toEqual([]);
});

test("the contract advertises the combined status path as the deduped one", () => {
  // Both paths exist. The statuses path returns every row ever written for the sha, so reading
  // it makes a check that was ever pending look pending forever. Only the combined path dedupes
  // by context, which is why the gateway must keep using it.
  expect(contract.paths["/repos/{owner}/{repo}/statuses/{sha}"]?.get).toBeDefined();
  expect((contract.paths[combinedStatusPath]?.get as { operationId?: string })?.operationId).toBe(
    "repoGetCombinedStatusByRef",
  );
});

test("the contract anchors every advertised path under a literal segment", () => {
  // Forgejo serves its web UI from the same origin as the API, so /{owner}/{repo}/settings/hooks
  // is a private page rather than a capability. What keeps those pages unreachable is the raw
  // gateway anchoring every request under /api/v1, where the web UI is not served. This is the
  // second line: the matcher lets a parameter match any single segment, so a template opening
  // with one would make every path beneath an owner look advertised. The contract is host
  // supplied, so this asserts the shape of the vendored copy, guarding its regeneration.
  const opening = Object.keys(contract.paths).filter((template) => template.startsWith("/{"));
  expect(opening).toEqual([]);
});

test("the contract declares no operation a HEAD or OPTIONS call could ever reach", () => {
  // `api` refuses both methods at its schema rather than resolving an operation for them, and this
  // is what makes that refusal a description of the contract instead of a policy of its own. A
  // regenerated contract that started declaring either one fails here, where the refusal is.
  const declared = new Set(Object.values(contract.paths).flatMap((item) => Object.keys(item)));
  expect([...declared].filter((method) => ["head", "options"].includes(method))).toEqual([]);
  // Guards against a scan that reads an empty set and passes vacuously.
  for (const method of ["get", "post", "put", "patch", "delete"])
    expect(declared).toContain(method);
});

test("the contract keeps conversation comments off the pulls resource", () => {
  // A pull request is an issue, so its conversation comments live on the issues resource. The
  // pulls resource advertises review comments only, which are a separate feature.
  expect(contract.paths["/repos/{owner}/{repo}/pulls/{index}/comments"]).toBeUndefined();
  expect(contract.paths["/repos/{owner}/{repo}/pulls/{index}/reviews/{id}/comments"]).toBeDefined();
});
