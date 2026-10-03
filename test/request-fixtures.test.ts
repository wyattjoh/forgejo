import { expect, test } from "bun:test";
import { z } from "zod";
import { createCommandCatalog } from "../packages/forgejo/src/catalog";
import {
  execute,
  type CapabilitySet,
  type CommandDefinition,
} from "../packages/forgejo/src/runtime";

type FixtureKind = "success" | "invalid_input" | "typed_failure" | "approval" | "cancellation";
type RequestFixture = {
  command: string;
  input: Record<string, unknown>;
  kinds: FixtureKind[];
  partial_effect: boolean;
};

const catalog = createCommandCatalog();
const capabilities: CapabilitySet = {
  gateway: { smoke: async ({ value }) => ({ echoed: value }) },
  host: undefined,
  repositories: undefined,
  git: undefined,
  issues: undefined,
  pullRequests: undefined,
  actions: undefined,
  rawApi: undefined,
  workflows: undefined,
  environment: {},
  cwd: "/tmp",
  clock: { now: () => new Date("2025-01-01T00:00:00.000Z") },
  cancelled: () => false,
};

/** Creates one schema-valid Request input without invoking a Forgejo capability. */
function fixtureInput(schema: z.ZodType<Record<string, unknown>>): Record<string, unknown> {
  const value = fixtureValue(schema);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("fixture.input_not_object");
  return value as Record<string, unknown>;
}

/**
 * Produces the smallest representative value accepted by a Zod schema.
 */
function fixtureValue(schema: z.core.$ZodType): unknown {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) return undefined;
  if (schema instanceof z.ZodNullable) return fixtureValue(schema.unwrap());
  if (schema instanceof z.ZodString) return "fixture";
  if (schema instanceof z.ZodNumber) return 1;
  if (schema instanceof z.ZodBoolean) return false;
  if (schema instanceof z.ZodLiteral) return schema.value;
  if (schema instanceof z.ZodEnum) return schema.options[0];
  if (schema instanceof z.ZodArray) return [fixtureValue(schema.element)];
  if (schema instanceof z.ZodTuple) return schema.def.items.map(fixtureValue);
  if (schema instanceof z.ZodUnion) return fixtureValue(schema.options[0]!);
  if (schema instanceof z.ZodRecord) return {};
  if (schema instanceof z.ZodObject)
    return Object.fromEntries(
      Object.entries(schema.shape).flatMap(([key, value]) => {
        const fixture = fixtureValue(value as z.core.$ZodType);
        return fixture === undefined ? [] : [[key, fixture]];
      }),
    );
  throw new Error(`fixture.unsupported_schema:${schema._zod.def.type}`);
}

/** Derives the compatibility-fixture inventory from the authoritative Command catalog. */
function createRequestFixtures(entries: CommandDefinition[]): RequestFixture[] {
  return entries.map((definition) => {
    const input = {
      ...fixtureInput(definition.input),
      ...(definition.name === "issue edit" ? { title: "fixture" } : {}),
      ...(definition.name === "pr review" ? { approve: true } : {}),
      ...(definition.name === "pr merge" ? { merge: true } : {}),
      ...(definition.name === "api" ? { endpoint: "/user" } : {}),
    };
    const plan = definition.plan(input);
    return {
      command: definition.name,
      input,
      kinds: [
        "success",
        "invalid_input",
        "typed_failure",
        ...(definition.mutation ? (["approval"] as const) : []),
        "cancellation",
      ],
      partial_effect: plan.effects.length > 1,
    };
  });
}

const fixtures = createRequestFixtures(catalog);

/** Replaces a leaf handler while retaining its Request schema and plan metadata. */
function fixtureDefinition(
  definition: CommandDefinition,
  handler: CommandDefinition["handler"],
): CommandDefinition {
  const {
    requiresApproval: _approval,
    preflightBeforeApproval: _before,
    preflight: _preflight,
    ...rest
  } = definition;
  return { ...rest, mutation: false, handler };
}

