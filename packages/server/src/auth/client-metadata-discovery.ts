/**
 * Discovery of clients that name themselves by a client ID metadata document
 * (an HTTPS URL as the `client_id`), wrapped around the library's resolver so
 * that a client already stored here stays usable while its document cannot
 * be fetched, and so that clients not yet stored share a budget of their own.
 */

import {
  createCimdClientDiscovery,
  isCimdClientIdUrlCandidate,
} from "@better-auth/cimd";
import {
  extendOAuthProvider,
  type ClientMetadataResourceFetch,
} from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { credentialRequest } from "./credential-adapter.js";
import { transactionControl } from "../storage/sqlite/transaction-control.js";
import { log } from "../middleware/logger.js";
import { errorMessage } from "../error-text.js";
import { nowMs } from "../clock.js";

type CimdOptions = Parameters<typeof createCimdClientDiscovery>[0];
type ClientDiscovery = ReturnType<typeof createCimdClientDiscovery>;
type ResolveArgs = Parameters<ClientDiscovery["resolve"]>;

/**
 * Stated rather than left to the library's defaults, so a version that moves
 * them changes nothing here unnoticed. Every fetch counts against these,
 * including the revalidation of a stored client.
 */
const METADATA_FETCH_POLICY = {
  minimumFetchInterval: "1s",
  maximumConcurrentFetches: 16,
  maximumConcurrentFetchesPerOrigin: 4,
  maximumFetchesPerMinute: 120,
  maximumFetchesPerOriginPerMinute: 30,
} satisfies NonNullable<CimdOptions["metadataFetchPolicy"]>;

/**
 * The share of {@link METADATA_FETCH_POLICY} that clients not stored yet may
 * use: a minority of it, so a run of unknown `client_id` values leaves the
 * rest for the clients people have already connected.
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

function unavailable(description: string): APIError {
  return new APIError("TOO_MANY_REQUESTS", {
    error: "temporarily_unavailable",
    error_description: description,
  });
}

function isTemporarilyUnavailable(error: unknown): boolean {
  return (
    error instanceof APIError &&
    (error.body as { error?: unknown } | undefined)?.error ===
      "temporarily_unavailable"
  );
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

class FirstFetchBudget {
  private readonly starts: number[] = [];
  private readonly startsByAddress = new Map<string, number[]>();
  private active = 0;

  /** Takes one first fetch from the budget, or throws `temporarily_unavailable`. */
  acquire(address: string | null): () => void {
    const now = nowMs();
    prune(this.starts, now);
    if (this.active >= FIRST_FETCH_BUDGET.concurrent)
      throw unavailable("Too many new clients are being looked up at once");
    if (this.starts.length >= FIRST_FETCH_BUDGET.perMinute)
      throw unavailable("Too many new clients were looked up this minute");
    let byAddress: number[] | undefined;
    if (address !== null) {
      byAddress = this.startsFor(address, now);
      if (byAddress.length >= FIRST_FETCH_BUDGET.perAddressPerMinute)
        throw unavailable(
          "Too many new clients were looked up from this address this minute",
        );
      byAddress.push(now);
    }
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
    if (known) {
      prune(known, now);
      return known;
    }
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
 * The discovery the provider resolves metadata document clients through.
 *
 * A client already stored keeps its stored registration when its document
 * cannot be fetched: the host is unreachable, too slow, or answers 408, 429
 * or a 5xx, or the fetch budget is spent. A document that is fetched and
 * fails validation still refuses the client. While a write transaction is
 * open, a stored client is never fetched, so a slow host cannot hold the
 * database writer.
 */
export function buildClientMetadataDiscovery(
  fetchResource: ClientMetadataResourceFetch,
): ClientDiscovery {
  const unreachable = new Set<string>();
  const transport: ClientMetadataResourceFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : input).href;
    unreachable.delete(url);
    try {
      const response = await fetchResource(input, init);
      if (isUnavailableStatus(response.status)) {
        unreachable.add(url);
        return response;
      }
      if (response.redirected) return response;
      // Read here, where a stalled body can be told apart from a bad one.
      const body = await readCapped(response, init?.signal);
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      unreachable.add(url);
      throw error;
    }
  };

  const inner = createCimdClientDiscovery({
    fetchClientMetadataResource: transport,
    metadataProfile: "mcp-2026-07-28",
    metadataFetchPolicy: METADATA_FETCH_POLICY,
  });
  const firstFetches = new FirstFetchBudget();

  const resolve = async (...args: ResolveArgs) => {
    const [, clientId, existingClient] = args;
    if (!isCimdClientIdUrlCandidate(clientId)) return inner.resolve(...args);
    const url = new URL(clientId).href;
    if (existingClient) {
      if (transactionControl.getStore() !== undefined) return existingClient;
      try {
        return await inner.resolve(...args);
      } catch (error) {
        // Concurrent resolutions of one client share a fetch, so the mark
        // stays until the next fetch of that document clears it.
        if (!isTemporarilyUnavailable(error) && !unreachable.has(url))
          throw error;
        log("warn", "oauth client metadata document unavailable", {
          client_id: clientId,
          error: errorMessage(error),
        });
        return existingClient;
      }
    }
    const release = firstFetches.acquire(
      credentialRequest.getStore()?.clientIp ?? null,
    );
    try {
      return await inner.resolve(...args);
    } finally {
      release();
      unreachable.delete(url);
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
