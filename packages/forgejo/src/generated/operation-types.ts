/** Generated bootstrap operation identifiers from the pinned Forgejo Swagger contract. */
export type SelectedOperationId =
  | "orgListRepos"
  | "createOrgRepo"
  | "repoGet"
  | "repoDelete"
  | "repoEdit"
  | "DownloadActionArtifact"
  | "ListActionRuns"
  | "ActionRun"
  | "DeleteActionRun"
  | "ListActionRunArtifacts"
  | "CancelActionRun"
  | "ListActionRunJobs"
  | "repoGetActionRunLogs"
  | "DispatchWorkflow"
  | "repoGetCombinedStatusByRef"
  | "createFork"
  | "issueListIssues"
  | "issueCreateIssue"
  | "issueGetIssue"
  | "issueDelete"
  | "issueEditIssue"
  | "issueGetComments"
  | "issueCreateComment"
  | "issueReplaceLabels"
  | "pinIssue"
  | "unpinIssue"
  | "issueGetMilestonesList"
  | "repoListPullRequests"
  | "repoCreatePullRequest"
  | "repoGetPullRequest"
  | "repoEditPullRequest"
  | "repoDownloadPullDiffOrPatch"
  | "repoMergePullRequest"
  | "repoCreatePullReviewRequests"
  | "repoCreatePullReview"
  | "userCurrentListRepos"
  | "createCurrentUserRepo"
  | "userListRepos";

/** Generated selected operation signatures used for Host compatibility checks. */
export const selectedOperations = [
  {
    operation_id: "orgListRepos",
    method: "GET",
    path: "/orgs/{org}/repos",
  },
  {
    operation_id: "createOrgRepo",
    method: "POST",
    path: "/orgs/{org}/repos",
  },
  {
    operation_id: "repoGet",
    method: "GET",
    path: "/repos/{owner}/{repo}",
  },
  {
    operation_id: "repoDelete",
    method: "DELETE",
    path: "/repos/{owner}/{repo}",
  },
  {
    operation_id: "repoEdit",
    method: "PATCH",
    path: "/repos/{owner}/{repo}",
  },
  {
    operation_id: "DownloadActionArtifact",
    method: "GET",
    path: "/repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip",
  },
  {
    operation_id: "ListActionRuns",
    method: "GET",
    path: "/repos/{owner}/{repo}/actions/runs",
  },
  {
    operation_id: "ActionRun",
    method: "GET",
    path: "/repos/{owner}/{repo}/actions/runs/{run_id}",
  },
  {
    operation_id: "DeleteActionRun",
    method: "DELETE",
    path: "/repos/{owner}/{repo}/actions/runs/{run_id}",
  },
  {
    operation_id: "ListActionRunArtifacts",
    method: "GET",
    path: "/repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
  },
  {
    operation_id: "CancelActionRun",
    method: "POST",
    path: "/repos/{owner}/{repo}/actions/runs/{run_id}/cancel",
  },
  {
    operation_id: "ListActionRunJobs",
    method: "GET",
    path: "/repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
  },
  {
    operation_id: "repoGetActionRunLogs",
    method: "GET",
    path: "/repos/{owner}/{repo}/actions/runs/{run_id}/logs",
  },
  {
    operation_id: "DispatchWorkflow",
    method: "POST",
    path: "/repos/{owner}/{repo}/actions/workflows/{workflowfilename}/dispatches",
  },
  {
    operation_id: "repoGetCombinedStatusByRef",
    method: "GET",
    path: "/repos/{owner}/{repo}/commits/{ref}/status",
  },
  {
    operation_id: "createFork",
    method: "POST",
    path: "/repos/{owner}/{repo}/forks",
  },
  {
    operation_id: "issueListIssues",
    method: "GET",
    path: "/repos/{owner}/{repo}/issues",
  },
  {
    operation_id: "issueCreateIssue",
    method: "POST",
    path: "/repos/{owner}/{repo}/issues",
  },
  {
    operation_id: "issueGetIssue",
    method: "GET",
    path: "/repos/{owner}/{repo}/issues/{index}",
  },
  {
    operation_id: "issueDelete",
    method: "DELETE",
    path: "/repos/{owner}/{repo}/issues/{index}",
  },
  {
    operation_id: "issueEditIssue",
    method: "PATCH",
    path: "/repos/{owner}/{repo}/issues/{index}",
  },
  {
    operation_id: "issueGetComments",
    method: "GET",
    path: "/repos/{owner}/{repo}/issues/{index}/comments",
  },
  {
    operation_id: "issueCreateComment",
    method: "POST",
    path: "/repos/{owner}/{repo}/issues/{index}/comments",
  },
  {
    operation_id: "issueReplaceLabels",
    method: "PUT",
    path: "/repos/{owner}/{repo}/issues/{index}/labels",
  },
  {
    operation_id: "pinIssue",
    method: "POST",
    path: "/repos/{owner}/{repo}/issues/{index}/pin",
  },
  {
    operation_id: "unpinIssue",
    method: "DELETE",
    path: "/repos/{owner}/{repo}/issues/{index}/pin",
  },
  {
    operation_id: "issueGetMilestonesList",
    method: "GET",
    path: "/repos/{owner}/{repo}/milestones",
  },
  {
    operation_id: "repoListPullRequests",
    method: "GET",
    path: "/repos/{owner}/{repo}/pulls",
  },
  {
    operation_id: "repoCreatePullRequest",
    method: "POST",
    path: "/repos/{owner}/{repo}/pulls",
  },
  {
    operation_id: "repoGetPullRequest",
    method: "GET",
    path: "/repos/{owner}/{repo}/pulls/{index}",
  },
  {
    operation_id: "repoEditPullRequest",
    method: "PATCH",
    path: "/repos/{owner}/{repo}/pulls/{index}",
  },
  {
    operation_id: "repoDownloadPullDiffOrPatch",
    method: "GET",
    path: "/repos/{owner}/{repo}/pulls/{index}.{diffType}",
  },
  {
    operation_id: "repoMergePullRequest",
    method: "POST",
    path: "/repos/{owner}/{repo}/pulls/{index}/merge",
  },
  {
    operation_id: "repoCreatePullReviewRequests",
    method: "POST",
    path: "/repos/{owner}/{repo}/pulls/{index}/requested_reviewers",
  },
  {
    operation_id: "repoCreatePullReview",
    method: "POST",
    path: "/repos/{owner}/{repo}/pulls/{index}/reviews",
  },
  {
    operation_id: "userCurrentListRepos",
    method: "GET",
    path: "/user/repos",
  },
  {
    operation_id: "createCurrentUserRepo",
    method: "POST",
    path: "/user/repos",
  },
  {
    operation_id: "userListRepos",
    method: "GET",
    path: "/users/{username}/repos",
  },
] as const;
