import { request, responseTooLarge, type FetchAdapter } from "./infrastructure";
import type { ActiveIdentity, HostInspector } from "./host-session";

/**
 * Creates the bounded production HTTP inspector used to validate a Forgejo login.
 *
 * @param fetchAdapter Injectable HTTP transport.
 * @returns A Host inspector that fetches version, user, and Swagger in order.
 */
export function createHttpHostInspector(fetchAdapter: FetchAdapter): HostInspector {
  return {
    inspect: async (url, token) => {
      const version = await getJson(
        fetchAdapter,
        `${url}/api/v1/version`,
        undefined,
        "host.version",
        "host",
      );
      const user = await getJson(
        fetchAdapter,
        `${url}/api/v1/user`,
        token,
        "auth.rejected",
        "auth",
      );
      const swagger = await getText(
        fetchAdapter,
        `${url}/swagger.v1.json`,
        token,
        "host.swagger",
        "host",
      );
      return {
        version: parseVersion(version),
        identity: parseIdentity(user),
        swagger,
      };
    },
  };
}

async function getJson(
  fetchAdapter: FetchAdapter,
  url: string,
  token: string | undefined,
  code: string,
  domain: string,
): Promise<unknown> {
  const text = await getText(fetchAdapter, url, token, code, domain);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(code);
  }
}
async function getText(
  fetchAdapter: FetchAdapter,
  url: string,
  token: string | undefined,
  code: string,
  domain: string,
): Promise<string> {
  const result = await request(fetchAdapter, url, {
    headers: token === undefined ? {} : { Authorization: `token ${token}` },
  });
  // A Swagger document or user record past the read bound is a size failure, not a Host that
  // cannot answer, so it reports under the namespace of the step that asked rather than under
  // that step's own failure code.
  if (result.kind === "too_large") throw responseTooLarge(domain, result);
  if (result.kind !== "response")
    throw new Error(result.kind === "cancelled" ? "command.cancelled" : code);
  if (result.response.status === 401) throw new Error("auth.rejected");
  if (result.response.status === 403) throw new Error("auth.forbidden");
  if (result.response.status < 200 || result.response.status >= 300) throw new Error(code);
  return new TextDecoder().decode(result.response.body);
}
function parseVersion(value: unknown): string {
  if (!value || typeof value !== "object") throw new Error("host.version");
  const version = (value as { version?: unknown }).version;
  if (typeof version !== "string" || !version) throw new Error("host.version");
  return version;
}
function parseIdentity(value: unknown): ActiveIdentity {
  if (!value || typeof value !== "object") throw new Error("auth.rejected");
  const user = value as { id?: unknown; login?: unknown };
  const id = typeof user.id === "number" ? String(user.id) : user.id;
  if (typeof id !== "string" || !/^\d+$/.test(id) || typeof user.login !== "string" || !user.login)
    throw new Error("auth.rejected");
  return { id, login: user.login };
}
