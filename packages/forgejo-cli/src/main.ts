import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { createFileOutputFileSystem, createOutputStore } from "../../forgejo/src/adapters";
import { run } from "./cli";
import { composeCapabilities } from "./composition";
import { createCommandCatalog } from "../../forgejo/src/catalog";
import { createClackHumanInterface } from "./human-interface";
import { createSecretsCredentialStore } from "./credential-store";

const capabilities = composeCapabilities({
  fetch,
  filesystem: {
    read: async (path) => new Uint8Array(await readFile(path)),
    write: writeFile,
    directoryStatus: async (path) => {
      try {
        const info = await stat(path);
        if (!info.isDirectory()) return "nonempty";
        return (await readdir(path)).length === 0 ? "empty" : "nonempty";
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return "missing";
        throw error;
      }
    },
    list: readdir,
  },
  process: {
    run: async (argv, options) => {
      const child = Bun.spawn(argv, {
        cwd: options.cwd,
        stdin: options.stdin ?? "ignore",
        env: { ...process.env, ...options.environment },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill(), options.timeout_ms);
      const exitCode = await child.exited;
      clearTimeout(timer);
      return {
        exit_code: exitCode,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      };
    },
  },
  credentials: createSecretsCredentialStore(),
  clock: { now: () => new Date() },
  terminal: { isTty: process.stdin.isTTY === true, confirm: async () => false },
  output: createOutputStore(
    createFileOutputFileSystem({
      makeDirectory: mkdir,
      writeFile,
      open,
      remove: rm,
      rename,
      makeTemporaryDirectory: mkdtemp,
      temporaryRoot: tmpdir,
      uniqueSuffix: randomUUID,
    }),
  ),
  cancelled: () => false,
  environment: process.env,
  home: homedir(),
  cwd: process.cwd(),
});
const argv = process.argv.slice(2);
const inputIndex = argv.indexOf("--input");
const stdin =
  argv.includes("--token-stdin") ||
  (inputIndex >= 0 && argv[inputIndex + 1] === "-") ||
  (argv.includes("--input-output") && !argv.includes("--version"))
    ? await Bun.stdin.text()
    : "";
const exitCode = await run(
  argv,
  stdin,
  (text) => process.stdout.write(text),
  (text) => process.stderr.write(text),
  {
    capabilities,
    human: createClackHumanInterface({
      input: process.stdin,
      output: process.stdout,
      errorOutput: process.stderr,
      isInteractive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    }),
    catalog: createCommandCatalog(),
  },
);

process.exitCode = exitCode;
