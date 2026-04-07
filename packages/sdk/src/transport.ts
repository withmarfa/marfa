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
      query?: Record<string, string | number | undefined>;
    },
  ): Promise<T> {
    const response = await this.rawRequest(method, path, options);

    if (response.status === 204) {
      return undefined as T;
    }

    const body = (await response.json()) as T;

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
      query?: Record<string, string | number | undefined>;
    },
  ): Promise<T | ConflictResponse> {
    const response = await this.rawRequest(method, path, options);
    const body = (await response.json()) as T | ConflictResponse;

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
      query?: Record<string, string | number | undefined>;
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
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): string {
    const url = `${this.baseUrl}${path}`;
    if (!query) return url;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
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
    const code = errObj?.code ?? "unknown";

    switch (status) {
      case 400:
        throw new ValidationError(message, details);
      case 401:
        throw new UnauthorizedError(message, details);
      case 403:
        throw new ForbiddenError(message, details);
      case 404:
        throw new NotFoundError(message, details);
      default:
        throw new MymeError(code, message, status, details);
    }
  }
}
