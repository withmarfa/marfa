import createFetchClient, { type Client, type Middleware } from "openapi-fetch";
import { CONTRACT_VERSION } from "./contract.js";
import type { paths } from "./schema.js";

export type { components, operations, paths } from "./schema.js";
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

/**
 * A typed client for one instance. Every answer is checked for the contract
 * version this client was generated for, and one that names another, or a
 * success that names none, is refused with {@link ContractMismatchError}
 * rather than read. An error answer with no header is handed on as it
 * came, since a proxy in front of the server answers without one and its
 * status is still the truth. The credential is sent only under the
 * configured `baseUrl`, and never after a redirect. Middleware a caller adds
 * with `use` runs after these checks and sees the credential.
 */
export function createClient(options: ClientOptions): MarfaClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = new URL(options.baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new TypeError(`baseUrl must be http or https, not ${base.protocol}`);
  }
  if (base.search !== "" || base.hash !== "") {
    throw new TypeError(
      "baseUrl names where the instance is served, with no query or fragment",
    );
  }
  const baseUrl = base.href.replace(/\/+$/, "");
  // Normalized as a request's own URL is, so the comparison below is
  // between two spellings of the same thing.
  const root = new URL(`${baseUrl}/`).href;
  const expected = String(CONTRACT_VERSION);
  const gate: Middleware = {
    onRequest({ request, params }) {
      // A per-request `baseUrl` would otherwise carry the credential to
      // another server.
      if (!request.url.startsWith(root)) {
        throw new Error(
          `This client is for ${baseUrl}; it refuses to send ${request.url}.`,
        );
      }
      // A path segment of `.` or `..` survives encoding and is resolved
      // away, sending the call to another route than the one named.
      for (const value of Object.values(params.path ?? {})) {
        if (value === "." || value === "..") {
          throw new Error(
            `A path parameter of ${JSON.stringify(value)} names no resource.`,
          );
        }
      }
      // A redirect is refused, so the credential never leaves the URL it
      // was sent to.
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${options.credential}`);
      return new Request(request, { headers, redirect: "error" });
    },
    async onResponse({ response }) {
      const served = response.headers.get(CONTRACT_HEADER);
      if (served === expected) return undefined;
      if (served === null && !response.ok) return undefined;
      // Released rather than left for the collector, which would hold the
      // connection until it ran.
      await response.body?.cancel();
      throw new ContractMismatchError(served, response.status);
    },
  };
  const client = createFetchClient<paths>({ baseUrl, fetch: fetcher });
  client.use(gate);
  return client;
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
