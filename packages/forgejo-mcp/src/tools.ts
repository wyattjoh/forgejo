import { createHmac, timingSafeEqual } from "node:crypto";
import {
  connectForgejo,
  createCommandCatalog,
  type ForgejoClient,
  type CommandDefinition,
} from "@wyattjoh/forgejo";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AuthenticatedUser } from "./oauth";
import type { McpConfig } from "./config";
import packageJson from "../package.json";

const omitted = new Set([
  "auth login",
  "auth logout",
  "auth status",
  "smoke echo",
  "repo clone",
  "pr checkout",
  "pr diff",
  "run download",
  "workflow list",
  "workflow view",
  "api",
]);
const localFields = new Set([
  "host",
  "source",
  "remote",
  "push",
  "clone",
  "directory",
  "dir",
  "output",
  "log",
  "log_failed",
]);
function objectSchema(schema: z.ZodType<Record<string, unknown>>): z.ZodObject {
  if (schema instanceof z.ZodObject) return schema;
  throw new Error("Unsupported catalog input schema");
}
export function mcpCatalog(config: McpConfig, scopes: string[]): CommandDefinition[] {
  return createCommandCatalog().filter(
    (definition) =>
      !omitted.has(definition.name) &&
      (!definition.mutation || (!config.readOnly && scopes.includes("forgejo:write"))),
  );
}
/** Sign existing runtime grants with the user's OAuth grant so approval cannot cross identities. */
function approvalMac(raw: string, user: AuthenticatedUser, key: string): string {
  return createHmac("sha256", Buffer.from(key, "base64"))
    .update(`${user.grantId}:${user.clientId}:${raw}`)
    .digest("base64url");
}
function unwrapApproval(
  approval: string | undefined,
  user: AuthenticatedUser,
  key: string,
): string | undefined {
  if (!approval) return undefined;
  const [raw, signature, extra] = approval.split(".");
  if (!raw || !signature || extra !== undefined) return undefined;
  const expected = Buffer.from(approvalMac(raw, user, key)),
    supplied = Buffer.from(signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied)
    ? raw
    : undefined;
}

/** A fresh server per HTTP request; tool schemas derive from the shared command catalog. */
export function createMcpServer(
  config: McpConfig,
  user: AuthenticatedUser,
  signal: AbortSignal,
  connect: typeof connectForgejo = connectForgejo,
): Server {
  const server = new Server(
    { name: "forgejo", version: packageJson.version },
    { capabilities: { tools: {} } },
  );
  let client: Promise<ForgejoClient> | undefined;
  const tools = mcpCatalog(config, user.scopes).map((definition) => {
    const shape = Object.fromEntries(
      Object.entries(objectSchema(definition.input).shape).filter(
        ([name]) => !localFields.has(name),
      ),
    ) as z.ZodRawShape;
    const schema = z
      .object({
        ...shape,
        _approval: z
          .string()
          .optional()
          .describe("Approval grant returned for these exact command inputs"),
        _dry_run: z.boolean().optional().describe("Preview a mutation without executing it"),
      })
      .strict();
    return {
      definition,
      schema,
      tool: {
        name: definition.name.replaceAll(" ", "_"),
        description: `${definition.description}. Operates on ${config.forgejoHost} as the signed-in Forgejo user.${definition.mutation ? " First call returns planned effects and an approval grant; repeat identical inputs with _approval to execute." : ""}`,
        inputSchema: z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as {
          type: "object";
          properties: Record<string, unknown>;
        },
        annotations: {
          readOnlyHint: !definition.mutation,
          destructiveHint: definition.mutation,
          openWorldHint: true,
        },
      },
    };
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ tool }) => tool),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const entry = tools.find(({ tool }) => tool.name === request.params.name);
    if (!entry)
      return { content: [{ type: "text", text: "Unknown or unauthorized tool" }], isError: true };
    const parsed = entry.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success)
      return { content: [{ type: "text", text: "Invalid tool arguments" }], isError: true };
    const args = parsed.data;
    const definition = entry.definition;
    const { _approval, _dry_run, ...input } = args;
    client ??= connect({ host: config.forgejoHost, token: user.forgejoToken, signal });
    try {
      const connected = await client;
      if (connected.profile.identity?.id !== user.identity.id)
        throw new Error("OAuth identity changed");
      const outcome = await connected.invoke(definition.name, input, {
        approval: unwrapApproval(_approval, user, config.encryptionKey),
        dryRun: _dry_run ?? false,
      });
      for (const step of outcome.next_steps) {
        if (step.action === "approve") {
          step.grant = `${step.grant}.${approvalMac(step.grant, user, config.encryptionKey)}`;
          if (outcome.error?.code === "approval.required")
            outcome.error.details.approve = { _approval: step.grant };
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify(outcome) }],
        structuredContent: outcome,
        isError: outcome.status === "error",
      };
    } catch {
      return {
        content: [
          {
            type: "text",
            text: "Forgejo request failed; reconnect if your authorization has expired.",
          },
        ],
        isError: true,
      };
    }
  });
  return server;
}
