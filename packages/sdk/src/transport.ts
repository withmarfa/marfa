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
interface TokenProviderLike {
  getAccessToken(): Promise<string>;
}

export interface TransportConfig {
  baseUrl: string;
  /** Static API key (marfa_k1_*). Mutually exclusive with `tokenProvider`. */
  apiKey?: string;
  /** OAuth token provider (marfa_at_* with refresh-on-401 retry).
   *  Mutually exclusive with `apiKey`. */
  tokenProvider?: TokenProviderLike;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly tokenProvider: TokenProviderLike | undefined;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

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

  /** Resolves the current Authorization header value. For tokenProvider
   *  callers this may trigger a proactive refresh under the hood. */
  private async getAuthHeader(): Promise<string> {
    if (this.apiKey) return `Bearer ${this.apiKey}`;
    if (!this.tokenProvider) {
      throw new MarfaError(
        "configuration_error",
        "MarfaClient has no apiKey or tokenProvider — this should be unreachable",
        0,
      );
    }
    const token = await this.tokenProvider.getAccessToken();
    return `Bearer ${token}`;
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

  async rawRequest(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      rawBody?: ArrayBuffer | Uint8Array | string | FormData | Blob;
      query?:
        | Record<string, string | number | boolean | string[] | undefined>
        | object;
      headers?: Record<string, string>;
      /** Per-call timeout override (ms). Falls back to transport default. */
      timeoutMs?: number;
    },
  ): Promise<Response> {
    const url = this.buildUrl(path, options?.query);
    const headers: Record<string, string> = {
      Authorization: await this.getAuthHeader(),
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
