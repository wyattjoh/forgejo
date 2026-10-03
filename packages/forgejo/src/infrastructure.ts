import { createHash } from "node:crypto";
import { abandonBody } from "./adapters";
import { compareManifest, type Diagnostic, type TransmittedFailure } from "./runtime";

/**
 * The one bound on how much of a response this client reads into memory.
 *
 * Every buffered read shares it: a REST body, the advertised Swagger document, and the cached copy
 * of that document. Bulk content a command delivers to a file is streamed instead of buffered and
 * is deliberately not subject to it; see `requestStream`.
 */
export const responseReadLimit = 16 * 1024 * 1024;
/** The result of a bounded HTTP request. */
export type HttpResponse = { status: number; headers: Headers; body: Uint8Array };
/**
 * Internal transport result that never exposes raw credentials.
 *
 * A failure reports whether the request reached the Host. Only an answer is evidence that it did,
 * so a send that produced none is reported as untransmitted even though a Host may still have read
 * it, while an answer this client could not finish reading means the Host has already acted.
 *
 * A response past the read bound is its own kind rather than a `network` failure. The transport
 * worked, the size is the problem, and the two imply opposite recoveries: retrying a request whose
 * answer is simply too big re-reads the same too-big answer. It is transmitted by definition,
 * since an answer arrived at all, so a mutation behind one still reports as possibly landed.
 */
export type TransportResult =
  | { kind: "response"; response: HttpResponse }
  | {
      kind: "too_large";
      message: string;
      limit: number;
      bytes: number | null;
      status: number;
      transmitted: true;
    }
  | { kind: "timeout" | "cancelled" | "network"; message: string; transmitted: boolean };
/** A streamed transport result whose body is never held in memory. */
export type StreamResult =
  | { kind: "stream"; status: number; headers: Headers; body: ReadableStream<Uint8Array> }
  | { kind: "timeout" | "cancelled" | "network"; message: string; transmitted: boolean };
/** Minimal fetch seam for deterministic transport tests. */
export type FetchAdapter = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
/** Fetches one bounded response and classifies infrastructure failures. */
export async function request(
  fetchAdapter: FetchAdapter,
  input: RequestInfo | URL,
  init: RequestInit = {},
  maxBytes = responseReadLimit,
): Promise<TransportResult> {
  let response: Response;
  try {
    response = await fetchAdapter(input, init);
  } catch (error) {
    return interrupted(error, false);
  }
  let body: Uint8Array | undefined;
  try {
    body = await readBounded(response, maxBytes);
  } catch (error) {
    // The Host answered; this client failed part way through reading that answer. Whatever the
    // request asked for has therefore already happened.
    return interrupted(error, true);
  }
  if (body === undefined)
    return {
      kind: "too_large",
      message: "Response is larger than this client reads into memory",
      limit: maxBytes,
      bytes: advertisedBytes(response.headers),
      // The body is gone, so the status is all that remains of what the Host was answering.
      // An oversized error page is still oversized, but a caller reading the failure can see
      // that narrowing the request is not what it needs.
      status: response.status,
      transmitted: true,
    };
  return {
    kind: "response",
    response: { status: response.status, headers: response.headers, body },
  };
}

function interrupted(
  error: unknown,
  transmitted: boolean,
): { kind: "cancelled" | "network"; message: string; transmitted: boolean } {
  return error instanceof DOMException && error.name === "AbortError"
    ? { kind: "cancelled", message: "Request cancelled", transmitted }
    : { kind: "network", message: "Request failed", transmitted };
}

/**
 * Marks a failure raised once the Host had received a request that changes its state.
 *
 * A command that fails after its mutation was sent must not report its effects as `planned`, which
 * is the pre-execution state and reads as never attempted; the executor promotes a marked
 * failure's planned effects to `unknown` instead. The mark comes from what the transport actually
 * did, never from which command asked for it.
 *
 * A read is never marked. A failed read changes nothing, so a mutation whose command reads first,
 * to resolve a milestone or a run, still has honestly unattempted effects afterwards.
 *
 * @param error The failure about to be thrown.
 * @param init The request it followed.
 * @param reached Whether the Host received that request; a transport failure carries this, while a
 * failure raised over an answer the Host already sent is transmitted by definition.
 * @returns The same failure, so a call site can throw it directly.
 */
