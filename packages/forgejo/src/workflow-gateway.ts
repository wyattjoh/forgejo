import type { FileSystem } from "./adapters";

/**
 * A local committed workflow file.
 */
export type WorkflowFile = { name: string; path: string; content: string };
/**
 * Local filesystem boundary used for workflow inspection.
 */
export type WorkflowGateway = {
  list(cwd: string): Promise<WorkflowFile[]>;
  get(cwd: string, name: string): Promise<WorkflowFile>;
};

/**
 * Creates the local workflow inspection gateway.
 *
 * @param filesystem Injected local filesystem seam.
 * @returns Workflow files from the supported Forgejo and GitHub directories.
 */
export function createWorkflowGateway(filesystem: FileSystem): WorkflowGateway {
  return {
    list: async (cwd) => {
      if (!filesystem.list) throw new Error("workflow.list_unavailable");
      const directories = [".forgejo/workflows", ".github/workflows"];
      const names = (
        await Promise.all(
          directories.map(async (directory) => {
            try {
              return (await filesystem.list!(join(cwd, directory)))
                .filter(workflowName)
                .map((name) => join(directory, name));
            } catch {
              return [];
            }
          }),
        )
      ).flat();
      return Promise.all(
        names.map(async (path) => ({
          name: path.split("/").at(-1)!,
          path,
          content: decode(await filesystem.read(join(cwd, path))),
        })),
      );
    },
    get: async (cwd, name) => {
      if (!workflowName(name) || name.includes("/")) throw new Error("workflow.invalid");
      const files = await createWorkflowGateway(filesystem).list(cwd);
      const found = files.find((item) => item.name === name);
      if (!found) throw new Error("workflow.not_found");
      return found;
    },
  };
}
function workflowName(value: string): boolean {
  return /\.(?:ya?ml)$/i.test(value) && !value.includes("/") && !value.includes("\\");
}
function join(left: string, right: string): string {
  return `${left.replace(/\/$/, "")}/${right}`;
}
function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}
