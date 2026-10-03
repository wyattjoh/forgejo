import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";
import { createCommandCatalog } from "../packages/forgejo/src/catalog";
import { renderCompletions } from "../packages/forgejo-cli/src/completions";

const catalog = createCommandCatalog();
const generated = renderCompletions(catalog);
const snapshots = {
  bash: new URL("../completions/forgejo.bash", import.meta.url),
  zsh: new URL("../completions/_forgejo", import.meta.url),
  fish: new URL("../completions/forgejo.fish", import.meta.url),
};

/** Runs a shell syntax check when the shell is installed in the current environment. */
async function checkSyntax(shell: string, arguments_: string[]): Promise<void> {
  const available = Bun.spawn(["sh", "-c", `command -v ${shell}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await available.exited) !== 0) return;
  const check = Bun.spawn([shell, ...arguments_], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await check.exited;
  if (exitCode === 0) return;
  throw new Error(await new Response(check.stderr).text());
}

test("generated completion snapshots match the Command catalog", async () => {
  expect(await readFile(snapshots.bash, "utf8")).toBe(generated.bash);
  expect(await readFile(snapshots.zsh, "utf8")).toBe(generated.zsh);
  expect(await readFile(snapshots.fish, "utf8")).toBe(generated.fish);

  for (const definition of catalog) {
    const [family, leaf] = definition.name.split(" ");
    if (!family) continue;
    expect(generated.bash).toContain(family);
    expect(generated.zsh).toContain(family);
    expect(generated.fish).toContain(family);
    if (!leaf) continue;
    expect(generated.bash).toContain(leaf);
    expect(generated.zsh).toContain(leaf);
    expect(generated.fish).toContain(leaf);
  }
});

test("generated completion scripts pass installed shell syntax checks", async () => {
  await checkSyntax("bash", ["-n", snapshots.bash.pathname]);
  await checkSyntax("zsh", ["-n", snapshots.zsh.pathname]);
  await checkSyntax("fish", ["--no-execute", snapshots.fish.pathname]);
});
