import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = JSON.parse(await readFile(resolve(root, "swagger.v1.json"), "utf8")) as {
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        parameters?: Array<{ name: string; required?: boolean; in?: string }>;
      }
    >
  >;
};
const selected = new Set([
  "repoGet",
  "repoEdit",
  "repoDelete",
  "userCurrentListRepos",
  "userListRepos",
  "orgListRepos",
  "createCurrentUserRepo",
  "createOrgRepo",
  "createFork",
  "issueListIssues",
  "issueCreateIssue",
  "issueGetIssue",
  "issueEditIssue",
  "issueDelete",
  "issueGetComments",
  "issueCreateComment",
  "issueReplaceLabels",
  "issueGetMilestonesList",
  "pinIssue",
  "unpinIssue",
  "repoListPullRequests",
  "repoCreatePullRequest",
  "repoGetPullRequest",
  "repoEditPullRequest",
  "repoDownloadPullDiffOrPatch",
  "repoCreatePullReviewRequests",
  "repoCreatePullReview",
  "repoMergePullRequest",
  "repoGetCombinedStatusByRef",
  "ListActionRuns",
  "ActionRun",
  "DeleteActionRun",
  "CancelActionRun",
  "ListActionRunJobs",
  "ListActionRunArtifacts",
  "repoGetActionRunLogs",
  "DownloadActionArtifact",
  "DispatchWorkflow",
]);
const operations = Object.entries(source.paths).flatMap(([path, methods]) =>
  Object.entries(methods).flatMap(([method, operation]) =>
    operation.operationId && selected.has(operation.operationId)
      ? [
          {
            operation_id: operation.operationId,
            method: method.toUpperCase(),
            path,
            required_parameters: (operation.parameters ?? [])
              .filter((parameter) => parameter.required)
              .map((parameter) => ({ name: parameter.name, in: parameter.in })),
          },
        ]
      : [],
  ),
);
const manifest = JSON.stringify({ source: "swagger.v1.json", operations }, null, 2) + "\n";
const signatures = operations
  .map(
    (operation) =>
      `  {\n    operation_id: ${JSON.stringify(operation.operation_id)},\n    method: ${JSON.stringify(operation.method)},\n    path: ${JSON.stringify(operation.path)},\n  },`,
  )
  .join("\n");
const types = `/** Generated bootstrap operation identifiers from the pinned Forgejo Swagger contract. */\nexport type SelectedOperationId =\n${operations.map((operation) => `  | ${JSON.stringify(operation.operation_id)}`).join("\n")};\n\n/** Generated selected operation signatures used for Host compatibility checks. */\nexport const selectedOperations = [\n${signatures}\n] as const;\n`;
const generated = resolve(root, "packages/forgejo/src/generated");
await mkdir(generated, { recursive: true });
if (process.argv.includes("--check")) {
  const [existingManifest, existingTypes] = await Promise.all([
    readFile(resolve(generated, "operation-manifest.json"), "utf8"),
    readFile(resolve(generated, "operation-types.ts"), "utf8"),
  ]);
  if (existingManifest !== manifest || existingTypes !== types)
    throw new Error("Generated Swagger artifacts have drifted. Run bun run generate.");
} else
  await Promise.all([
    writeFile(resolve(generated, "operation-manifest.json"), manifest),
    writeFile(resolve(generated, "operation-types.ts"), types),
  ]);
