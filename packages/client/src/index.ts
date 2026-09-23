import createFetchClient, { type Client, type Middleware } from "openapi-fetch";
import { CONTRACT_VERSION } from "./contract.js";
import type { paths } from "./schema.js";

export type { components, operations, paths } from "./schema.js";
export { CONTRACT_VERSION };

/**
 * The server advertises a contract this client was not generated for. Its
 * answers may be shaped in ways this client cannot read, so nothing is sent
 * to it past the root.
 */
export class ContractMismatchError extends Error {
  constructor(
    readonly served: unknown,
    readonly expected: number = CONTRACT_VERSION,
  ) {
    super(
      `The server at this address serves contract ${served === undefined ? "none" : JSON.stringify(served)}; this client was generated for contract ${String(expected)}. Use a client generated for the server's contract.`,
    );
    this.name = "ContractMismatchError";
  }
}

/**
 * The root could not be read, so which contract the server speaks is
 * unknown. Nothing past the root was sent, and the next request asks again.
 */
export class ContractUnreadableError extends Error {
  constructor(readonly status: number | undefined) {
    super(
      status === undefined
        ? "The server's root did not answer JSON, so which contract it speaks is unknown."
        : `The server's root answered ${String(status)}, so which contract it speaks is unknown.`,
    );
    this.name = "ContractUnreadableError";
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

/** How long the root may take to answer before the check fails. */
const ROOT_BUDGET_MS = 10_000;

/**
 * A typed client for one instance. Before its first request it reads the
 * root once, without the credential, and refuses a server whose `contract`
 * is not the one this client was generated for with
 * {@link ContractMismatchError}, or one whose root cannot be read with
 * {@link ContractUnreadableError}. The credential is sent only under the
 * configured `baseUrl`, never to the root, and never after a redirect.
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
  // Normalized as a request's own URL is, so the comparisons below are
  // between two spellings of the same thing.
  const root = new URL(`${baseUrl}/`).href;
  let checked: Promise<void> | undefined;
  const checkContract = async (): Promise<void> => {
    // A redirect is refused rather than followed: the contract read has to
    // be the configured server's, not whatever it points at.
    const response = await fetcher(root, {
      redirect: "error",
      signal: AbortSignal.timeout(ROOT_BUDGET_MS),
    });
    if (!response.ok) throw new ContractUnreadableError(response.status);
    let served: unknown;
    try {
      served = ((await response.json()) as { contract?: unknown }).contract;
    } catch {
      throw new ContractUnreadableError(undefined);
    }
    if (served !== CONTRACT_VERSION) throw new ContractMismatchError(served);
  };
  /** The check, abandoned by this request if its own signal aborts first. */
  const awaitCheck = (signal: AbortSignal): Promise<void> => {
    checked ??= checkContract().catch((error: unknown) => {
      // A failure is not remembered as a pass: the next request asks again.
      checked = undefined;
      throw error;
    });
    const reason = () =>
      signal.reason instanceof Error
        ? signal.reason
        : new Error("The request was aborted before the contract was read.");
    if (signal.aborted) return Promise.reject(reason());
    return new Promise<void>((resolve, reject) => {
      const abandon = () => {
        reject(reason());
      };
      signal.addEventListener("abort", abandon, { once: true });
      checked?.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", abandon);
      });
    });
  };
  const gate: Middleware = {
    async onRequest({ request, params }) {
      // A per-request `baseUrl` would otherwise carry the credential to a
      // server whose contract was never read.
      if (request.url !== root && !request.url.startsWith(root)) {
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
      await awaitCheck(request.signal);
      // The root answers without a credential, and is not sent one. A
      // redirect is refused, so the credential never leaves the URL it was
      // sent to.
      const headers = new Headers(request.headers);
      if (request.url.split(/[?#]/)[0] !== root) {
        headers.set("Authorization", `Bearer ${options.credential}`);
      }
      return new Request(request, { headers, redirect: "error" });
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
