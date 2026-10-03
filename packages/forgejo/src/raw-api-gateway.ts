import { markTransmitted, request, responseTooLarge, type FetchAdapter } from "./infrastructure";

/**
 * A bounded raw REST response, safe to pass to a catalog.
 */
export type RawApiResponse = {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  media_type: string;
};
/**
 * A narrow authenticated boundary for explicitly requested Forgejo REST calls.
 */
export type RawApiGateway = {
  call(host: string, token: string, path: string, init: RequestInit): Promise<RawApiResponse>;
};

/**
 * Creates the bounded raw API transport used only by the `api` command.
 *
 * @param fetchAdapter Authenticated HTTP transport seam.
 * @returns A raw API gateway which always anchors requests at `/api/v1`.
 */
export function createRawApiGateway(fetchAdapter: FetchAdapter): RawApiGateway {
  return {
    call: async (host, token, path, init) => {
      const response = await request(fetchAdapter, `${host}/api/v1${path}`, {
        ...init,
        headers: {
          Accept: "application/json, */*",
          Authorization: `token ${token}`,
          ...init.headers,
        },
      });
      // A requested write is a mutation like any other, so a failure records whether the Host
      // received it rather than leaving its effect reading as never attempted, and an answer too
      // large to read is one the Host already sent.
      if (response.kind === "too_large")
        throw markTransmitted(responseTooLarge("api", response), init, response.transmitted);
      if (response.kind !== "response")
        throw markTransmitted(new Error(`api.${response.kind}`), init, response.transmitted);
      if (response.response.status === 401 || response.response.status === 403)
        throw markTransmitted(new Error("auth.required"), init);
      const headers = Object.fromEntries(response.response.headers.entries());
      return {
        status: response.response.status,
        headers,
        body: response.response.body,
        media_type: response.response.headers.get("content-type") ?? "application/octet-stream",
      };
    },
  };
}
