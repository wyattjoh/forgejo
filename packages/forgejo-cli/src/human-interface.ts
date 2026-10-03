import type { Readable, Writable } from "node:stream";
import { confirm, isCancel, log, note, outro, password, select } from "@clack/prompts";
import type { CommandError, CommandOutcome, Effect } from "../../forgejo/src/runtime";

/** Interactive prompts and readable outcome rendering for Human mode. */
export type HumanInterface = {
  isInteractive: boolean;
  password(message: string): Promise<string | undefined>;
  select(message: string, options: string[]): Promise<string | undefined>;
  confirm(message: string): Promise<boolean | undefined>;
  render(outcome: CommandOutcome): void;
};

/** Streams and terminal state used by the Clack Human-mode adapter. */
export type ClackHumanInterfaceOptions = {
  input: Readable;
  output: Writable;
  errorOutput: Writable;
  isInteractive: boolean;
};

/**
 * Creates the Clack-backed prompt and presentation layer for Human mode.
 *
 * @param options Process streams and terminal state.
 * @returns A Human-mode interface that masks secrets and renders typed outcomes.
 */
export function createClackHumanInterface(options: ClackHumanInterfaceOptions): HumanInterface {
  const promptOptions = { input: options.input, output: options.output };
  return {
    isInteractive: options.isInteractive,
    password: async (message) => {
      const value = await password({
        ...promptOptions,
        message,
        mask: "•",
        validate: (token) =>
          !token || token.trim().length === 0 ? "Token is required" : undefined,
      });
      return isCancel(value) ? undefined : value;
    },
    select: async (message, options) => {
      const value = await select({
        ...promptOptions,
        message,
        options: options.map((option) => ({ label: option, value: option })),
      });
      return isCancel(value) ? undefined : value;
    },
    confirm: async (message) => {
      const value = await confirm({ ...promptOptions, message, initialValue: false });
      return isCancel(value) ? undefined : value;
    },
    render: (outcome) => {
      if (outcome.status === "error") {
        log.error(errorLine(outcome.error), { output: options.errorOutput });
        renderEffects(outcome.effects, options.errorOutput);
        return;
      }

      if (Object.keys(outcome.result ?? {}).length > 0)
        note(JSON.stringify(outcome.result, null, 2), outcome.command, {
          output: options.output,
        });
      renderEffects(outcome.effects, options.output);
      outro(outcome.effects.some((effect) => effect.state === "planned") ? "Plan ready" : "Done", {
        output: options.output,
      });
    },
  };
}

/**
 * Renders a failure as its code and message, or as the code alone when the message only repeats
 * it. A failure raised as a bare code carries that code as its message, so printing both would say
 * the same thing twice. Only the Human rendering collapses; the typed outcome keeps both fields.
 */
function errorLine(error: CommandError | null | undefined): string {
  const code = error?.code ?? "command.failed";
  const message = error?.message ?? "Command failed";
  return message && message !== code ? `${code}: ${message}` : code;
}

function renderEffects(effects: Effect[], output: Writable): void {
  if (effects.length === 0) return;
  const lines = effects.map(
    (effect) => `${effect.state.padEnd(9)} ${effect.action} ${effect.target}`,
  );
  note(lines.join("\n"), "Effects", { output });
}
