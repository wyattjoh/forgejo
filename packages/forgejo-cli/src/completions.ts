import type { CommandDefinition } from "@wyattjoh/forgejo/internal/runtime";

/** Rendered, static completion scripts for the supported interactive shells. */
export type CompletionScripts = {
  bash: string;
  zsh: string;
  fish: string;
};

type CommandTree = Map<string, string[]>;

/**
 * Derives the public Human-mode command tree from the authoritative Command catalog.
 *
 * @param catalog Every public command definition.
 * @returns Top-level commands mapped to their available leaf commands.
 */
function commandTree(catalog: CommandDefinition[]): CommandTree {
  const tree = new Map<string, string[]>();
  for (const definition of catalog) {
    const [family, leaf] = definition.name.split(" ");
    if (!family) continue;
    const leaves = tree.get(family) ?? [];
    if (leaf) leaves.push(leaf);
    tree.set(family, leaves);
  }
  return new Map([...tree].sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * Renders deterministic static Bash, Zsh, and Fish completion scripts.
 *
 * The scripts deliberately complete the catalog's command tree and global safety flags.
 * Per-command argument validation remains owned by the CLI's strict Human-mode parser.
 *
 * @param catalog Every public command definition.
 * @returns Completion scripts keyed by shell name.
 */
export function renderCompletions(catalog: CommandDefinition[]): CompletionScripts {
  const tree = commandTree(catalog);
  return {
    bash: renderBash(tree),
    zsh: renderZsh(tree),
    fish: renderFish(tree),
  };
}

function renderBash(tree: CommandTree): string {
  const families = [...tree.keys()].join(" ");
  const cases = [...tree]
    .filter(([, leaves]) => leaves.length > 0)
    .map(([family, leaves]) => `    ${family}) words="${leaves.join(" ")} --agent" ;;`)
    .join("\n");
  return `# bash completion for forgejo. Generated from the Command catalog; do not edit.\n_forgejo() {\n  local cur family words\n  cur=\${COMP_WORDS[COMP_CWORD]}\n  family=\${COMP_WORDS[1]}\n  if [ "$COMP_CWORD" -eq 1 ]; then\n    words="${families} --version"\n  else\n    case "$family" in\n${cases}\n      *) words="--agent --dry-run --approve --input-output" ;;\n    esac\n  fi\n  COMPREPLY=( $(compgen -W "$words" -- "$cur") )\n}\ncomplete -F _forgejo forgejo\n`;
}

function renderZsh(tree: CommandTree): string {
  const families = [...tree.keys()].map((family) => `'${family}'`).join(" ");
  const cases = [...tree]
    .filter(([, leaves]) => leaves.length > 0)
    .map(
      ([family, leaves]) =>
        `    ${family}) _values 'leaf command' ${leaves.map((leaf) => `'${leaf}'`).join(" ")} '--agent[emit a typed outcome without prompting or inference]' ;;`,
    )
    .join("\n");
  return `#compdef forgejo\n# Zsh completion for forgejo. Generated from the Command catalog; do not edit.\n\n_forgejo() {\n  if (( CURRENT == 2 )); then\n    _values 'command family' ${families} '--version[print CLI version]'\n    return\n  fi\n\n  case "$words[2]" in\n${cases}\n    *) _arguments '--agent[emit a typed outcome without prompting or inference]' '--dry-run[plan without mutation]' '--approve[approve a mutation plan]:approval grant:' '--input-output[use strict Request mode]:format:(json)' ;;\n  esac\n}\n\n_forgejo "$@"\n`;
}

function renderFish(tree: CommandTree): string {
  const roots = [...tree.keys()].join(" ");
  const leaves = [...tree]
    .filter(([, commands]) => commands.length > 0)
    .map(
      ([family, commands]) =>
        `complete -c forgejo -n '__fish_seen_subcommand_from ${family}' -a '${commands.join(" ")}'`,
    )
    .join("\n");
  return `# Fish completion for forgejo. Generated from the Command catalog; do not edit.\ncomplete -c forgejo -f\ncomplete -c forgejo -n '__fish_use_subcommand' -a '${roots}'\ncomplete -c forgejo -l version -d 'Print CLI version'\ncomplete -c forgejo -l agent -d 'Emit a typed outcome without prompting or inference'\ncomplete -c forgejo -l dry-run -d 'Plan without mutation'\ncomplete -c forgejo -l approve -r -d 'Approve a mutation plan'\ncomplete -c forgejo -l input-output -r -a json -d 'Use strict Request mode'\n${leaves}\n`;
}
