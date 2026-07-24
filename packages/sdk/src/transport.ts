import type { ConflictResponse, ErrorResponse } from "@withmarfa/shared";
import {
  MarfaError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
} from "./errors.js";

/** Minimal TokenProvider shape — keeps this transport file independent
 *  of the @withmarfa/sdk/auth subpath so the data root doesn't drag the
 *  auth bundle into headless consumers. */
export interface TokenProviderLike {
  getAccessToken(): Promise<string>;
  /** Forces a renewal and returns the new access token, single-flighted so
   *  concurrent callers share one exchange. Optional: a provider with no way
   *  to renew leaves it off and a 401 surfaces without a retry. */
  refresh?: () => Promise<string>;
}

export interface TransportConfig {
  baseUrl: string;
  /** Static API key (marfa_k1_*). Mutually exclusive with `tokenProvider`. */
  apiKey?: string;
  /** OAuth token provider (marfa_at_*). When it exposes `refresh()`, a 401
   *  forces one renewal and one retry. Mutually exclusive with `apiKey`. */
  tokenProvider?: TokenProviderLike;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface RawRequestOptions {
  body?: unknown;
  rawBody?: ArrayBuffer | Uint8Array | string | FormData | Blob;
  query?:
    | Record<string, string | number | boolean | string[] | undefined>
    | object;
  headers?: Record<string, string>;
  /** Per-call timeout override (ms). Falls back to transport default. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Release an unread body so the runtime doesn't keep the connection pinned
 *  by a stream nobody will consume. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed, or a Response shape without a cancelable body.
  }
}

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly tokenProvider: TokenProviderLike | undefined;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  /** Set when a forced renewal failed to clear a 401, cleared by the next
   *  response that isn't one. See `reauthorize`. */
  private forcedRefreshSuppressed = false;

  constructor(config: TransportConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.tokenProvider = config.tokenProvider;
    if (!this.apiKey && !this.tokenProvider) {
      throw new Error(
        "MarfaClient requires either { apiKey } or { tokenProvider }",
      );
    }
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Resolves the Authorization header for the next attempt, along with the
   *  bearer behind it (null for API keys) so the 401 path can tell whether
   *  the credential it sent is still the current one. For tokenProvider
   *  callers this may trigger a proactive refresh under the hood. */
  private async resolveCredential(): Promise<{
    header: string;
    accessToken: string | null;
  }> {
    if (this.apiKey) {
      return { header: `Bearer ${this.apiKey}`, accessToken: null };
    }
    if (!this.tokenProvider) {
      throw new MarfaError(
        "configuration_error",
        "MarfaClient has no apiKey or tokenProvider — this should be unreachable",
        0,
      );
    }
    const accessToken = await this.tokenProvider.getAccessToken();
    return { header: `Bearer ${accessToken}`, accessToken };
  }

  /**
   * Decides how to answer a 401. Returns the Authorization header to retry
   * with, or null to let the 401 stand.
   *
   * The proactive-refresh window only covers a token that is about to expire
   * by the clock. A token revoked, rotated out, or invalidated server-side
   * ahead of that window still reads as valid locally, so without this path a
   * recoverable session ends in a forced sign-in.
   *
   * Three guards keep the recovery from becoming its own request storm:
   * concurrent 401s share the provider's single-flight exchange; a credential
   * another caller already rotated in is retried as-is rather than spending
   * the refresh token again; and a renewal that fails to clear the 401 stands
   * the whole mechanism down until something succeeds, so a request loop
   * failing for some other reason can never become a token-endpoint loop.
   */
  private async reauthorize(sentToken: string): Promise<string | null> {
    const provider = this.tokenProvider;
    if (!provider?.refresh || this.forcedRefreshSuppressed) return null;
    try {
      // A concurrent caller may have rotated the credential while this
      // request was in flight. The server has never rejected that one, so
      // try it before spending the refresh token.
      const current = await provider.getAccessToken();
      if (current !== sentToken) return `Bearer ${current}`;
      return `Bearer ${await provider.refresh()}`;
    } catch {
      // A dead grant is reported through the provider's own sign-out channel
      // and latches there — every later call throws before reaching the
      // network. Swallow it here so the caller still sees the auth failure
      // the request itself earned rather than a substituted OAuth error.
      return null;
    }
  }

  async request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      query?:
        | Record<string, string | number | boolean | string[] | undefined>
        | object;
      /** Per-call timeout override (ms). Falls back to the transport
       *  default (30s). Used by polling helpers that want a tighter
       *  per-request budget than the default global. */
      timeoutMs?: number;
    },
  ): Promise<T> {
    const { data } = await this.requestWithStatus<T>(method, path, options);
    return data;
  }