test("Request fixtures cover every catalog leaf and preserve schema-valid sample input", () => {
  expect(fixtures.map((fixture) => fixture.command)).toEqual(
    catalog.map((definition) => definition.name),
  );
  for (const fixture of fixtures) {
    const definition = catalog.find((entry) => entry.name === fixture.command)!;
    const parsed = definition.input.safeParse(fixture.input);
    if (!parsed.success)
      throw new Error(`fixture.input_invalid:${fixture.command}:${parsed.error.message}`);
    expect(fixture.kinds).toEqual(
      expect.arrayContaining(["success", "invalid_input", "typed_failure", "cancellation"]),
    );
    expect(fixture.kinds.includes("approval")).toBe(definition.mutation);
    expect(fixture.partial_effect).toBe(definition.plan(fixture.input).effects.length > 1);
  }
});

test("every Request fixture has deterministic invalid-input and cancellation outcomes", async () => {
  for (const fixture of fixtures) {
    const invalid = await execute(
      {
        command: fixture.command,
        input: { fixture_invalid: true },
        requestId: `${fixture.command}-invalid`,
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      catalog,
      capabilities,
    );
    expect(invalid.error?.code).toBe("request.invalid");

    const cancelled = await execute(
      {
        command: fixture.command,
        input: fixture.input,
        requestId: `${fixture.command}-cancelled`,
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      catalog,
      { ...capabilities, cancelled: () => true },
    );
    expect(cancelled.error?.code).toBe("command.cancelled");
  }
});

test("every Request fixture produces typed success and failure outcomes at the catalog seam", async () => {
  for (const fixture of fixtures) {
    const definition = catalog.find((entry) => entry.name === fixture.command)!;
    const success = await execute(
      {
        command: fixture.command,
        input: fixture.input,
        requestId: `${fixture.command}-success`,
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      [fixtureDefinition(definition, async () => ({ result: { fixture: "success" } }))],
      capabilities,
    );
    expect(success.status).toBe("success");
    expect(success.result).toEqual({ fixture: "success" });

    const failure = await execute(
      {
        command: fixture.command,
        input: fixture.input,
        requestId: `${fixture.command}-failure`,
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      [
        fixtureDefinition(definition, async () => {
          throw new Error("fixture.typed_failure");
        }),
      ],
      capabilities,
    );
    expect(failure.error?.code).toBe("fixture.typed_failure");
  }
});

test("partial-effect fixtures retain ordered effects and an explicit typed error", async () => {
  for (const fixture of fixtures.filter((entry) => entry.partial_effect)) {
    const definition = catalog.find((entry) => entry.name === fixture.command)!;
    const plan = definition.plan(fixture.input);
    const outcome = await execute(
      {
        command: fixture.command,
        input: fixture.input,
        requestId: `${fixture.command}-partial`,
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      [
        fixtureDefinition(definition, async () => ({
          result: { fixture: "partial" },
          effects: plan.effects.map((effect, index) => ({
            ...effect,
            state: index === 0 ? "succeeded" : "failed",
          })),
          partial_error: {
            code: "fixture.partial_effect",
            message: "Fixture stopped after a completed effect",
            details: {},
          },
        })),
      ],
      capabilities,
    );
    expect(outcome.error?.code).toBe("fixture.partial_effect");
    expect(outcome.effects[0]?.state).toBe("succeeded");
    expect(outcome.effects[1]?.state).toBe("failed");
  }
});

test("every mutation fixture requires a plan-bound approval before effects can run", async () => {
  for (const fixture of fixtures.filter((entry) => entry.kinds.includes("approval"))) {
    const definition = catalog.find((entry) => entry.name === fixture.command)!;
    if (definition.preflightBeforeApproval) continue;
    const outcome = await execute(
      {
        command: fixture.command,
        input: fixture.input,
        requestId: `${fixture.command}-approval`,
        approval: undefined,
        dryRun: false,
        mode: "request",
      },
      catalog,
      capabilities,
    );
    expect(outcome.error?.code).toBe("approval.required");
    expect(outcome.effects).toEqual(definition.plan(fixture.input).effects);
  }
});
