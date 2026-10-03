import type {
  Clock,
  FileSystem,
  OutputStore,
  ProcessRunner,
  Terminal,
} from "../../forgejo/src/adapters";
import { createGitCredentialConfigurator } from "../../forgejo/src/git-config";
import {
  createHostContractCacheStore,
  forgejoCacheRoot,
} from "../../forgejo/src/host-contract-cache";
import { createHostConfigStore, forgejoConfigRoot } from "./host-config-store";
import { createHttpHostInspector } from "../../forgejo/src/host-inspector";
import { HostSession, type HostCredentialStore } from "../../forgejo/src/host-session";
import type { FetchAdapter } from "../../forgejo/src/infrastructure";
import type { CapabilitySet } from "../../forgejo/src/runtime";
import { createRepositoryGateway } from "../../forgejo/src/repository-gateway";
import { createGitOperations } from "../../forgejo/src/git-operations";
import { createIssuesGateway } from "../../forgejo/src/issue-gateway";
import { createPullRequestsGateway } from "../../forgejo/src/pull-request-gateway";
import { createActionsGateway } from "../../forgejo/src/actions-gateway";
import { createRawApiGateway } from "../../forgejo/src/raw-api-gateway";
import { createWorkflowGateway } from "../../forgejo/src/workflow-gateway";
import { selectedOperations } from "../../forgejo/src/generated/operation-types";

/** Concrete adapters needed to compose command-specific capabilities. */
export type RuntimeAdapters = {
  fetch: FetchAdapter;
  filesystem: FileSystem;
  process: ProcessRunner;
  credentials: HostCredentialStore;
  clock: Clock;
  terminal: Terminal;
  output: OutputStore;
  cancelled: () => boolean;
  environment: Record<string, string | undefined>;
  home: string;
  cwd: string;
};

/**
 * Creates a narrow capability set rather than exposing a universal service locator.
 *
 * @param adapters Concrete infrastructure dependencies.
 * @returns The runtime capabilities for supported command families.
 */
export function composeCapabilities(adapters: RuntimeAdapters): CapabilitySet {
  const configRoot = forgejoConfigRoot(adapters.environment, adapters.home);
  const cacheRoot = forgejoCacheRoot(adapters.environment, adapters.home);
  return {
    clock: adapters.clock,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    cancelled: adapters.cancelled,
    host: new HostSession(
      createHostConfigStore(configRoot),
      adapters.credentials,
      createHttpHostInspector(adapters.fetch),
      [...selectedOperations],
      () => adapters.clock.now(),
      createHostContractCacheStore(cacheRoot),
      // The configurator names Git's `osxkeychain` helper, which only exists on macOS. Elsewhere
      // login leaves Git's credential configuration alone and reports it as not configured.
      process.platform === "darwin" ? createGitCredentialConfigurator(adapters.process) : undefined,
    ),
    gateway: { smoke: async ({ value }) => ({ echoed: value }) },
    repositories: createRepositoryGateway(adapters.fetch),
    issues: createIssuesGateway(adapters.fetch),
    pullRequests: createPullRequestsGateway(adapters.fetch),
    actions: createActionsGateway(adapters.fetch),
    rawApi: createRawApiGateway(adapters.fetch),
    workflows: createWorkflowGateway(adapters.filesystem),
    git: createGitOperations(adapters.process, adapters.filesystem, adapters.cancelled),
    output: adapters.output,
    environment: adapters.environment,
    cwd: adapters.cwd,
  };
}
