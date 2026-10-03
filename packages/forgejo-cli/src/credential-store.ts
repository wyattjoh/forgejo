import type { HostCredentialStore } from "../../forgejo/src/host-session";

const service = "dev.wyattjoh.forgejo-cli.token";

/** The subset of `Bun.secrets` the credential store needs, injectable for tests. */
export type SecretsPort = {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
};

/**
 * Creates a credential store backed by the OS secret store: macOS Keychain or the Linux Secret
 * Service through libsecret.
 *
 * `noUi` is accepted for the store contract but has no effect: `Bun.secrets` offers no way to
 * forbid an access prompt.
 *
 * @param secrets Injectable secret store, `Bun.secrets` by default.
 * @returns A Host credential store keyed by the normalized Deployment URL.
 */
export function createSecretsCredentialStore(
  secrets: SecretsPort = Bun.secrets,
): HostCredentialStore {
  return {
    get: async (requestedService, account) => {
      assertService(requestedService);
      const token = await guard(() => secrets.get({ service, name: account }));
      return token ?? undefined;
    },
    put: async (requestedService, account, token) => {
      assertService(requestedService);
      if (!token) throw new Error("auth.token_empty");
      await guard(() => secrets.set({ service, name: account, value: token }));
    },
    remove: async (requestedService, account) => {
      assertService(requestedService);
      await guard(() => secrets.delete({ service, name: account }));
    },
  };
}

async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error("keychain.failed");
  }
}
function assertService(requestedService: string): void {
  if (requestedService !== service) throw new Error("keychain.invalid_service");
}
