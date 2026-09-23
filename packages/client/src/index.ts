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
      `The server at this address serves contract ${String(served)}; this client was generated for contract ${String(expected)}. Use a client generated for the server's contract.`,
    );
    this.name = "ContractMismatchError";
  }
}

export interface ClientOptions {
  /** The instance's origin, e.g. `https://marfa.example.com`. */
  baseUrl: string;
  /** An API key or an access token, sent as a bearer. */
  credential: string;
  /** A `fetch` to use instead of the global one. */
  fetch?: typeof globalThis.fetch;
}

export type MarfaClient = Client<paths>;

/**
 * A typed client for one instance. Before its first request it reads the
 * root once and refuses a server whose `contract` is not the one this client
 * was generated for, with {@link ContractMismatchError}.
 */
export function createClient(options: ClientOptions): MarfaClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  let checked: Promise<void> | undefined;
  const checkContract = async (): Promise<void> => {
    const response = await fetcher(`${baseUrl}/`);
    const served = ((await response.json()) as { contract?: unknown }).contract;
    if (served !== CONTRACT_VERSION) throw new ContractMismatchError(served);
  };
  const gate: Middleware = {
    async onRequest({ request }) {
      checked ??= checkContract().catch((error: unknown) => {
        // A failure is not remembered as a pass: the next request asks again.
        checked = undefined;
        throw error;
      });
      await checked;
      request.headers.set("Authorization", `Bearer ${options.credential}`);
      return request;
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
 * the walk never stops on a short page.
 */
export async function* pages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    yield* page.data;
    if (page.next_cursor === null) return;
    if (page.next_cursor === cursor) {
      throw new Error(
        "The server answered the cursor it was given, so the walk would not end.",
      );
    }
    cursor = page.next_cursor;
  }
}