  /**
   * Like {@link request}, but additionally surfaces the HTTP response
   * status so callers can branch on 200 vs 201 (or any other 2xx). Used
   * by `client.items.upsert` to distinguish a fresh create (201) from a
   * natural-key match update (200) — `request<T>` consumes the status
   * internally so this sibling exists to thread it back out.
   *
   * Error behavior matches {@link request}: non-2xx responses throw the
   * appropriate typed `MarfaError` subclass via `throwForError`, never
   * resolve. 204 No Content resolves with `data: undefined as T` and
   * `status: 204`.
   *
   * Internal — not part of the public SDK surface. The exported `MarfaClient`
   * keeps callers at the namespace-method level (`client.items.upsert`,
   * etc.) so the transport's status-passing remains an implementation
   * detail.
   */
  // T is used by the caller to type the response body, mirroring `request<T>`.
  // The rule's "single use" heuristic doesn't account for callers explicitly
  // providing the type arg — see `requestWithStatus<{ item: Item }>` in
  // `client.items.upsert`.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async requestWithStatus<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      query?:
        | Record<string, string | number | boolean | string[] | undefined>
        | object;
      timeoutMs?: number;
    },
  ): Promise<{ data: T; status: number }> {
    const response = await this.rawRequest(method, path, options);

    if (response.status === 204) {
      return { data: undefined as T, status: 204 };
    }

    const body = await this.parseJson<T>(response);

    if (!response.ok) {
      this.throwForError(response.status, body);
    }

    return { data: body, status: response.status };
  }

  /**
   * Like request(), but returns the conflict response instead of throwing
   * when the server responds with 409. Returns either the success body or
   * the ConflictResponse for the caller to handle.
   */
  async requestWithConflict<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      query?:
        | Record<string, string | number | boolean | string[] | undefined>
        | object;
    },
  ): Promise<T | ConflictResponse> {
    const response = await this.rawRequest(method, path, options);
    const body = await this.parseJson<T | ConflictResponse>(response);

    if (response.status === 409) {
      return body;
    }

    if (!response.ok) {
      this.throwForError(response.status, body);
    }

    return body;
  }

  /**
   * Issues a request, retrying exactly once against a renewed credential when
   * the server answers 401. Every body shape the signature admits is
   * replayable, so the retry re-sends the original payload verbatim.
   */
  async rawRequest(
    method: string,
    path: string,
    options?: RawRequestOptions,
  ): Promise<Response> {
    const credential = await this.resolveCredential();
    const response = await this.dispatch(
      method,
      path,
      credential.header,
      options,
    );

    if (response.status !== 401) {
      this.forcedRefreshSuppressed = false;
      return response;
    }
    if (credential.accessToken === null) return response;

    const retryHeader = await this.reauthorize(credential.accessToken);
    if (retryHeader === null) return response;

    await discardBody(response);
    const retried = await this.dispatch(method, path, retryHeader, options);
    // A 401 that survives a credential the server has never seen isn't a
    // staleness problem, so renewing again would only add token-endpoint
    // traffic to a request that is failing for another reason.
    this.forcedRefreshSuppressed = retried.status === 401;
    return retried;
  }

  private async dispatch(
    method: string,
    path: string,
    authHeader: string,
    options?: RawRequestOptions,
  ): Promise<Response> {
    const url = this.buildUrl(path, options?.query);
    const headers: Record<string, string> = {
      Authorization: authHeader,
      ...options?.headers,
    };

    const controller = new AbortController();
    const effectiveTimeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const timeout = setTimeout(() => {
      controller.abort();
    }, effectiveTimeoutMs);

    const init: RequestInit = { method, headers, signal: controller.signal };

    if (options?.rawBody !== undefined) {
      init.body = options.rawBody;
    } else if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    try {
      return await this.fetch(url, init);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new MarfaError(
          "timeout",
          `Request to ${path} timed out after ${String(effectiveTimeoutMs)}ms`,
          0,
          { path, timeoutMs: effectiveTimeoutMs },
          err,
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new MarfaError(
        "network_error",
        `Network request to ${path} failed: ${reason}`,
        0,
        { path },
        err,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseJson<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new MarfaError(
        "parse_error",
        `Failed to parse response body as JSON (HTTP ${String(response.status)}): ${reason}`,
        0,
        { httpStatus: response.status },
        err,
      );
    }
  }

  private buildUrl(
    path: string,
    query?:
      | Record<string, string | number | boolean | string[] | undefined>
      | object,
  ): string {
    const url = `${this.baseUrl}${path}`;
    if (!query) return url;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        params.set(key, value.join(","));
      } else if (typeof value === "boolean") {
        params.set(key, value ? "true" : "false");
      } else {
        params.set(key, String(value));
      }
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  private throwForError(status: number, body: unknown): never {
    const parsed = body as Partial<ErrorResponse> | null;
    const errObj = parsed?.error;
    const message = errObj?.message ?? `HTTP ${String(status)}`;
    const details = errObj?.details;
    // Server-supplied code, passed through to preserve specificity
    // (bulk_cap_exceeded, edge_not_found, reset_disabled, …). Typed
    // subclasses fall back to their canonical code when the server
    // omits one; the generic MarfaError path surfaces "unknown" in that
    // case to preserve the shape tested in transport.test.ts.
    const serverCode = errObj?.code;

    switch (status) {
      case 400:
        throw new ValidationError(message, details, serverCode);
      case 401:
        throw new UnauthorizedError(message, details, serverCode);
      case 403:
        throw new ForbiddenError(message, details, serverCode);
      case 404:
        throw new NotFoundError(message, details, serverCode);
      default:
        throw new MarfaError(serverCode ?? "unknown", message, status, details);
    }
  }
}
