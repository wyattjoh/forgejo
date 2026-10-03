import { expect, test } from "bun:test";
import { humanSurface, run, type OptionDefinition } from "../packages/forgejo-cli/src/cli";
import { createCommandCatalog } from "../packages/forgejo/src/catalog";

const catalog = createCommandCatalog();

/**
 * Fields that carry no flag of their own.
 *
 * `approve` is already a flag every leaf gets, and `pr review` reads its bare form as the verdict.
 * The rest arrive only as positional arguments, which `humanSurface` reports separately.
 */
const flagless = new Set(["approve", "directory", "endpoint", "index", "run"]);

/** Reports whether any derived flag populates the given input field. */
function coversField(options: readonly OptionDefinition[], field: string): boolean {
  const kebab = field.replaceAll("_", "-");
  return options.some(([flags]) => {
    const flag = flags.split(/[ ,]/)[0]!.replace(/^--/, "");
    // `--token-stdin` populates `token` and `--body-file` populates `body`, so a flag whose name
    // extends the field name still counts as covering it.
    return flag === kebab || flag.startsWith(`${kebab}-`);
  });
}

/** Reads the field names a positional list binds, required or optional. */
function boundFields(positional: string): Set<string> {
  return new Set(Array.from(positional.matchAll(/[<[]([^>\]]+)[>\]]/g), (match) => match[1]!));
}

test("every command states a description that is not its name", () => {
  for (const definition of catalog) {
    expect(definition.description.length).toBeGreaterThan(0);
    expect(definition.description).not.toBe(definition.name);
  }
});

test("every input field is reachable from argv", () => {
  const unreachable = catalog.flatMap((definition) => {
    const surface = humanSurface(definition);
    const bound = boundFields(surface.positional);
    return surface.fields
      .filter((field) => !bound.has(field) && !flagless.has(field))
      .filter((field) => !coversField(surface.options, field))
      .map((field) => `${definition.name}.${field}`);
  });
  expect(unreachable).toEqual([]);
});

test("a leaf advertises only the flags its own schema accepts", () => {
  const flagsOf = (name: string) =>
    humanSurface(catalog.find((item) => item.name === name)!).options.map(
      ([text]) => text.split(" ")[0]!,
    );

  // Each of these belonged to a sibling leaf and was advertised repo-wide before the flag list
  // was derived from the schema. The schema rejects them, so help must not offer them.
  expect(flagsOf("repo view")).not.toContain("--push");
  expect(flagsOf("repo view")).not.toContain("--clone");
  expect(flagsOf("repo view")).toContain("--host");
  expect(flagsOf("repo view")).toContain("--repo");
  expect(flagsOf("repo create")).not.toContain("--public");
  expect(flagsOf("repo create")).toContain("--private");
});

test("help and version report success and write nothing to standard error", async () => {
  for (const argv of [["--help"], ["--version"], ["repo", "--help"], ["repo", "view", "--help"]]) {
    let out = "";
    let error = "";
    const code = await run(
      argv,
      "",
      (text) => {
        out += text;
      },
      (text) => {
        error += text;
      },
      { capabilities: undefined as never, catalog, human: undefined },
    );
    expect(code).toBe(0);
    expect(error).toBe("");
    expect(out.length).toBeGreaterThan(0);
  }
});