export function markTransmitted<E>(error: E, init: RequestInit, reached = true): E {
  if (reached && changesState(init.method) && typeof error === "object" && error !== null)
    (error as TransmittedFailure).transmitted = true;
  return error;
}
/**
 * Reads an answer the Host has already given, marking any failure that reading raises.
 *
 * Decoding is not the only step that can fail once a mutation has landed. Normalizing an answer
 * into this client's own shape fails the same way and under the same error code, so both belong
 * inside the marked region or a landed mutation reads as never attempted again.
 *
 * @param init The request the answer came from.
 * @param step Work that reads that answer.
 * @returns Whatever the step returns.
 */
export function readAnswer<T>(init: RequestInit, step: () => T): T {
  try {
    return step();
  } catch (error) {
    throw markTransmitted(error, init);
  }
}
/** Reports whether a request method asks the Host to change its state. */
function changesState(method: string | undefined): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes((method ?? "GET").toUpperCase());
}

/**
 * Fetches one response without reading its body, for content headed straight to a destination.
 *
 * The read bound exists to keep a response out of memory, so content that is never in memory does
 * not need it: the caller pipes this body to an Output store, and the destination filesystem, not
 * this client, bounds it. A caller that buffers instead must use `request`.
 */
export async function requestStream(
  fetchAdapter: FetchAdapter,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<StreamResult> {
  try {
    const response = await fetchAdapter(input, init);
    return {
      kind: "stream",
      status: response.status,
      headers: response.headers,
      // A bodiless response is an empty stream rather than a missing one, so a caller reads the
      // same shape whatever the Host sent.
      body: response.body ?? emptyStream(),
    };
  } catch (error) {
    // Nothing was read, so this is the send failing rather than an answer going missing.
    return interrupted(error, false);
  }
}

/**
 * Reports an over-limit response as a size failure a caller can act on.
 *
 * Shaped like a selector failure rather than a bare `Error`, so the executor carries the limit and
 * the advertised size through to the caller: a size the Host never advertised reports as null,
 * which still says the answer is past the limit without inventing a number for it.
 *
 * @param domain Error namespace of the gateway that made the request.
 * @param result The transport's own account of the bound it passed.
 * @returns A namespaced, classifiable failure.
 */
export function responseTooLarge(
  domain: string,
  result: { limit: number; bytes: number | null; status: number },
): { code: string; message: string; details: Record<string, unknown> } {
  return {
    code: `${domain}.response_too_large`,
    message: "The Host's response is larger than this client reads into memory",
    details: {
      limit_bytes: result.limit,
      response_bytes: result.bytes,
      // An oversized body under an unhappy status is an error page, not an answer to narrow, so
      // the status travels with the size rather than leaving the recovery below to mislead.
      status: result.status,
      recovery:
        "Narrow the request with page or limit, or retrieve the content with a command that delivers bytes to a file",
    },
  };
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: (controller) => controller.close(),
  });
}
function advertisedBytes(headers: Headers): number | null {
  const advertised = headers.get("content-length");
  if (advertised === null) return null;
  const value = Number(advertised);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/**
 * Reads one response body up to a bound, refusing past it rather than truncating.
 *
 * A truncated archive or log reads as corrupt rather than as too large, which is exactly the
 * confusion this bound exists to prevent, so nothing partial is ever returned. Reading also stops
 * at the first byte past the bound instead of buffering the whole body and measuring it after, and
 * a Host that advertises a length past the bound is refused before any of it is read, so an
 * oversized response costs the bound rather than its full size.
 *
 * @returns The complete body, or undefined when it is larger than the bound.
 */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const advertised = advertisedBytes(response.headers);
  if (advertised !== null && advertised > maxBytes) {
    await abandonBody(response.body);
    return undefined;
  }
  if (!response.body) {
    const buffered = new Uint8Array(await response.arrayBuffer());
    return buffered.byteLength > maxBytes ? undefined : buffered;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await abandonBody(reader);
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Decodes one successful REST body, treating an empty body under any success status as bodiless.
 *
 * Forgejo answers several successful mutations with an empty body under a status other than 204,
 * so emptiness, not the status code, decides whether there is anything to decode. A non-empty body
 * that will not parse is still a decode failure.
 *
 * @param body Raw response bytes.
 * @param invalidCode Namespaced error code raised when a non-empty body will not parse.
 * @returns The decoded value, or undefined when the response carries no body.
 */
export function decodeJsonBody<T>(body: Uint8Array, invalidCode: string): T | undefined {
  const text = new TextDecoder().decode(body).trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(invalidCode);
  }
}

/** Bounds and sanitizes diagnostics before they enter a public outcome. */
export function boundDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  let total = 0;
  return diagnostics.slice(0, 16).flatMap((item) => {
    const content = item.content
      .replace(/(?:token|authorization|bearer)[=: ]+[^\s,]+/gi, "[REDACTED]")
      .replace(/https?:\/\/[^/\s:@]+:[^@/\s]+@/gi, "https://[REDACTED]@");
    const available = 64 * 1024 - total;
    if (available <= 0) return [];
    const encoded = Buffer.from(content);
    const retained = encoded
      .subarray(0, Math.min(encoded.byteLength, 16 * 1024, available))
      .toString();
    total += Buffer.byteLength(retained);
    return [{ ...item, content: retained, truncated: item.truncated || retained !== content }];
  });
}

