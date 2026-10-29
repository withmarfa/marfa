/**
 * Discovery of clients that name themselves by a client ID metadata document
 * (an HTTPS URL as the `client_id`), wrapped around the library's resolver.
 * A stored client whose document was fetched and refused stays refused until
 * its document is fetched and accepted again, also across a restart. Any
 * other stored client stays usable while its document cannot be fetched.
 * Clients not stored yet share a budget of first fetches of their own.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  createCimdClientDiscovery,
  isCimdClientIdUrlCandidate,
  validateClientIdUrl,
} from "@better-auth/cimd";
import {
  extendOAuthProvider,
  type ClientMetadataResourceFetch,
} from "@better-auth/oauth-provider";
import { APIError, isAPIError } from "better-auth/api";
import { credentialRequest } from "./credential-adapter.js";
import { addressBucket } from "../middleware/client-ip.js";
import { transactionControl } from "../storage/sqlite/transaction-control.js";
import { log } from "../middleware/logger.js";
import { errorMessage } from "../error-text.js";
import { nowMs } from "../clock.js";

type CimdOptions = Parameters<typeof createCimdClientDiscovery>[0];
type ClientDiscovery = ReturnType<typeof createCimdClientDiscovery>;
type ResolveArgs = Parameters<ClientDiscovery["resolve"]>;
type StoredClient = NonNullable<ResolveArgs[2]>;

/**
 * Stated rather than left to the library's defaults, so a version that moves
 * them changes nothing here unnoticed. Every fetch counts against these,
 * including the revalidation of a stored client.
 */
export const METADATA_FETCH_POLICY = {
  minimumFetchInterval: "1s",
  maximumConcurrentFetches: 16,
  maximumConcurrentFetchesPerOrigin: 4,
  maximumFetchesPerMinute: 120,
  maximumFetchesPerOriginPerMinute: 30,
} satisfies NonNullable<CimdOptions["metadataFetchPolicy"]>;

/**
 * The share of {@link METADATA_FETCH_POLICY} that clients not stored yet may
 * use: a minority of it, so a run of unknown `client_id` values leaves the
 * rest for the clients people have already connected. A fetch is counted
 * when it starts, so an answer from the cache, or one shared with a fetch
 * already under way, spends nothing. An IPv6 /64 counts as one address.
 */
export const FIRST_FETCH_BUDGET = {
  perMinute: 30,
  perAddressPerMinute: 10,
  concurrent: 4,
} as const;

/** One more than the library reads, so an oversized body still reads as one. */
const MAX_BUFFERED_BYTES = 5 * 1024 + 1;
const WINDOW_MS = 60_000;
/** Bounds the per-address record; past it, first fetches wait for it to age. */
const MAX_TRACKED_ADDRESSES = 1000;
/** Bounds the record of fetch outcomes, which unknown URLs also enter. */
const MAX_TRACKED_OUTCOMES = 1000;

/**
 * Errors the library throws when it fetched a document and refused it. The
 * draft (draft-ietf-oauth-client-id-metadata-document-02, sections 5 and
 * 5.1) makes every status but 200 an error, and a metadata document service
 * may retire a client by answering 404.
 */
const REFUSAL_CODES = new Set(["invalid_client", "invalid_client_metadata"]);

function unavailable(description: string): APIError {
  return new APIError("TOO_MANY_REQUESTS", {
    error: "temporarily_unavailable",
    error_description: description,
  });
}

function refusedDocument(): APIError {
  return new APIError("BAD_REQUEST", {
    error: "invalid_client",
    error_description:
      "The client's metadata document was refused when it was last fetched",
  });
}

/**
 * The OAuth error code an error carries. The library throws its own copy of
 * `APIError`, which `instanceof` against this one does not recognize.
 */
function oauthErrorCode(error: unknown): string | undefined {
  if (!isAPIError(error)) return undefined;
  const body: unknown = error.body;
  if (typeof body !== "object" || body === null) return undefined;
  const code = (body as { error?: unknown }).error;
  return typeof code === "string" ? code : undefined;
}

