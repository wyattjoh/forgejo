# @wyattjoh/forgejo

The shared library owns Forgejo operations, input validation, mutation planning, error codes,
and the ordered effect ledger. It does not read environment credentials or create CLI prompts.

```ts
import { connectForgejo } from "@wyattjoh/forgejo";

const forgejo = await connectForgejo({
  host: "https://git.example.com",
  token: credentialFromYourSecretStore,
});
const outcome = await forgejo.invoke("issue list", { repo: "owner/project", limit: 20 });
```

`connectForgejo` validates the user and the advertised contract once for that client. It accepts an
injected fetch implementation and optional AbortSignal. The host is supplied by default to every
command; repository-scoped commands require `repo`. This client has no local Git or output-file
adapters. Use the exported `execute`, `createCommandCatalog`, and `CapabilitySet` when composing
those capabilities yourself, as the CLI does.

`invoke` returns a `CommandOutcome`: `status`, typed `error`, `result`, `context`, ordered `effects`,
bounded `diagnostics`, and `next_steps`. A partial error can have a result and succeeded effects.
Never blindly repeat a mutation whose effects succeeded or are unknown.

Writes first return `approval.required`. After reviewing the planned effects, repeat the same
command and input with `{ approval: returnedGrant }`. `{ dryRun: true }` previews the plan.
This protocol records intentional execution; applications decide how human approval is collected.

The public entry point also exports typed repository, issue, pull-request, Actions, and raw
gateway factories for callers that need direct protocol operations. These lower-level gateways
do not apply the command runtime's approval protocol.
