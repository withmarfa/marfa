/**
 * The fetch a tool makes for one caller: the instance's public fetcher,
 * behind the owner's switch and the caller's allowance, with every attempt
 * written to the audit log.
 */
import { createHash } from "node:crypto";
import { nowMs } from "../clock.js";
import type {
  FetchedFile,
  FetchFailureReason,
  PublicFetcher,
} from "../net/public-fetch.js";
import type { AuditStore, RateLimitStore } from "../storage/interface.js";

/** How many files the instance fetches for tools at once. */
export const MCP_FETCH_CONCURRENCY = 4;

/** How many fetches one credential's tool calls make in a rate-limit window. */
export const MCP_FETCH_RATE_LIMIT = 30;

const TOOL_FAILURE = {
  disabled:
    "This instance does not fetch files for tools. Save the item without the file, or ask the owner to turn fetching on.",
  rate_limited: "This credential has fetched as many files as it may for now.",
} as const;

export type ToolFetchReason = FetchFailureReason | keyof typeof TOOL_FAILURE;

export type ToolFetchOutcome<T> =
  | { kind: "fetched"; value: T; size: number }
  | {
      kind: "failed";
      reason: ToolFetchReason;
      message: string;
      status?: number;
      retryAfterSeconds?: number;
    };

/** Fetches `url` for the caller and hands the file to `save`. */
export type ToolFetch = <T>(
  url: string,
  save: (file: FetchedFile) => Promise<T>,
) => Promise<ToolFetchOutcome<T>>;

export interface ToolFetchOptions {
  fetcher: PublicFetcher;
  /** `MARFA_MCP_FETCH_ENABLED`. */
  enabled: boolean;
  audit: Pick<AuditStore, "log">;
  /** The allowance per credential, or null where rate limiting is off. */
  rateLimit: {
    store: Pick<RateLimitStore, "incrementWindows">;
    limit: number;
    windowMs: number;
  } | null;
}

export interface FetchCaller {
  /** The caller as the rate limiter keys it. */
  handle: string;
  /** The key the audit entry names. */
  keyId: string;
  clientIp: string | null;
}

/**
 * The address as the audit log keeps it: its scheme and host, and its path
 * and query only as lengths, the path with a hash to match it by. A path can
 * carry a token as well as a query can.
 */
function auditedAddress(raw: string): Record<string, unknown> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { address_length: raw.length };
  }
  return {
    scheme: url.protocol.replace(/:$/, ""),
    host: url.host,
    path_length: url.pathname.length,
    path_sha256: createHash("sha256").update(url.pathname).digest("hex"),
    query_length: url.search.length === 0 ? 0 : url.search.length - 1,
  };
}

export function toolFetchFor(
  options: ToolFetchOptions,
  caller: FetchCaller,
): ToolFetch {
  const refused = (
    reason: keyof typeof TOOL_FAILURE,
    retryAfterSeconds?: number,
  ): ToolFetchOutcome<never> => ({
    kind: "failed",
    reason,
    message: TOOL_FAILURE[reason],
    ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
  });

  const attempt = async <T>(
    url: string,
    save: (file: FetchedFile) => Promise<T>,
  ): Promise<ToolFetchOutcome<T>> => {
    if (!options.enabled) return refused("disabled");
    if (options.rateLimit !== null) {
      const key = `mcp-fetch:${caller.handle}`;
      const now = nowMs();
      const windows = await options.rateLimit.store.incrementWindows(
        "mcp-fetch",
        [key],
        options.rateLimit.windowMs,
        new Date(now).toISOString(),
      );
      const window = windows.get(key);
      if (window !== undefined && window.count > options.rateLimit.limit) {
        return refused(
          "rate_limited",
          Math.max(
            1,
            Math.ceil((new Date(window.expires_at).getTime() - now) / 1000),
          ),
        );
      }
    }
    return options.fetcher(url, save);
  };

  return async <T>(
    url: string,
    save: (file: FetchedFile) => Promise<T>,
  ): Promise<ToolFetchOutcome<T>> => {
    let outcome: ToolFetchOutcome<T> | undefined;
    try {
      outcome = await attempt(url, save);
      return outcome;
    } finally {
      await record(url, outcome);
    }
  };

  async function record(
    url: string,
    outcome: ToolFetchOutcome<unknown> | undefined,
  ): Promise<void> {
    await options.audit.log({
      key_id: caller.keyId,
      client_ip: caller.clientIp,
      action: "mcp.file_fetch",
      resource_type: "url",
      details: {
        ...auditedAddress(url),
        outcome:
          outcome === undefined
            ? "error"
            : outcome.kind === "fetched"
              ? "fetched"
              : outcome.reason,
        ...(outcome?.kind === "fetched" && { size_bytes: outcome.size }),
        ...(outcome?.kind === "failed" &&
          outcome.status !== undefined && { status: outcome.status }),
      },
    });
  }
}
