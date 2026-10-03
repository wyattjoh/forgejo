import { normalizeDeploymentUrl } from "@wyattjoh/forgejo";
import { resolve } from "node:path";

export type McpConfig = {
  forgejoHost: string;
  publicUrl: string;
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  databasePath: string;
  listenHost: string;
  port: number;
  allowedOrigins: string[];
  allowedUsers: string[];
  readOnly: boolean;
};

export function readConfig(
  environment: Record<string, string | undefined> = process.env,
): McpConfig {
  const required = (key: string) => {
    const value = environment[key];
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const publicUrl = normalizeDeploymentUrl(required("MCP_PUBLIC_URL"));
  if (new URL(publicUrl).pathname !== "/")
    throw new Error("MCP_PUBLIC_URL must have no path prefix");
  const port = Number(environment.MCP_PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MCP_PORT");
  const allowedOrigins = [
    ...new Set([
      new URL(publicUrl).origin,
      ...(environment.MCP_ALLOWED_ORIGINS ?? "")
        .split(",")
        .filter(Boolean)
        .map((value) => new URL(value.trim()).origin),
    ]),
  ];
  return {
    forgejoHost: normalizeDeploymentUrl(required("FORGEJO_HOST")),
    publicUrl,
    clientId: required("FORGEJO_OAUTH_CLIENT_ID"),
    clientSecret: required("FORGEJO_OAUTH_CLIENT_SECRET"),
    encryptionKey: required("MCP_ENCRYPTION_KEY"),
    databasePath: resolve(environment.MCP_DATABASE_PATH ?? "data/oauth.sqlite"),
    listenHost: environment.MCP_LISTEN_HOST ?? "127.0.0.1",
    port,
    allowedOrigins,
    allowedUsers: (environment.MCP_ALLOWED_USERS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    readOnly: environment.MCP_READ_ONLY !== "false",
  };
}
