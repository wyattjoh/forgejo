#!/usr/bin/env bun
import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readConfig } from "./config";
import { OAuthStore } from "./store";
import { ForgejoOAuth } from "./oauth";
import { createApp } from "./app";

const config = readConfig();
const directory = dirname(config.databasePath);
await mkdir(directory, { recursive: true, mode: 0o700 });
const metadata = await lstat(directory);
if (metadata.isSymbolicLink() || !metadata.isDirectory())
  throw new Error("Unsafe OAuth data directory");
await chmod(directory, 0o700);
try {
  if ((await lstat(config.databasePath)).isSymbolicLink()) throw new Error("Unsafe OAuth database");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const store = new OAuthStore(config.databasePath, config.encryptionKey);
await chmod(config.databasePath, 0o600);
const handler = createApp(config, new ForgejoOAuth(config, store));
const server = Bun.serve({
  hostname: config.listenHost,
  port: config.port,
  idleTimeout: 255,
  fetch: (request, connection) =>
    handler(request, connection.requestIP(request)?.address ?? "unknown"),
  error: () => new Response("Internal server error", { status: 500 }),
});
const cleanup = setInterval(() => store.prune(), 60_000);
console.error(`Forgejo MCP listening on ${server.url}; public endpoint ${config.publicUrl}/mcp`);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(cleanup);
  await server.stop();
  store.close();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
