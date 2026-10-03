import { createCommandCatalog } from "./catalog";
import { createActionsGateway } from "./actions-gateway";
import { createRepositoryGateway } from "./repository-gateway";
import { createIssuesGateway } from "./issue-gateway";
import { createPullRequestsGateway } from "./pull-request-gateway";
import { createRawApiGateway } from "./raw-api-gateway";
import { createHttpHostInspector } from "./host-inspector";
import {
  normalizeDeploymentUrl,
  selectHost,
  type HostAccess,
  type HostProfile,
} from "./host-session";
import { selectedOperations } from "./generated/operation-types";
import { validateAdvertisedContract, type FetchAdapter } from "./infrastructure";
import { execute, type CapabilitySet, type CommandOutcome } from "./runtime";

export type ForgejoClientOptions = {
  host: string;
  token: string;
  fetch?: FetchAdapter;
  signal?: AbortSignal;
};
export type InvokeOptions = { approval?: string | undefined; dryRun?: boolean; requestId?: string };

/** Connect with explicit credentials, without local configuration, prompts, or a secret store. */
export async function connectForgejo(options: ForgejoClientOptions) {
  const host = normalizeDeploymentUrl(options.host);
  const fetchAdapter: FetchAdapter = (url, init) =>
    (options.fetch ?? fetch)(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([
        options.signal ?? init?.signal ?? AbortSignal.timeout(30_000),
        AbortSignal.timeout(30_000),
      ]),
    });
  const inspection = await createHttpHostInspector(fetchAdapter).inspect(host, options.token);
  const now = () => new Date();
  const contract = validateAdvertisedContract(inspection.swagger, [...selectedOperations], now());
  if (!contract.compatible) throw new Error("host.contract_incompatible");
  const profile: HostProfile = {
    url: host,
    identity: inspection.identity,
    server_version: inspection.version,
    swagger_sha256: contract.fingerprint,
  };
  const session: HostAccess = {
    profiles: async () => [profile],
    authenticated: async (selector) => ({
      profile: selectHost([profile], selector),
      token: options.token,
    }),
    advertisedSwagger: async (selector) => {
      selectHost([profile], selector);
      return inspection.swagger;
    },
    status: async (selector) => ({
      ...selectHost([profile], selector),
      credential_present: true,
      cache_compatible: true,
      cache_missing_operations: [],
      cache_fresh: true,
    }),
    login: async () => {
      throw new Error("auth.managed_externally");
    },
    logout: async () => {
      throw new Error("auth.managed_externally");
    },
  };
  const capabilities: CapabilitySet = {
    host: session,
    repositories: createRepositoryGateway(fetchAdapter),
    issues: createIssuesGateway(fetchAdapter),
    pullRequests: createPullRequestsGateway(fetchAdapter),
    actions: createActionsGateway(fetchAdapter),
    rawApi: createRawApiGateway(fetchAdapter),
    git: undefined,
    gateway: { smoke: async ({ value }) => ({ echoed: value }) },
    environment: {},
    cwd: "",
    clock: { now },
    cancelled: () => options.signal?.aborted ?? false,
    sleep: (milliseconds) =>
      new Promise<void>((resolve, reject) => {
        const signal = options.signal;
        if (signal?.aborted) {
          reject(new Error("command.cancelled"));
          return;
        }
        const abort = () => {
          clearTimeout(timer);
          reject(new Error("command.cancelled"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, milliseconds);
        signal?.addEventListener("abort", abort, { once: true });
      }),
  };
  const catalog = createCommandCatalog();
  return {
    profile,
    /** Execute catalogued operations with the shared validation, approval, and effect ledger. */
    invoke(
      command: string,
      input: Record<string, unknown>,
      invokeOptions: InvokeOptions = {},
    ): Promise<CommandOutcome> {
      return execute(
        {
          command,
          input: { host, ...input },
          mode: "request",
          requestId: invokeOptions.requestId ?? null,
          approval: invokeOptions.approval,
          dryRun: invokeOptions.dryRun ?? false,
        },
        catalog,
        capabilities,
      );
    },
  };
}
export type ForgejoClient = Awaited<ReturnType<typeof connectForgejo>>;
