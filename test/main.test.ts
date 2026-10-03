import { expect, test } from "bun:test";

const projectRoot = new URL("..", import.meta.url).pathname;
// A command that waits on unused stdin never exits, so the budget only has to outlast a cold `bun
// run` start on a slow CI runner.
const stdinWaitBudgetMs = 2_000;

test("Human mode does not wait for unused standard input", async () => {
  const child = Bun.spawn(
    [
      "bun",
      "run",
      "packages/forgejo-cli/src/main.ts",
      "smoke",
      "echo",
      "--value",
      "test",
      "--dry-run",
    ],
    { cwd: projectRoot, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await Promise.race([
    child.exited,
    Bun.sleep(stdinWaitBudgetMs).then(() => undefined),
  ]);
  if (exitCode === undefined) child.kill();
  expect(exitCode).toBe(0);
});

test("the documented source invocation emits one Agent outcome without waiting for stdin", async () => {
  const child = Bun.spawn(
    [
      "bun",
      "run",
      "packages/forgejo-cli/src/main.ts",
      "smoke",
      "echo",
      "--agent",
      "--value",
      "test",
      "--dry-run",
    ],
    { cwd: projectRoot, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await Promise.race([
    child.exited,
    Bun.sleep(stdinWaitBudgetMs).then(() => undefined),
  ]);
  if (exitCode === undefined) child.kill();
  expect(exitCode).toBe(0);
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(stderr).toBe("");
  expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
  expect(JSON.parse(stdout)).toMatchObject({
    command: "smoke echo",
    status: "success",
    request_id: null,
  });
});
