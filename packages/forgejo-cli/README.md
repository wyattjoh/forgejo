# Forgejo CLI

The `forgejo` command offers Human, Agent, and Request interfaces. It composes local configuration, OS credentials, Git processes and output files around the shared
library's catalog and executor.

From the workspace root:

```sh
bun run cli --version --agent
bun run cli auth login --url https://git.example.com
bun run cli issue list --agent --host https://git.example.com --repo owner/project
bun run cli pr checks --host https://git.example.com --repo owner/project 42
```

Tokens live in the OS Keychain or Secret Service and Host profiles under XDG configuration paths.
Human mode supports prompts and inferred local context; Agent and Request modes require explicit
targeting and return typed JSON outcomes. Mutations use a plan-bound approval protocol.

See the generated [paired skill](../../skills/forgejo/SKILL.md) for the full command catalog and
Request protocol. Build a standalone executable with `bun run build:release` at the workspace root.
The CLI currently supports Apple Silicon macOS and x86-64 Linux.
