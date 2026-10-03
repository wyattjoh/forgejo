import { createApiActionsCatalog } from "./api-actions-catalog";
import { createIssueCatalog } from "./issue-catalog";
import { createPullRequestCatalog } from "./pull-request-catalog";
import { createRepositoryCatalog } from "./repository-catalog";
import { createAuthCatalog, createSmokeCatalog, type CommandDefinition } from "./runtime";

/**
 * Creates the complete public Command catalog used by every CLI adapter and generated artifact.
 *
 * @returns Every supported exact leaf command in deterministic family order.
 */
export function createCommandCatalog(): CommandDefinition[] {
  return [
    ...createSmokeCatalog(),
    ...createAuthCatalog(),
    ...createRepositoryCatalog(),
    ...createIssueCatalog(),
    ...createPullRequestCatalog(),
    ...createApiActionsCatalog(),
  ];
}
