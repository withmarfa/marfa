import createFetchClient, {
  defaultBodySerializer,
  mergeHeaders,
  type Client,
  type HeadersOptions,
  type Middleware,
} from "openapi-fetch";
import { BYTE_BODIES } from "./generated/byte-bodies.js";
import { CONTRACT_VERSION } from "./generated/contract.js";
import type { paths } from "./generated/schema.js";

export type { components, operations, paths } from "./generated/schema.js";
export { CONTRACT_VERSION };

/** The response header every answer carries its contract version in. */
export const CONTRACT_HEADER = "X-Marfa-Contract";

/**
 * An answer came from a server on another contract, or named none. Its body
 * may be shaped in ways this client cannot read, so it is not handed on.
 */
export class ContractMismatchError extends Error {
  constructor(
    /** The header as it arrived, or `null` when the answer carried none. */
    readonly served: string | null,
    /** The HTTP status of the answer that was refused. */
    readonly status: number,
    readonly expected: number = CONTRACT_VERSION,
  ) {
    super(
      served === null
        ? `The server answered ${String(status)} with no contract version, so its body cannot be read by a client generated for contract ${String(expected)}.`
        : `The server answered with contract ${JSON.stringify(served)}; this client was generated for contract ${String(expected)}. Use a client generated for the server's contract.`,
    );
    this.name = "ContractMismatchError";
  }
}

export interface ClientOptions {
  /**
   * Where the instance is served: an `http` or `https` URL, with a path
   * prefix where the instance sits under one, and no query or fragment.
   */
  baseUrl: string;
  /** An API key or an access token, sent as a bearer. */
  credential: string;
  /** A `fetch` to use instead of the global one. */
  fetch?: typeof globalThis.fetch;
}

export type MarfaClient = Client<paths>;

/** RFC 6750's `b64token`: what may follow `Bearer ` in the header. */
const BEARER = /^[A-Za-z0-9\-._~+/]+=*$/;

/**
 * Refuse a credential no bearer can carry, here rather than inside `fetch`,
 * whose refusal quotes the whole header value and so puts the secret in an
 * error an app may show or log. This message names where the fault is and
 * never what the credential holds.
 */
function checkCredential(credential: string): void {
  if (BEARER.test(credential)) return;
  if (credential === "") {
    throw new TypeError("credential is empty");
  }
  const at = credential.search(/[^A-Za-z0-9\-._~+/=]/);
  throw new TypeError(
    at === -1
      ? "credential is not a bearer token: '=' may only end one, after at least one other character"
      : `credential is not a bearer token: the character at index ${String(at)} is not one a bearer token may hold`,
  );
}

/**
 * A typed client for one instance. Every answer is checked for the contract
 * version this client was generated for, and one that names another, or a
 * success that names none, is refused with {@link ContractMismatchError}
 * rather than read. An error answer with no header is handed on as it
 * came, since a proxy in front of the server answers without one and its
 * status is still the truth. The credential is sent only under the
 * configured `baseUrl`, and never after a redirect.
 *
 * Both are done where the request leaves and the answer arrives, inside the
 * client's own `fetch`, so middleware a caller adds with `use` sees a request
 * without the credential and an answer already checked.
 */
