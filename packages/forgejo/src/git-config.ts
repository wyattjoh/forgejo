import type { ProcessRunner } from "./adapters";

/**
 * A best-effort adapter for path-scoped user Git credential configuration.
 */
export type GitCredentialConfigurator = {
  configure(url: string): Promise<void>;
};

/**
 * Creates the idempotent global Git configuration adapter for one Deployment URL.
 *
 * @param process Injectable process executor.
 * @returns A configurator that never receives API tokens.
 */
export function createGitCredentialConfigurator(process: ProcessRunner): GitCredentialConfigurator {
  return {
    configure: async (url) => {
      await runGit(process, ["config", "--global", `credential.${url}.helper`, "osxkeychain"]);
      await runGit(process, ["config", "--global", `credential.${url}.useHttpPath`, "true"]);
    },
  };
}
async function runGit(process: ProcessRunner, args: string[]): Promise<void> {
  const result = await process.run(["git", ...args], {
    cwd: "/",
    timeout_ms: 10_000,
    stdin: undefined,
    environment: undefined,
  });
  if (result.exit_code !== 0) throw new Error("git.config_failed");
}
