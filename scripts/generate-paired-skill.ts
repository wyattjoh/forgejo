import { readFile, writeFile } from "node:fs/promises";
import { createCommandCatalog } from "../packages/forgejo/src/catalog";
import {
  createPairedCommandReferences,
  renderPairedBunxCommand,
  renderPairedCommandReference,
  renderPairedVersionSupport,
} from "../packages/forgejo-cli/src/paired-skill";
import { schemaVersion } from "../packages/forgejo/src/runtime";
import { cliVersion } from "../packages/forgejo-cli/src/version";

const templatePath = new URL("../skills/forgejo/SKILL.template.md", import.meta.url);
const outputPath = new URL("../skills/forgejo/SKILL.md", import.meta.url);
const referenceMarker = "<!-- GENERATED_COMMAND_REFERENCE -->";
const versionMarker = "<!-- GENERATED_VERSION_SUPPORT -->";
const bunxMarker = "<!-- GENERATED_BUNX_COMMAND -->";
const catalog = createCommandCatalog();

const template = await readFile(templatePath, "utf8");
for (const marker of [referenceMarker, versionMarker, bunxMarker])
  if (!template.includes(marker)) throw new Error(`paired_skill.template_marker_missing:${marker}`);
const output = template
  .replace(versionMarker, renderPairedVersionSupport(cliVersion, schemaVersion))
  .replace(bunxMarker, renderPairedBunxCommand(cliVersion))
  .replace(referenceMarker, renderPairedCommandReference(catalog));
const existing = await readFile(outputPath, "utf8").catch(() => undefined);
if (process.argv.includes("--check")) {
  if (existing !== output) throw new Error("paired_skill.generated_artifact_out_of_date");
} else if (existing !== output) {
  await writeFile(outputPath, output, "utf8");
}

console.log(
  `Paired skill pins forgejo v${cliVersion} with ${createPairedCommandReferences(catalog).length} command references.`,
);