/** Statuses that say the host cannot answer now, not that the client changed. */
function isUnavailableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function readCapped(
  response: Response,
  signal: AbortSignal | null | undefined,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader: ReadableStreamDefaultReader<Uint8Array> =
      response.body.getReader();
    const abort = () => {
      void reader.cancel();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (total < MAX_BUFFERED_BYTES) {
        const { done, value } = await reader.read();
        if (signal?.aborted) throw new Error("aborted");
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      if (total >= MAX_BUFFERED_BYTES) await reader.cancel();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  const body = new Uint8Array(Math.min(total, MAX_BUFFERED_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const room = body.byteLength - offset;
    if (room <= 0) break;
    body.set(chunk.subarray(0, room), offset);
    offset += Math.min(chunk.byteLength, room);
  }
  return body;
}

function discardBody(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

class FirstFetchBudget {
  private readonly starts: number[] = [];
  private readonly startsByAddress = new Map<string, number[]>();
  private active = 0;

  /**
   * Throws `temporarily_unavailable` when this minute's first fetches are
   * spent, overall or for `address`, or as many as may run at once are
   * under way, without taking one.
   */
  check(address: string | null): void {
    const now = nowMs();
    prune(this.starts, now);
    if (this.active >= FIRST_FETCH_BUDGET.concurrent)
      throw unavailable("Too many new clients are being looked up at once");
    if (this.starts.length >= FIRST_FETCH_BUDGET.perMinute)
      throw unavailable("Too many new clients were looked up this minute");
    const byAddress =
      address === null ? undefined : this.startsByAddress.get(address);
    if (byAddress) {
      prune(byAddress, now);
      if (byAddress.length >= FIRST_FETCH_BUDGET.perAddressPerMinute)
        throw unavailable(
          "Too many new clients were looked up from this address this minute",
        );
    }
  }

  /** Takes one first fetch from the budget, or throws `temporarily_unavailable`. */
  acquire(address: string | null): () => void {
    this.check(address);
    const now = nowMs();
    if (address !== null) this.startsFor(address, now).push(now);
    this.starts.push(now);
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }

  private startsFor(address: string, now: number): number[] {
    const known = this.startsByAddress.get(address);
    if (known) return known;
    if (this.startsByAddress.size >= MAX_TRACKED_ADDRESSES) {
      for (const [key, starts] of this.startsByAddress) {
        prune(starts, now);
        if (starts.length === 0) this.startsByAddress.delete(key);
      }
      if (this.startsByAddress.size >= MAX_TRACKED_ADDRESSES)
        throw unavailable("Too many new clients were looked up this minute");
    }
    const created: number[] = [];
    this.startsByAddress.set(address, created);
    return created;
  }
}

function prune(starts: number[], now: number): void {
  let drop = 0;
  while (drop < starts.length && (starts[drop] ?? now) <= now - WINDOW_MS)
    drop += 1;
  if (drop > 0) starts.splice(0, drop);
}

/**
 * What the latest fetch of a document came to: the host answered and the
 * answer was read, the answer was then refused, the host could not answer,
 * or the first-fetch budget refused the fetch before it started.
 */
type FetchOutcome =
  | { kind: "answered" }
  | { kind: "refused" }
  | { kind: "unavailable" }
  | { kind: "budget"; error: unknown };

/**
 * The discovery the provider resolves metadata document clients through.
 *
 * When a stored client's document is fetched and refused, because the host
 * answers any status but 200 (other than 408, 429 or a 5xx) or the document
 * fails validation, the client's row is disabled. A later fetch that accepts
 * the document enables it again. A stored client that is not disabled keeps
 * its stored registration when its document cannot be fetched: the host is
 * unreachable or too slow, the body breaks off, the host answers 408, 429 or
 * a 5xx, or the fetch budget or the library's interval between fetches of
 * one client refuses the fetch. A disabled client is refused in those cases.
 * While a write transaction is open, a stored client is never fetched, so a
 * slow host cannot hold the database writer.
 *
 * For a metadata document client, `disabled` records only that refusal:
 * nothing else here sets it, and a document that is accepted clears it.
 */
export function buildClientMetadataDiscovery(
  fetchResource: ClientMetadataResourceFetch,
): ClientDiscovery {
  const outcomes = new Map<string, FetchOutcome>();
  const record = (url: string, outcome: FetchOutcome) => {
    outcomes.delete(url);
    if (outcomes.size >= MAX_TRACKED_OUTCOMES) {
      const oldest = outcomes.keys().next().value;
      if (oldest !== undefined) outcomes.delete(oldest);
    }
    outcomes.set(url, outcome);
  };
  const fetching = new Set<string>();
  const firstFetches = new FirstFetchBudget();
  // Set while the library resolves a client that is not stored, so the
  // transport can tell a first fetch, and its address, when one starts.
  const firstFetch = new AsyncLocalStorage<{ address: string | null }>();

  const transport: ClientMetadataResourceFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw).href;
    const first = firstFetch.getStore();
    let release: (() => void) | undefined;
    if (first) {
      try {
        release = firstFetches.acquire(first.address);
      } catch (error) {
        record(url, { kind: "budget", error });
        throw error;
      }
    }
    fetching.add(raw);
    try {
      const response = await fetchResource(input, init);
      if (response.redirected) {
        record(url, { kind: "answered" });
        discardBody(response);
        return response;
      }
      if (response.status !== 200) {
        // The library reads no body but a 200's, so a body that stalls or
        // breaks off cannot turn a refusal into an unreachable host.
        record(url, {
          kind: isUnavailableStatus(response.status)
            ? "unavailable"
            : "answered",
        });
        discardBody(response);
        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      // Read here, where a stalled body can be told apart from a bad one.
      const body = await readCapped(response, init?.signal);
      record(url, { kind: "answered" });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      record(url, { kind: "unavailable" });
      throw error;
    } finally {
      fetching.delete(raw);
      release?.();
    }
  };

  const inner = createCimdClientDiscovery({
    fetchClientMetadataResource: transport,
    metadataProfile: "mcp-2026-07-28",
    metadataFetchPolicy: METADATA_FETCH_POLICY,
  });

  const setDisabled = async (
    ctx: ResolveArgs[0],
    clientId: string,
    disabled: boolean,
  ) => {
    await ctx.context.adapter.update({
      model: "oauthClient",
      where: [
        { field: "clientId", value: clientId },
        { field: "clientDiscoveryId", value: inner.id },
      ],
      update: { disabled },
    });
  };

  // The outcome covers a row read before the refusal was written to it.
  const usable = (stored: StoredClient, url: string): StoredClient => {
    if (stored.disabled || outcomes.get(url)?.kind === "refused")
      throw refusedDocument();
    return stored;
  };

  const resolveStored = async (
    args: ResolveArgs,
    url: string,
    stored: StoredClient,
  ) => {
    const [ctx, clientId] = args;
    if (transactionControl.getStore() !== undefined) return usable(stored, url);
    try {
      const resolved = await inner.resolve(...args);
      if (!resolved?.disabled) return resolved;
      await setDisabled(ctx, clientId, false);
      return { ...resolved, disabled: false };
    } catch (error) {
      // Concurrent resolutions of one client share a fetch, so an outcome
      // stays until the next fetch of that document replaces it.
      const outcome = outcomes.get(url);
      const code = oauthErrorCode(error);
      if (
        code === "temporarily_unavailable" ||
        outcome?.kind === "unavailable"
      ) {
        log("warn", "oauth client metadata document unavailable", {
          client_id: clientId,
          error: errorMessage(error),
        });
        return usable(stored, url);
      }
      if (outcome?.kind === "answered" && code && REFUSAL_CODES.has(code)) {
        record(url, { kind: "refused" });
        log("warn", "oauth client metadata document refused", {
          client_id: clientId,
          error: errorMessage(error),
        });
        await setDisabled(ctx, clientId, true);
      }
      throw error;
    }
  };

  const resolve = async (...args: ResolveArgs) => {
    const [, clientId, existingClient] = args;
    if (!isCimdClientIdUrlCandidate(clientId)) return inner.resolve(...args);
    const url = new URL(clientId).href;
    if (existingClient) return resolveStored(args, url, existingClient);
    const ip = credentialRequest.getStore()?.clientIp ?? null;
    const address = ip === null ? null : addressBucket(ip);
    // The library takes a fetch from its own policy before it validates the
    // URL or calls the transport, and shares a fetch under way only for the
    // same `client_id` string, so both are decided here first.
    const urlError = validateClientIdUrl(clientId);
    if (urlError)
      throw new APIError("BAD_REQUEST", {
        error: "invalid_client",
        error_description: urlError,
      });
    if (!fetching.has(clientId)) firstFetches.check(address);
    try {
      return await firstFetch.run({ address }, () => inner.resolve(...args));
    } catch (error) {
      const outcome = outcomes.get(url);
      if (outcome?.kind === "budget") throw outcome.error;
      throw error;
    }
  };

  return { ...inner, resolve, fetchClientMetadataResource: fetchResource };
}

/**
 * The host that publishes a client's metadata document, for a client whose
 * `client_id` is one. Only such a client's identifier is a URL: every other
 * client's is generated here.
 */
export function metadataDocumentHost(clientId: string): string | undefined {
  return isCimdClientIdUrlCandidate(clientId)
    ? new URL(clientId).host
    : undefined;
}

/** Installs {@link buildClientMetadataDiscovery} into the provider. */
export function clientMetadataDiscoveryPlugin(
  fetchResource: ClientMetadataResourceFetch,
) {
  const clientDiscovery = buildClientMetadataDiscovery(fetchResource);
  return {
    id: "cimd" as const,
    init(ctx: Parameters<typeof extendOAuthProvider>[0]) {
      extendOAuthProvider(ctx, { clientDiscovery });
    },
  };
}