export function createClient(options: ClientOptions): MarfaClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  // Checked on the text as given: an empty query or fragment parses to none,
  // and would still end the path the calls are appended to.
  if (/[?#]/.test(options.baseUrl)) {
    throw new TypeError(
      "baseUrl names where the instance is served, with no query or fragment",
    );
  }
  const base = new URL(options.baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new TypeError(`baseUrl must be http or https, not ${base.protocol}`);
  }
  const baseUrl = base.href.replace(/\/+$/, "");
  // Held, so a caller changing its options later sends nothing unchecked.
  const credential = options.credential;
  checkCredential(credential);
  // Normalized as a request's own URL is, and ending in a slash, so the
  // comparison below is between two spellings of the same thing and a host
  // that merely begins with this one is not under it.
  const root = new URL(`${baseUrl}/`).href;
  const expected = String(CONTRACT_VERSION);

  const hold = async (response: Response): Promise<Response> => {
    const served = response.headers.get(CONTRACT_HEADER);
    if (served === expected) return response;
    if (served === null && !response.ok) return response;
    // Released rather than left for the collector, which would hold the
    // connection until it ran.
    await response.body?.cancel();
    throw new ContractMismatchError(served, response.status);
  };

  const send = async (request: Request): Promise<Response> => {
    // A per-request `baseUrl`, or a caller's middleware rewriting the URL,
    // would otherwise carry the credential to another server.
    if (!request.url.startsWith(root)) {
      throw new Error(
        `This client is for ${baseUrl}; it refuses to send ${request.url}.`,
      );
    }
    // A redirect is refused, so the credential never leaves the URL it was
    // sent to.
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${credential}`);
    return hold(
      await fetcher(new Request(request, { headers, redirect: "error" })),
    );
  };

  const gate: Middleware = {
    onRequest({ params }) {
      // A path segment of `.` or `..` survives encoding and is resolved
      // away, sending the call to another route than the one named.
      for (const value of Object.values(params.path ?? {})) {
        if (value === "." || value === "..") {
          throw new Error(
            `A path parameter of ${JSON.stringify(value)} names no resource.`,
          );
        }
      }
      return undefined;
    },
    // A caller can hand one request a `fetch` of its own, which does not
    // pass through `send`; its answer is still held here.
    onResponse({ response }) {
      return hold(response);
    },
  };
  // openapi-fetch would JSON-encode bytes into the text of an object, and
  // the server would store that text as the upload. Every other body is
  // left to it, with the headers its declaration omits but it reads to
  // choose a form encoding over JSON.
  const serialize = defaultBodySerializer as (
    body: unknown,
    headers?: Headers,
  ) => unknown;
  const client = createFetchClient<paths>({
    baseUrl,
    fetch: send,
    bodySerializer: (body: unknown, headers?: Headers) =>
      isBytes(body) ? body : serialize(body, headers),
  });
  client.use(gate);
  labelBytes(client);
  return client;
}

type Bytes = Blob | ArrayBuffer | ArrayBufferView | ReadableStream;

const isBytes = (body: unknown): body is Bytes =>
  body instanceof Blob ||
  body instanceof ArrayBuffer ||
  ArrayBuffer.isView(body) ||
  body instanceof ReadableStream;

interface Init {
  body?: unknown;
  headers?: HeadersOptions;
}

/**
 * Give a call that sends bytes the `Content-Type` its door declares, where
 * the caller named none, rather than the `application/json` openapi-fetch
 * sets on every body: the server stores a blob under the type it was sent
 * with, and refuses an archive sent as anything but its own. A Blob's own
 * type, where it has one, is the more exact name for its bytes.
 *
 * Done around each call because the serializer can change the body but not
 * the headers, and the middleware sees the headers but no longer the body.
 */
function labelBytes(client: MarfaClient): void {
  const label = (method: string, path: string, init?: Init) => {
    const body = init?.body;
    if (!init || !isBytes(body)) return init;
    // A Blob's type is "" when it was made without one.
    const own = body instanceof Blob ? body.type : "";
    const type =
      own !== ""
        ? own
        : (BYTE_BODIES[`${method} ${path}`] ?? "application/octet-stream");
    return {
      ...init,
      headers: mergeHeaders({ "Content-Type": type }, init.headers),
      // fetch refuses a streamed body unless told it is sent in one
      // direction, before any answer is read.
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    };
  };
  type Send = (method: string, path: string, init?: Init) => unknown;
  const request = client.request as unknown as Send;
  const labeled: Send = (method, path, init) =>
    request(method, path, label(method.toUpperCase(), path, init));
  const calls = client as unknown as Record<string, unknown>;
  calls.request = labeled;
  for (const method of [
    "GET",
    "PUT",
    "POST",
    "DELETE",
    "OPTIONS",
    "HEAD",
    "PATCH",
    "TRACE",
  ]) {
    calls[method] = (path: string, init?: Init) => labeled(method, path, init);
  }
}

/** One page of a list or a search, as every such door answers. */
export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

/**
 * Every row of a list, page by page, following `next_cursor` until it is
 * `null`. A page can be short, or empty, with a cursor still to follow, so
 * the walk never stops on a short page. A cursor already followed is
 * refused, since following it again would never end.
 */
export async function* pages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined;
  const followed = new Set<string>();
  for (;;) {
    const page = await fetchPage(cursor);
    // Checked before a row is handed on: a page with no cursor to read is
    // not one whose rows can be trusted to be the next ones.
    if (page.next_cursor !== null && typeof page.next_cursor !== "string") {
      throw new Error(
        "A page answered no next_cursor, so the walk cannot continue.",
      );
    }
    yield* page.data;
    if (page.next_cursor === null) return;
    if (followed.has(page.next_cursor)) {
      throw new Error(
        "The server answered a cursor this walk already followed, so it would not end.",
      );
    }
    followed.add(page.next_cursor);
    cursor = page.next_cursor;
  }
}
