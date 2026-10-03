import { z } from "zod";
import type { CommandDefinition } from "@wyattjoh/forgejo/internal/runtime";

/** A generated, stable summary of one Request-mode leaf command. */
export type PairedCommandReference = {
  name: string;
  required_input: string[];
  optional_input: string[];
  mutation: boolean;
  conditional_approval: boolean;
};

/** The generated compatibility bounds one Paired skill release is pinned to. */
export type PairedVersionSupport = { version: string; minimum: string; exclusive_maximum: string };

/**
 * Derives the caret-compatible CLI version range a generated Paired skill supports.
 *
 * @param version The installed CLI package version.
 * @returns The pinned version with its inclusive lower and exclusive upper bounds.
 */
export function supportedVersionRange(version: string): PairedVersionSupport {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`paired_skill.unsupported_version:${version}`);
  const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number];
  return {
    version,
    minimum: version,
    exclusive_maximum:
      major > 0 ? `${major + 1}.0.0` : minor > 0 ? `0.${minor + 1}.0` : `0.0.${patch + 1}`,
  };
}

/**
 * Renders the generated compatibility statement of the Paired skill.
 *
 * @param version The installed CLI package version.
 * @param requestSchemaVersion The stable Request mode wire version.
 * @returns Markdown content for the generated version marker.
 */
export function renderPairedVersionSupport(version: string, requestSchemaVersion: number): string {
  const range = supportedVersionRange(version);
  return [
    `Generated from \`forgejo\` v${range.version}.`,
    `This skill supports CLI versions \`>=${range.minimum} <${range.exclusive_maximum}\``,
    `and Request schema version \`${requestSchemaVersion}\`.`,
  ].join(" ");
}

/**
 * Renders the exact-version `bunx` invocation the Paired skill falls back to.
 *
 * @param version The installed CLI package version.
 * @returns Markdown content for the generated bunx marker.
 */
export function renderPairedBunxCommand(version: string): string {
  const { version: pinned } = supportedVersionRange(version);
  return [
    "```sh",
    `bunx -p @wyattjoh/forgejo-cli@${pinned} forgejo --version --agent`,
    `bunx --no-install -p @wyattjoh/forgejo-cli@${pinned} forgejo <family> <leaf> --agent ...`,
    "```",
  ].join("\n");
}

/** Returns the object shape beneath supported catalog validation wrappers. */
function unwrapObjectSchema(
  schema: z.ZodType<Record<string, unknown>>,
): z.AnyZodObject | undefined {
  if (schema instanceof z.ZodObject) return schema;
  if (schema instanceof z.ZodEffects) return unwrapObjectSchema(schema.innerType());
  return undefined;
}

/**
 * Derives Paired-skill command references from the typed command catalog.
 *
 * @param catalog The complete public command catalog.
 * @returns Command references sorted by exact leaf name.
 */
export function createPairedCommandReferences(
  catalog: CommandDefinition[],
): PairedCommandReference[] {
  return catalog
    .map((command) => {
      const input = unwrapObjectSchema(command.input);
      if (!input) throw new Error(`paired_skill.unsupported_schema:${command.name}`);
      const shape = input.shape as Record<string, z.ZodTypeAny>;
      const required_input: string[] = [];
      const optional_input: string[] = [];
      for (const [name, field] of Object.entries(shape)) {
        if (field.isOptional()) optional_input.push(name);
        else required_input.push(name);
      }
      return {
        name: command.name,
        required_input,
        optional_input,
        mutation: command.mutation,
        conditional_approval: !command.mutation && command.requiresApproval !== undefined,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Renders the generated command-reference section of the Paired skill.
 *
 * @param catalog The complete public command catalog.
 * @returns Markdown table content for the generated reference marker.
 */
export function renderPairedCommandReference(catalog: CommandDefinition[]): string {
  const header = [
    "Exact leaf",
    "Required Request input",
    "Optional Request input",
    "Approval-gated",
  ];
  const rows = createPairedCommandReferences(catalog).map((command) => [
    `\`${command.name}\``,
    command.required_input.join(", ") || "none",
    command.optional_input.join(", ") || "none",
    command.mutation ? "yes" : command.conditional_approval ? "conditional" : "no",
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const formatRow = (row: string[]): string =>
    `| ${row.map((cell, index) => cell.padEnd(widths[index]!)).join(" | ")} |`;
  return [
    formatRow(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...rows.map(formatRow),
  ].join("\n");
}
