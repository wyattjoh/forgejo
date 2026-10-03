# Minimal Bun CLI Architecture Research

**Status:** Research only; no architecture is locked.  
**Superseded for credentials and distribution:** the CLI now stores tokens with `Bun.secrets` (Keychain on macOS, libsecret on Linux) and ships ad-hoc signed `darwin_arm64` and `linux_amd64` archives cross-compiled on Linux. See [the release guide](../releasing.md).  
**Scope:** Installable macOS CLI using Bun and TypeScript, with Forgejo’s bundled Swagger 2.0 contract as an implementation aid.

## Executive summary

### Documented facts

- Bun provides the necessary low-level primitives: raw arguments, Web-standard `fetch`, `Bun.spawn`, file APIs plus Node-compatible `fs`, TTY streams, a Jest-like test runner, and standalone executable compilation.
- `bun build --compile` embeds the Bun runtime. macOS Intel and Apple Silicon require separate compilation targets; cross-compilation is supported. Native add-ons and runtime-discovered resources make standalone builds less predictable.
- macOS ships `/usr/bin/security`, which can create, find, update, and delete generic-password Keychain items without an npm dependency. Its interface and access-control behavior differ from calling Security.framework directly.
- The repository contract is Swagger 2.0, not OpenAPI 3. It contains **326 paths, 506 operations, and 246 definitions**, including JSON, text, archive, octet-stream, and multipart operations. Generating the entire client would substantially exceed the likely v1 surface.
- OpenAPI Generator supports Swagger 2.0 and can generate a dependency-light Fetch client. `openapi-typescript` targets OpenAPI 3.x, so this contract requires conversion first.
- Bun generates completions for the `bun` executable itself, but does not provide a documented general-purpose completion generator for arbitrary CLIs.
- Outside the Mac App Store, normal distribution uses Developer ID signing and Apple notarization. Notarization does not replace signing, and any post-signing modification invalidates the signature.

### Recommended default

Use a small command tree over dependency-free adapters:

1. `node:util.parseArgs` or a very small local parser;
2. native `fetch`, `Bun.spawn`, `node:fs`, and `bun:test`;
3. a handwritten HTTP transport with handwritten wrappers for the finite v1 command matrix;
4. generated **types only**, or selective generated code, only if contract drift becomes costly;
5. `/usr/bin/security` behind a Keychain interface for v1, with real signed-binary acceptance tests;
6. static/generated-in-repository Bash, Zsh, and Fish completion scripts;
7. separate signed/notarized `darwin-arm64` and `darwin-x64` release archives.

This minimizes production dependencies while preserving seams for replacing argument parsing, Keychain access, or API generation later.

---

## 1. Bun runtime primitives

### Facts

