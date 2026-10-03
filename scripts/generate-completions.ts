import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCommandCatalog } from "../packages/forgejo/src/catalog";
import { renderCompletions } from "../packages/forgejo-cli/src/completions";

const check = process.argv.includes("--check");
const outputIndex = process.argv.indexOf("--output");
const outputDirectory =
  outputIndex >= 0 ? process.argv[outputIndex + 1] : resolve(import.meta.dir, "../completions");

if (
  !outputDirectory ||
  (process.argv.some((argument) => argument === "--output") &&
    outputIndex + 1 >= process.argv.length)
)
  throw new Error("completions.output_directory_required");

const completions = renderCompletions(createCommandCatalog());
const files = [
  ["forgejo.bash", completions.bash],
  ["_forgejo", completions.zsh],
  ["forgejo.fish", completions.fish],
] as const;

if (check) {
  for (const [name, content] of files) {
    const existing = await readFile(join(outputDirectory, name), "utf8").catch(() => undefined);
    if (existing !== content) throw new Error(`completions.generated_artifact_out_of_date:${name}`);
  }
} else {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    files.map(([name, content]) => writeFile(join(outputDirectory, name), content, "utf8")),
  );
}

console.log(`Generated ${files.length} completion scripts in ${outputDirectory}.`);
