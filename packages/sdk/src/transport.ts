import type { ConflictResponse, ErrorResponse } from "@mymehq/shared";
import {
  MymeError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
} from "./errors.js";

export interface TransportConfig {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(config: TransportConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      query?:
        | Record<string, string | number | boolean | string[] | undefined>
        | object;
    },
  ): Promise<T> {
    const response = await this.rawRequest(method, path, options);

    if (response.status === 204) {
      return undefined as T;
    }

    const body = await this.parseJson<T>(response);

    if (!response.ok) {
      this.throwForError(response.status, body);
    }

    return body;
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
      rawBody?: ArrayBuffer | Uint8Array | string;
      query?:
        | Record<string, string | number | boolean | string[] | undefined>
        | object;
      headers?: Record<string, string>;
    },
  ): Promise<Response> {
    const url = this.buildUrl(path, options?.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...options?.headers,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

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
        throw new MymeError(
          "timeout",
          `Request to ${path} timed out after ${String(this.timeoutMs)}ms`,
          0,
          { path, timeoutMs: this.timeoutMs },
          err,
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new MymeError(
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
      throw new MymeError(
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
    // omits one; the generic MymeError path surfaces "unknown" in that
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
        throw new MymeError(serverCode ?? "unknown", message, status, details);
    }
  }
}
