import { z } from "zod";
import { isFresh, validateAdvertisedContract } from "./infrastructure";
import type { HostContractCacheStore } from "./host-contract-cache";
import type { GitCredentialConfigurator } from "./git-config";

const tokenService = "dev.wyattjoh.forgejo-cli.token";
const profileSchema = z
  .object({
    url: z.string().url(),
    identity: z
      .object({ id: z.string().regex(/^\d+$/), login: z.string().min(1) })
      .strict()
      .nullable(),
    server_version: z.string().min(1).nullable(),
    swagger_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
const configSchema = z
  .object({ schema_version: z.literal(1), hosts: z.array(profileSchema) })
  .strict();

/** A validated Forgejo user retained as the active identity for a Host profile. */
export type ActiveIdentity = { id: string; login: string };
/** The nonsecret persisted state for one normalized Forgejo Deployment URL. */
export type HostProfile = {
  url: string;
  identity: ActiveIdentity | null;
  server_version: string | null;
  swagger_sha256: string | null;
};
/** The strict version-one nonsecret Host configuration document. */
export type HostConfig = { schema_version: 1; hosts: HostProfile[] };
/** A deliberately narrow persistence boundary for Host profiles. */
export type HostProfileStore = {
  load(): Promise<HostConfig>;
  save(config: HostConfig): Promise<void>;
};
/** A Keychain boundary keyed exclusively by the normalized Deployment URL. */
export type HostCredentialStore = {
  get(service: string, account: string, noUi: boolean): Promise<string | undefined>;
  put(service: string, account: string, token: string, noUi: boolean): Promise<void>;
  remove(service: string, account: string, noUi: boolean): Promise<void>;
};
/** The authenticated server facts that must be established before login persists state. */
export type HostInspection = {
  version: string;
  identity: ActiveIdentity;
  swagger: string;
};
/** The bounded network capability used by HostSession. */
export type HostInspector = {
  inspect(url: string, token: string): Promise<HostInspection>;
};
/** A safe, credential-free status record returned by HostSession. */
export type HostStatus = HostProfile & {
  credential_present: boolean;
  cache_compatible: boolean;
  cache_missing_operations: string[];
  cache_fresh: boolean;
};
/** The outcome of core login persistence and optional Git credential setup. */
export type HostLoginResult = {
  profile: HostProfile;
  git_config: "configured" | "failed" | "not_configured";
};
/** An authenticated Host profile for internal gateway use only. */
export type AuthenticatedHost = { profile: HostProfile; token: string };

/** Credential seam shared by persisted CLI sessions and request-scoped OAuth sessions. */
export type HostAccess = Pick<
  HostSession,
  "login" | "logout" | "status" | "profiles" | "authenticated" | "advertisedSwagger"
>;

/**
 * Normalizes a Forgejo Deployment URL into the profile identity used by v1.
 *
 * @param value Candidate web base URL.
 * @returns The canonical deployment URL.
 */
export function normalizeDeploymentUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("host.invalid_url");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("host.invalid_url");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
    throw new Error("host.insecure_url");
  const path = url.pathname.replace(/\/+$/, "") || "";
  if (path === "/api/v1" || path.startsWith("/api/v1/"))
    throw new Error("host.api_root_not_allowed");
  const normalized = new URL(url.toString());
  normalized.pathname = path;
  normalized.search = "";
  normalized.hash = "";
  return normalized.toString().replace(/\/$/, "");
}

/**
 * Selects one Host profile by canonical URL or an unambiguous hostname shorthand.
 *
 * @param profiles Configured Host profiles.
 * @param selector Explicit profile selector.
 * @returns The selected profile.
 */
export function selectHost(profiles: HostProfile[], selector: string): HostProfile {
  const canonical = tryNormalize(selector);
  const exact = canonical ? profiles.find((profile) => profile.url === canonical) : undefined;
  if (exact) return exact;
  const matches = profiles.filter(
    (profile) => new URL(profile.url).hostname === selector.toLowerCase(),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error("host.ambiguous");
  throw new Error("host.not_found");
}

/**
 * Parses strict version-one nonsecret Host configuration without attempting recovery.
 *
 * @param source JSON configuration bytes decoded as text.
 * @returns Validated, deterministically ordered configuration.
 */
export function parseHostConfig(source: string): HostConfig {
  let value: unknown;
  try {
    assertNoDuplicateJsonKeys(source);
    value = JSON.parse(source);
  } catch {
    throw new Error("config.invalid");
  }
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new Error("config.invalid");
  const urls = parsed.data.hosts.map((profile) => normalizeDeploymentUrl(profile.url));
  if (new Set(urls).size !== urls.length) throw new Error("config.duplicate_host");
  return {
    schema_version: 1,
    hosts: sortProfiles(
      parsed.data.hosts.map((profile, index) => ({ ...profile, url: urls[index]! })),
    ),
  };
}

/** Creates an empty strict version-one Host configuration. */
export function emptyHostConfig(): HostConfig {
  return { schema_version: 1, hosts: [] };
}

/** Coordinates validated Host profile persistence and secret Keychain credentials. */
export class HostSession {
  constructor(
    private readonly store: HostProfileStore,
    private readonly credentials: HostCredentialStore,
    private readonly inspector: HostInspector,
    private readonly expectedOperations: Array<{
      operation_id: string;
      method: string;
      path: string;
    }>,
    private readonly now: () => Date,
    private readonly cache: HostContractCacheStore | undefined = undefined,
    private readonly git: GitCredentialConfigurator | undefined = undefined,
  ) {}

  /**
   * Authenticates a token before atomically replacing the selected Host profile and credential.
   *
   * @param url Deployment URL supplied to login.
   * @param token Candidate credential, never returned or diagnosed.
   * @param noUi Whether Keychain UI is forbidden.
   * @returns The persisted state and optional Git configuration outcome.
   */
  async login(url: string, token: string, noUi: boolean): Promise<HostLoginResult> {
    if (!token) throw new Error("auth.token_empty");
    const normalized = normalizeDeploymentUrl(url);
    const inspection = await this.inspector.inspect(normalized, token);
    const cache = validateAdvertisedContract(
      inspection.swagger,
      this.expectedOperations,
      this.now(),
    );
    if (!cache.compatible) throw new Error("host.contract_incompatible");
    const previous = await this.store.load();
    const previousToken = await this.credentials.get(tokenService, normalized, noUi);
    const previousCache = this.cache ? await this.cache.load(normalized) : undefined;
    const profile: HostProfile = {
      url: normalized,
      identity: inspection.identity,
      server_version: inspection.version,
      swagger_sha256: cache.fingerprint,
    };
    try {
      if (this.cache)
        await this.cache.save({ url: normalized, swagger: inspection.swagger, cache });
      await this.credentials.put(tokenService, normalized, token, noUi);
      await this.store.save(upsert(previous, profile));
    } catch (error) {
      await rollbackCredential(this.credentials, normalized, previousToken, noUi);
      await rollbackCache(this.cache, normalized, previousCache);
      throw error;
    }
    if (!this.git) return { profile, git_config: "not_configured" };
    try {
      await this.git.configure(normalized);
      return { profile, git_config: "configured" };
    } catch {
      return { profile, git_config: "failed" };
    }
  }

  /**
   * Reports Host state without exposing credential material and refreshes no persistent data.
   *
   * @param selector Explicit Host selector.
   * @param noUi Whether Keychain UI is forbidden.
   * @returns Safe status for the selected Host.
   */
  async status(selector: string, noUi: boolean): Promise<HostStatus> {
    const current = await this.store.load();
    let profile = selectHost(current.hosts, selector);
    const credential = await this.credentials.get(tokenService, profile.url, noUi);
    let cached = this.cache ? await this.cache.load(profile.url) : undefined;
    if (credential !== undefined) {
      const inspection = await this.inspector.inspect(profile.url, credential);
      const refreshed = validateAdvertisedContract(
        inspection.swagger,
        this.expectedOperations,
        this.now(),
      );
      if (!refreshed.compatible) throw new Error("host.contract_incompatible");
      profile = {
        ...profile,
        identity: inspection.identity,
        server_version: inspection.version,
        swagger_sha256: refreshed.fingerprint,
      };
      if (this.cache)
        await this.cache.save({ url: profile.url, swagger: inspection.swagger, cache: refreshed });
      await this.store.save(upsert(current, profile));
      cached = { url: profile.url, swagger: inspection.swagger, cache: refreshed };
    }
    return {
      ...profile,
      credential_present: credential !== undefined,
      cache_compatible: cached?.cache.compatible ?? profile.swagger_sha256 !== null,
      cache_missing_operations: cached?.cache.missing_operations ?? [],
      cache_fresh: cached ? isFresh(cached.cache, this.now()) : false,
    };
  }

  /**
   * Loads a compatible advertised Swagger document for dynamic raw API validation.
   *
   * @param selector Explicit Host selector.
   * @param noUi Whether Keychain UI is forbidden.
   * @returns The bounded, compatible advertised Swagger document.
   */
  async advertisedSwagger(selector: string, noUi: boolean): Promise<string> {
    const authenticated = await this.authenticated(selector, noUi);
    const cached = this.cache ? await this.cache.load(authenticated.profile.url) : undefined;
    if (cached && isFresh(cached.cache, this.now())) return cached.swagger;
    const inspection = await this.inspector.inspect(authenticated.profile.url, authenticated.token);
    const cache = validateAdvertisedContract(
      inspection.swagger,
      this.expectedOperations,
      this.now(),
    );
    if (!cache.compatible) throw new Error("host.contract_incompatible");
    if (this.cache)
      await this.cache.save({ url: authenticated.profile.url, swagger: inspection.swagger, cache });
    return inspection.swagger;
  }

  /**
   * Lists configured Host profiles without exposing their credentials.
   *
   * @returns Configured profiles in their persisted deterministic order.
   */
  async profiles(): Promise<HostProfile[]> {
    return (await this.store.load()).hosts;
  }

  /**
   * Resolves a configured Host profile with its credential for an internal gateway.
   *
   * @param selector Explicit Host selector.
   * @param noUi Whether Keychain UI is forbidden.
   * @returns The selected profile and token, which callers must not render or diagnose.
   */
  async authenticated(selector: string, noUi: boolean): Promise<AuthenticatedHost> {
    const profile = selectHost((await this.store.load()).hosts, selector);
    const token = await this.credentials.get(tokenService, profile.url, noUi);
    if (token === undefined || profile.identity === null) throw new Error("auth.required");
    return { profile, token };
  }

  /**
   * Removes the selected credential, then clears only that Host profile's active identity.
   *
   * @param selector Explicit Host selector.
   * @param noUi Whether Keychain UI is forbidden.
   * @returns The profile left configured after logout.
   */
  async logout(selector: string, noUi: boolean): Promise<HostProfile> {
    const current = await this.store.load();
    const profile = selectHost(current.hosts, selector);
    await this.credentials.remove(tokenService, profile.url, noUi);
    const loggedOut = { ...profile, identity: null };
    await this.store.save(upsert(current, loggedOut));
    return loggedOut;
  }
}

function assertNoDuplicateJsonKeys(source: string): void {
  let position = 0;
  const whitespace = /\s/;
  const skip = () => {
    while (whitespace.test(source[position] ?? "")) position++;
  };
  const string = (): string => {
    const start = position;
    if (source[position] !== '"') throw new Error("config.invalid");
    position++;
    while (position < source.length) {
      if (source[position] === "\\") position += 2;
      else if (source[position++] === '"')
        return JSON.parse(source.slice(start, position)) as string;
    }
    throw new Error("config.invalid");
  };
  const value = (): void => {
    skip();
    if (source[position] === "{") {
      position++;
      const keys = new Set<string>();
      skip();
      if (source[position] === "}") {
        position++;
        return;
      }
      while (true) {
        skip();
        const key = string();
        if (keys.has(key)) throw new Error("config.invalid");
        keys.add(key);
        skip();
        if (source[position++] !== ":") throw new Error("config.invalid");
        value();
        skip();
        if (source[position] === "}") {
          position++;
          return;
        }
        if (source[position++] !== ",") throw new Error("config.invalid");
      }
    }
    if (source[position] === "[") {
      position++;
      skip();
      if (source[position] === "]") {
        position++;
        return;
      }
      while (true) {
        value();
        skip();
        if (source[position] === "]") {
          position++;
          return;
        }
        if (source[position++] !== ",") throw new Error("config.invalid");
      }
    }
    if (source[position] === '"') {
      string();
      return;
    }
    const start = position;
    while (position < source.length && !",]} \t\r\n".includes(source[position]!)) position++;
    if (position === start) throw new Error("config.invalid");
  };
  value();
  skip();
  if (position !== source.length) throw new Error("config.invalid");
}
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
function tryNormalize(value: string): string | undefined {
  try {
    return normalizeDeploymentUrl(value);
  } catch {
    return undefined;
  }
}
function sortProfiles(profiles: HostProfile[]): HostProfile[] {
  return [...profiles].sort((left, right) => left.url.localeCompare(right.url));
}
function upsert(config: HostConfig, profile: HostProfile): HostConfig {
  return {
    schema_version: 1,
    hosts: sortProfiles([...config.hosts.filter((item) => item.url !== profile.url), profile]),
  };
}
async function rollbackCredential(
  credentials: HostCredentialStore,
  account: string,
  previous: string | undefined,
  noUi: boolean,
): Promise<void> {
  if (previous === undefined) await credentials.remove(tokenService, account, noUi);
  else await credentials.put(tokenService, account, previous, noUi);
}
async function rollbackCache(
  cache: HostContractCacheStore | undefined,
  url: string,
  previous: Awaited<ReturnType<HostContractCacheStore["load"]>>,
): Promise<void> {
  if (!cache) return;
  if (previous === undefined) await cache.remove(url);
  else await cache.save(previous);
}
