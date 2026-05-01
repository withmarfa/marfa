/**
 * ConnectionClient — a thin Myme HTTP client scoped to a single
 * Connection's runtime credential.
 *
 * Wraps the global `fetch` rather than @mymehq/sdk's MymeClient
 * because:
 *   1. The runtime-sdk runs on Cloudflare Workers (no Node Buffer);
 *      MymeClient pulls in HTTP machinery designed for Node.
 *   2. We want refresh-on-401 to live here so the underlying API is
 *      stateless from the integration's point of view — the client
 *      transparently calls the lease broker again when the cached
 *      credential expires.
 *   3. The Connection's permissions are narrow (per the manifest)
 *      and the surface a connector needs is correspondingly narrow:
 *      create item, get item, update item, list items, write
 *      `connection.runtime` extensions, emit `system.activity`.
 *      A bespoke client keeps the surface honest.
 */
import type { RuntimeCredential } from "./types.js";

export interface ConnectionClientOptions {
  /** Base URL of the Myme server (e.g. `https://myme.so`). */
  apiUrl: string;
  /** Initial runtime credential. The client refreshes via
   *  `refreshCredential` on 401. */
  credential: RuntimeCredential;
  /** Called when the credential needs to be refreshed (cache miss
   *  on 401). The runtime supplies a callback that hits the
   *  control-plane lease broker. */
  refreshCredential: () => Promise<RuntimeCredential>;
  /** Custom fetch for testing — defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

export interface CreateItemInput {
  type: string;
  properties?: Record<string, unknown>;
  edges?: Record<string, string[]>;
}

export interface ItemResource {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
  state?: "active" | "archived" | "trashed";
  created_at?: string;
  updated_at?: string;
}

export class ConnectionClient {
  private credential: RuntimeCredential;
  private readonly apiUrl: string;
  private readonly refreshCredential: () => Promise<RuntimeCredential>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ConnectionClientOptions) {
    this.credential = opts.credential;
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.refreshCredential = opts.refreshCredential;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async createItem(input: CreateItemInput): Promise<ItemResource> {
    return this.request<ItemResource>("POST", "/items", input);
  }

  async getItem(id: string): Promise<ItemResource | null> {
    try {
      return await this.request<ItemResource>("GET", `/items/${id}`);
    } catch (err) {
      if (err instanceof MymeApiError && err.status === 404) return null;
      throw err;
    }
  }

  async updateItem(
    id: string,
    patch: Partial<CreateItemInput>,
  ): Promise<ItemResource> {
    return this.request<ItemResource>("PATCH", `/items/${id}`, patch);
  }

  /** Read a `connection.runtime.<connection_id>.<key>` extension
   *  blob. The server enforces that the runtime credential's
   *  connection_id matches the path. Caller casts the returned
   *  payload to its integration-specific shape. */
  async readRuntimeExtension(
    connectionId: string,
    key: string,
  ): Promise<unknown> {
    try {
      const wrapper = await this.request<{ value: unknown }>(
        "GET",
        `/items/${connectionId}/extensions/connection.runtime/${key}`,
      );
      return wrapper.value;
    } catch (err) {
      if (err instanceof MymeApiError && err.status === 404) return null;
      throw err;
    }
  }

  async writeRuntimeExtension(
    connectionId: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    await this.request(
      "PUT",
      `/items/${connectionId}/extensions/connection.runtime/${key}`,
      { value },
    );
  }

  /** The currently-cached credential. Exposed for the per-Connection
   *  DO to persist into the runtime_credential_cached slot. */
  getCredential(): RuntimeCredential {
    return this.credential;
  }

  // ---- internals ------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const doFetch = async (): Promise<Response> =>
      this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.credential.api_key}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

    let res = await doFetch();
    if (res.status === 401) {
      // Single-flight refresh: cache miss / expired. Refresh and retry
      // exactly once; persistent 401 surfaces as MymeApiError.
      this.credential = await this.refreshCredential();
      res = await doFetch();
    }

    if (!res.ok) {
      const text = await res.text();
      throw new MymeApiError(
        `Myme API ${String(res.status)} ${res.statusText} ${method} ${path}: ${text}`,
        res.status,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

export class MymeApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "MymeApiError";
  }
}