| Need                  | Bun facility and constraints                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arguments             | `Bun.argv` exposes the raw argument vector. Bun also implements Node’s `node:util`, including `parseArgs`, which parses options but does not supply a command framework. [Bun globals](https://bun.sh/docs/runtime/globals) · [Node `util.parseArgs`](https://nodejs.org/api/util.html#utilparseargsconfig)                                                                                                   |
| stdin and TTY         | `Bun.stdin` is a `BunFile`; it can be read as text or as a stream. Node-compatible `process.stdin`, `stdout`, and `stderr` expose `isTTY`, and `node:readline` is available for line-oriented interaction. Consuming all of `Bun.stdin` is unsuitable for an incremental prompt loop. [Bun file I/O](https://bun.sh/docs/runtime/file-io) · [Bun Node compatibility](https://bun.sh/docs/runtime/nodejs-apis) |
| Subprocesses          | `Bun.spawn` and `Bun.spawnSync` accept an argument array, environment, working directory, and configurable stdin/stdout/stderr. The subprocess object exposes exit completion and supports termination. [Bun child processes](https://bun.sh/docs/runtime/child-process)                                                                                                                                      |
| HTTP                  | Bun implements Web-standard `fetch`, `Request`, `Response`, `Headers`, streams, `FormData`, and `Blob`. `Bun.serve` can host local integration-test endpoints. [Bun Fetch](https://bun.sh/docs/api/fetch) · [Bun HTTP server](https://bun.sh/docs/api/http)                                                                                                                                                   |
| Filesystem            | `Bun.file` and `Bun.write` cover common whole-file operations; Node-compatible `node:fs`/`node:fs/promises` remains necessary for directory creation, permissions, rename-based atomic replacement, and detailed error handling. [Bun file I/O](https://bun.sh/docs/runtime/file-io)                                                                                                                          |
| Shell                 | Bun Shell (`$`) is a cross-platform shell-like API with escaping. For Git and Keychain operations, direct `Bun.spawn([executable, ...args])` has a smaller injection surface and preserves exact argument boundaries. [Bun Shell](https://bun.sh/docs/runtime/shell)                                                                                                                                          |
| Testing               | `bun:test` provides `test`, lifecycle hooks, Jest-style expectations, mocks/spies, module mocking, snapshots, timeouts, and coverage support. [Bun test runner](https://bun.sh/docs/test) · [Mocks](https://bun.sh/docs/test/mocks) · [Coverage](https://bun.sh/docs/test/code-coverage)                                                                                                                      |
| Compilation           | `bun build entry.ts --compile --outfile …` bundles application code with the Bun runtime. It supports explicit targets such as `bun-darwin-arm64` and `bun-darwin-x64`, including cross-compilation. [Bun standalone executables](https://bun.sh/docs/bundler/executables)                                                                                                                                    |
| Bun’s own completions | `bun completions` emits shell completion definitions for Bun. This is not documented as an application completion API. [Bun installation/completions](https://bun.sh/docs/installation#completions)                                                                                                                                                                                                           |

### Recommendations

- Keep command definitions in data: command name, aliases, arguments, options, help, and completion candidates. Dispatch should be separate from parsing.
- Begin with `node:util.parseArgs` per leaf command. Add Commander only if nested help, option relationships, or diagnostics become costly to maintain.
- Use `Bun.spawn` with argument arrays, not shell strings, for Git and Keychain.
- Use native Web types throughout the HTTP layer. Avoid Axios or another HTTP client.
- Reserve Bun-specific APIs for adapters. Domain and command handlers should accept ordinary TypeScript interfaces so they remain easy to test.
- Read piped request input as a whole only in non-interactive/request mode. Model interactive input separately.

---

## 2. Standalone executable constraints

### Facts

- A compiled executable contains a Bun runtime, so it is materially larger than a JavaScript bundle and does not require Bun on the destination machine. Exact size varies by Bun version, target, source maps, and minification. [Standalone executables](https://bun.sh/docs/bundler/executables)
- macOS targets are architecture-specific: `bun-darwin-arm64` and `bun-darwin-x64`. Bun documents cross-compilation through `--target`; it does not document one-step universal Mach-O output. [Cross-compile section](https://bun.sh/docs/bundler/executables#cross-compile-to-other-platforms)
- Imported assets can be embedded, but runtime path lookup, unconstrained dynamic imports/requires, and native `.node` modules need explicit build verification. Native dependencies also introduce target-specific binaries and signing concerns. [Embedding files](https://bun.sh/docs/bundler/executables#embed-assets-and-files)
- Compilation output depends on the selected Bun compiler/runtime version. Bun’s lockfile and frozen installation protect dependency resolution, but the executable documentation does not promise byte-for-byte reproducible builds across hosts or Bun releases. [Bun lockfile](https://bun.sh/docs/install/lockfile) · [Standalone executables](https://bun.sh/docs/bundler/executables)

### Recommendations

- Pin Bun in CI and fail installation on lockfile drift.
- Compile once per architecture on controlled macOS runners. Publish per-architecture archives initially rather than adding a `lipo` universal-binary step.
- Keep configuration, credentials, and user templates external. Embed only immutable assets with explicit imports.
- Avoid production native add-ons. Every native package should require a demonstrated benefit, two-architecture smoke coverage, and signing validation.
- Treat reproducibility as **procedural**, not guaranteed: pinned Bun and dependencies, clean runners, recorded build command, SHA-256 checksums, and retained provenance.
- Test the executable on a machine or job where `bun` is absent from `PATH`.

---

## 3. macOS Keychain

### Facts

Apple Keychain Services stores small secrets as Keychain items and lets applications query them using attributes such as service and account. [Apple, _Storing keys in the keychain_](https://developer.apple.com/documentation/security/storing-keys-in-the-keychain) · [Keychain Services concepts](https://developer.apple.com/library/archive/documentation/Security/Conceptual/keychainServConcepts/01introduction/introduction.html)

The macOS `/usr/bin/security` tool supports generic-password operations:

- `add-generic-password -a account -s service [-U]`
- `find-generic-password -a account -s service -w`
- `delete-generic-password -a account -s service`

The shipped help warns that supplying the password as a `-w value` argument is insecure; using `-w` as the last option causes an interactive prompt. `find … -w` emits only the password to stdout. These commands search or update the user’s default Keychain unless another Keychain is named (`security help add-generic-password`; `security help find-generic-password` on macOS).

Possible implementation strategies:

| Strategy                                  |      Runtime dependency | Benefits                                                                    | Costs/risks                                                                                                                                                                                                                                          |
| ----------------------------------------- | ----------------------: | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invoke `/usr/bin/security`                |                    None | Shipped by macOS; simple; callable through `Bun.spawn`; no native npm build | Subprocess error parsing; secret returned over a pipe; interactive write behavior; access prompts and ACL behavior must be tested from the final signed binary                                                                                       |
| Bind Security.framework through `bun:ffi` |    None at installation | Direct APIs and explicit query/access-control dictionaries                  | Considerably more code; CoreFoundation ownership and error conversion; FFI becomes a critical security surface. [Bun FFI](https://bun.sh/docs/api/ffi) · [Apple `SecItemAdd`](https://developer.apple.com/documentation/security/1401659-secitemadd) |
| Small Swift/Objective-C helper            | Extra signed executable | Uses Apple’s typed API; can model access control precisely                  | A second binary, IPC protocol, architecture builds, packaging, signing, notarization, and independent testing                                                                                                                                        |
| Native Node package                       |  npm plus native binary | Convenient JavaScript API                                                   | Native prebuild compatibility and signing burden. The formerly common `node-keytar` repository is archived, weakening its case for a new security-sensitive dependency. [Atom `node-keytar`](https://github.com/atom/node-keytar)                    |

The Keychain authorizes access according to Keychain access controls and code identity. Calling the `security` executable is not equivalent to the CLI itself calling Security.framework, so assumptions about “only this CLI can read the token” require empirical validation. [Apple, _Access Control Lists_](https://developer.apple.com/library/archive/documentation/Security/Conceptual/keychainServConcepts/03tasks/tasks.html)

### Recommendations

- Use `/usr/bin/security` for v1 behind:

  ```ts
  interface CredentialStore {
    get(host: string, account: string): Promise<string | null>;
    set(host: string, account: string): Promise<void>;
    delete(host: string, account: string): Promise<boolean>;
  }
  ```

- Invoke the absolute executable with an argument array. Never interpolate a shell command.
- Let `security add-generic-password … -U -w` prompt directly when practical. Do not put tokens in command arguments, environment variables, errors, debug output, or snapshots.
- Use a stable, namespaced service identifier and canonical host plus account attributes. Define host canonicalization in the auth/config semantics design.
- Distinguish “not found,” user cancellation/denial, locked Keychain, malformed output, and process failure.
- Before committing to this backend, acceptance-test create/read/update/delete from the signed executable on clean Intel and Apple Silicon accounts, including first-access prompts.
- Move to a Security.framework helper only if product requirements demand stronger application-specific access controls or non-interactive writes that the `security` workflow cannot safely provide.
- Allow an explicitly documented environment token for ephemeral automation, with Keychain persistence opt-in rather than automatic.

---

## 4. Consuming the Swagger 2.0 contract

### Local facts

The bundled [`swagger.v1.json`](../../swagger.v1.json) identifies itself as Swagger **2.0**, Forgejo API **16.0.2**, with base path `/api/v1`. It has:

- 326 paths and 506 operations;
- 246 definitions;
- 125 body-parameter operations;
- four form-data operations, three of which upload files;
- JSON, plain text, HTML, ZIP, GZIP, and octet-stream responses;
- token, Basic, sudo-header, sudo-query, and TOTP security definitions.

All operations have `operationId`, which makes selective extraction possible. Non-JSON endpoints-archive downloads, raw Markdown, patches/diffs, and uploads-require transport escape hatches regardless of generation strategy.

Swagger 2.0 describes host, base path, schemes, parameters, responses, and reusable `definitions` differently from OpenAPI 3.x. [Swagger 2.0 basic structure](https://swagger.io/docs/specification/v2_0/basic-structure/) · [OpenAPI 2.0 specification](https://spec.openapis.org/oas/v2.0.html)

### Strategy comparison

| Strategy                                    | Shipped output/dependencies                                                            | Maintainability                                                                           | Forgejo escape hatches                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Handwritten transport and endpoint wrappers | Smallest; no HTTP dependency                                                           | Excellent for a finite v1; manual drift checks                                            | Natural support for raw `Response`, streams, multipart, preview headers, and undocumented compatibility fixes |
| Generate only TypeScript types              | Types erase at runtime; generator is build-only                                        | Reduces model transcription, but Swagger 2 conversion/tool pinning may create noisy diffs | Handwritten transport remains available                                                                       |
| Generate selective runtime client           | Potentially many generated files; Fetch generator can avoid a third-party HTTP runtime | Regeneration is systematic, but templates and selected model closure must be maintained   | Generated “raw response” hooks may be awkward; wrapper layer still needed                                     |
| Generate full runtime client                | Largest source/binary surface; all 506 operations                                      | Broad coverage but shallow product design; large review diffs                             | Hardest to override cleanly                                                                                   |
| Runtime-load the Swagger document           | Bundles parser/resolver plus the contract                                              | Adapts dynamically but shifts failures to startup/runtime                                 | Flexible, but unnecessary for a versioned installable CLI                                                     |
| Custom build-time extraction                | Can produce a compact operation manifest or selected schemas                           | Good if narrowly scoped; writing a general Swagger-to-TypeScript compiler is not minimal  | Explicit exceptions can be first-class                                                                        |

OpenAPI Generator states that it supports Swagger 2.0 and OpenAPI 3.x. Its `typescript-fetch` generator produces a Fetch-based TypeScript client, and selective generation can restrict APIs/models. [OpenAPI Generator FAQ](https://openapi-generator.tech/docs/faq/#what-versions-of-openapi-spec-are-supported) · [`typescript-fetch`](https://openapi-generator.tech/docs/generators/typescript-fetch/) · [Selective generation](https://openapi-generator.tech/docs/customization/#selective-generation)

`openapi-typescript` documents support for OpenAPI 3.0 and 3.1 rather than Swagger 2.0. Using it requires a pinned conversion step such as `swagger2openapi`, followed by review of the converted contract. [openapi-typescript](https://openapi-ts.dev/introduction) · [Mermade `swagger2openapi`](https://github.com/Mermade/oas-kit/tree/main/packages/swagger2openapi)

### Recommendations

- For v1, handwrite one transport and wrappers only for operations selected by the command matrix.
- Make the transport capable of returning either decoded JSON or the raw `Response`; do not force every endpoint through JSON.
- Keep explicit support for:
  - path/query/header serialization;
  - empty and non-JSON responses;
  - pagination headers;
  - `FormData` and streaming uploads/downloads;
  - cancellation and timeout;
  - Forgejo error-envelope normalization;
  - API-version quirks isolated by operation.
- Use the Swagger file in CI as a **drift oracle**: verify referenced operation IDs still exist and optionally compare parameter/response signatures.
- If handwritten model maintenance becomes measurable, evaluate one of:
  1. selective OpenAPI Generator `typescript-fetch`, checked into generated-only directories; or
  2. Swagger 2 → OpenAPI 3 conversion plus `openapi-typescript`, with only type output shipped.
- Do not bundle a Swagger parser or full generated client into v1.
- Static TypeScript types are not runtime validation. Validate config, request-mode input, and a small number of critical response discriminants separately.

---

## 5. Dependency recommendations

### Facts and options

| Concern      | Minimal option                                                            | Package option and primary source                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parsing/help | `node:util.parseArgs` plus local command metadata                         | Commander supplies nested commands, options, help, and errors. [Commander](https://github.com/tj/commander.js)                                                                               |
| Prompts      | `node:readline/promises`; delegate hidden token entry to Keychain tooling | Modular `@inquirer/prompts` or `@clack/prompts` improves UX but adds transitive code. [Inquirer](https://github.com/SBoudrias/Inquirer.js) · [Clack](https://github.com/bombshell-dev/clack) |
| Tables       | Local column renderer; TSV/JSON for machine output                        | `cli-table3` handles spans, alignment, and wrapping. [cli-table3](https://github.com/cli-table/cli-table3)                                                                                   |
| Colors       | A few ANSI helpers gated by TTY, `NO_COLOR`, and explicit color flags     | Chalk provides mature color-level handling. [Chalk](https://github.com/chalk/chalk) · [`NO_COLOR`](https://no-color.org/)                                                                    |
| Validation   | Focused type guards for config and command envelopes                      | Zod provides runtime schemas and inferred TypeScript types. [Zod](https://zod.dev/)                                                                                                          |
| Completions  | Generate static scripts from command metadata                             | Omelette offers programmatic shell completion but is unnecessary for a static v1 tree. [Omelette](https://github.com/f/omelette)                                                             |
| HTTP         | Native `fetch`                                                            | No package recommended                                                                                                                                                                       |
| Processes    | `Bun.spawn`                                                               | No package recommended                                                                                                                                                                       |
| Keychain     | `/usr/bin/security`                                                       | No native package recommended for v1                                                                                                                                                         |

### Recommendations

Start with **zero production dependencies**. Permit a dependency only when a prototype demonstrates that local code would be larger or less correct:

- **Commander:** reasonable first addition if parser/help diagnostics become complex.
- **Prompt package:** only if interactive workflows require selection, multiselect, or robust cancellation beyond line/confirm input.
- **Table package:** only if wrapping and narrow-terminal behavior cannot be kept deterministic.
- **Zod:** consider for request-mode envelopes or config migration, not for validating every Forgejo response.
- Keep HTTP, colors, subprocesses, Keychain, and completions dependency-free.

---

## 6. Shell completions

### Facts

Bash, Zsh, and Fish use different completion formats and installation locations. Bun can print completions for Bun itself, but its public documentation does not expose a reusable completion generator for application command trees. [Bun completions](https://bun.sh/docs/installation#completions) · [Bash programmable completion](https://www.gnu.org/software/bash/manual/html_node/Programmable-Completion.html) · [Zsh completion system](https://zsh.sourceforge.io/Doc/Release/Completion-System.html) · [Fish `complete`](https://fishshell.com/docs/current/cmds/complete.html)

### Recommendations

- Generate three static files from the same canonical command metadata used by parsing/help.
- Initially complete commands, aliases, option names, enum values, and files where applicable.
- Add a hidden `__complete` protocol only if remote values such as repositories or issues are later required. It must be fast, bounded, non-interactive, and tolerant of missing auth/network.
- Ship completion files beside release artifacts and install them through the package manager or documented copy commands. Do not mutate shell startup files automatically.
- Snapshot-test generated scripts and run shell syntax checks.

---

## 7. Signing, notarization, and release artifacts

### Facts

Apple recommends Developer ID signing for software distributed outside the Mac App Store. Gatekeeper uses signing identity, notarization, and quarantine context when assessing downloaded software. [Apple Developer ID](https://developer.apple.com/developer-id/) · [Apple Platform Security: app code signing](https://support.apple.com/guide/security/app-code-signing-process-sec3ad8e6e53/web)

Apple’s notarization flow requires signed software, submission with `notarytool`, waiting for an accepted result, and optionally stapling a ticket to supported containers. Hardened runtime is enabled at signing with `codesign --options runtime`; timestamps are expected for Developer ID distribution. ZIP, DMG, and installer package are standard notarization submission containers. [Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) · [Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) · [Packaging Mac software](https://developer.apple.com/documentation/security/packaging-mac-software-for-distribution)

Signing covers the executable bytes. Combining architectures, changing metadata, or otherwise modifying the executable after signing invalidates the signature.

### Recommendations

Release pipeline order:

1. install pinned dependencies with frozen lockfile;
2. compile `darwin-arm64` and `darwin-x64`;
3. run unsigned smoke tests;
4. sign each final executable with Developer ID Application, hardened runtime, and timestamp;
5. verify with `codesign --verify --strict --verbose=2`;
6. place each binary and completion/license files in a deterministic ZIP or tar archive;
7. submit the supported archive/container with `xcrun notarytool`;
8. require an accepted result; staple only where Apple supports it;
9. test Gatekeeper assessment on downloaded/quarantined artifacts;
10. publish SHA-256 checksums and build provenance.

Prefer two archives:

- `forgejo_<version>_darwin_arm64`
- `forgejo_<version>_darwin_x86_64`

A Homebrew tap can select the correct archive and checksum. A universal binary can be investigated later, but requires combining unsigned slices first, signing the final universal file, and measuring whether its larger size improves installation enough to justify another release path.

---

## 8. Test seams

### Recommended interfaces

```ts
interface HttpTransport {
  send(request: Request): Promise<Response>;
}

interface FileStore {
  read(path: string): Promise<Uint8Array | null>;
  writeAtomic(path: string, data: Uint8Array, mode?: number): Promise<void>;
}

interface ProcessRunner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

interface CredentialStore {
  get(host: string, account: string): Promise<string | null>;
  set(host: string, account: string): Promise<void>;
  delete(host: string, account: string): Promise<boolean>;
}

interface Terminal {
  readonly stdinTTY: boolean;
  readonly stdoutTTY: boolean;
  readonly columns: number;
  writeOut(text: string): void;
  writeErr(text: string): void;
  readLine(prompt: string): Promise<string>;
}
```

### Recommended coverage

| Seam             | Unit tests                                                                                                 | Integration/smoke tests                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP             | Inject a fake `fetch`; assert URL encoding, headers, body, pagination, errors, cancellation, raw responses | Local `Bun.serve` for streaming, multipart, redirects, binary responses, and connection failures                                                                         |
| Filesystem       | In-memory fake; pure config parsing and migration tests                                                    | Temporary directory tests for permissions, rename-based atomic writes, missing parents, and corruption                                                                   |
| Git              | Fake `ProcessRunner`; assert exact executable, args, cwd, and parsed output                                | Temporary repositories using the installed `git`; detached HEAD, remotes, worktrees, and no-repository cases                                                             |
| Keychain         | Fake `CredentialStore`; verify no secret appears in errors or logs                                         | Opt-in macOS test using an isolated test service/account; final signed-artifact create/read/update/delete and prompt tests                                               |
| Terminal         | Fake streams, TTY flags, width, environment, and clock; golden tests for human/request output              | PTY tests for prompts, cancellation, narrow widths, color policy, pipes, and broken pipes                                                                                |
| Completion       | Snapshot canonical scripts and candidate output                                                            | `bash -n`, Zsh loading, and Fish syntax/invocation checks                                                                                                                |
| Compiled binary  | -                                                                                                          | Run each architecture artifact without Bun in `PATH`; test `--version`, help, invalid args, JSON request mode, local mock HTTP, exit codes, signals, and embedded assets |
| Release security | -                                                                                                          | `file`, `codesign --verify`, Gatekeeper assessment, notarization status, checksums, archive extraction, and clean-user launch                                            |

Keep command handlers pure where possible: parsed input plus injected services should produce a result object. Human rendering and request-mode serialization should consume that same result separately.

---

## Decisions deferred to later work

The implementation-seam and release work still needs to choose:

1. whether `parseArgs` remains sufficient or Commander is justified;
2. the exact canonical command metadata representation;
3. whether any Swagger-derived types are generated, and which operations form the allowlist;
4. Keychain service/account naming and acceptable first-use prompt behavior;
5. timeout, retry, pagination, and raw-response policies;
6. the Human-mode table/wrapping contract and Request-mode schema;
7. static-only versus dynamic completions;
8. minimum supported macOS version and clean-machine test matrix;
9. per-architecture versus universal artifacts;
10. Homebrew tap, direct archives, or both;
11. required signing identity, notarization credential management, provenance format, and release verification gates.

The minimal recommendation intentionally leaves each of these replaceable without changing command-domain logic.