/** An advertised Swagger compatibility record retained by a Host profile. */
export type ContractCache = {
  fingerprint: string;
  observed_at: string;
  compatible: boolean;
  missing_operations: string[];
  quarantined: boolean;
};
/** Validates a bounded advertised Swagger subset against the committed manifest. */
export function validateAdvertisedContract(
  document: string,
  expected: Array<{ operation_id: string; method: string; path: string }>,
  now: Date,
): ContractCache {
  if (Buffer.byteLength(document) > responseReadLimit)
    return {
      fingerprint: "",
      observed_at: now.toISOString(),
      compatible: false,
      missing_operations: ["document.too_large"],
      quarantined: true,
    };
  try {
    const source = JSON.parse(document) as {
      paths?: Record<string, Record<string, { operationId?: string }>>;
    };
    const advertised = Object.entries(source.paths ?? {}).flatMap(([path, methods]) =>
      Object.entries(methods).flatMap(([method, operation]) =>
        operation.operationId
          ? [{ operation_id: operation.operationId, method: method.toUpperCase(), path }]
          : [],
      ),
    );
    const compared = compareManifest(expected, advertised);
    return {
      fingerprint: createHash("sha256").update(document).digest("hex"),
      observed_at: now.toISOString(),
      compatible: compared.compatible,
      missing_operations: compared.missing,
      quarantined: !compared.compatible,
    };
  } catch {
    return {
      fingerprint: "",
      observed_at: now.toISOString(),
      compatible: false,
      missing_operations: ["document.invalid"],
      quarantined: true,
    };
  }
}

/** Reports whether a compatible contract cache remains fresh for mutation preflight. */
export function isFresh(cache: ContractCache, now: Date): boolean {
  return (
    cache.compatible && now.getTime() - new Date(cache.observed_at).getTime() <= 24 * 60 * 60 * 1000
  );
}

/** Provides a cancellation seam that makes the first signal observable without exiting tests. */
export function createCancellation(): { cancelled: () => boolean; cancel: () => void } {
  let cancelled = false;
  return {
    cancelled: () => cancelled,
    cancel: () => {
      cancelled = true;
    },
  };
}
