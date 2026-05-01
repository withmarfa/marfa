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

/** Allowed lifecycle transitions for non-system items. The
 *  Calendar integration's tombstone path hits `trashed`. */
export type ItemState = "active" | "archived" | "trashed";

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

  /** POST /items/:id/transition with the target lifecycle state.
   *  Returns the updated item. Server validates the transition.
   *  (Same surface PR 2 added for the auto-archive integration —
   *  duplicated here so PR 5 is self-contained against main; the
   *  orchestrator resolves the trivial overlap at merge time.) */
  async transitionItem(id: string, to: ItemState): Promise<ItemResource> {
    const wrapper = await this.request<{ item: ItemResource }>(
      "POST",
      `/items/${id}/transition`,
      { state: to },
    );
    return wrapper.item;
  }

  /** Read the entire `connection.runtime` namespace blob for this
   *  Connection. The server stores the namespace as a single object —
   *  callers manage their own keys within it. The server enforces
   *  that the runtime credential's connection_id matches the path.
   *  Returns null when the namespace has never been written. Caller
   *  casts to their integration-specific shape. */
  async readRuntimeExtension(
    connectionId: string,
  ): Promise<Record<string, unknown> | null> {
    const wrapper = await this.request<{
      namespace: string;
      data: Record<string, unknown> | null;
    }>("GET", `/items/${connectionId}/extensions/connection.runtime`);
    return wrapper.data;
  }

  /** Replace the entire `connection.runtime` namespace blob. The
   *  server's PUT /items/:id/extensions/:namespace expects the body
   *  to be the namespace object directly. */
  async writeRuntimeExtension(
    connectionId: string,
    blob: Record<string, unknown>,
  ): Promise<void> {
    await this.request(
      "PUT",
      `/items/${connectionId}/extensions/connection.runtime`,
      blob,
    );
  }

  /**
   * Issue a request through the OAuth proxy at
   * `/connections/:id/proxy/<upstream_path>`. The server attaches
   * the Connection's stored access token, refreshes it if needed,
   * and forwards to `<upstream_base_url><upstream_path>`. Returns
   * the raw `Response` so the caller can stream / parse as needed.
   *
   * `upstreamPath` should start with a leading `/` (e.g.
   * `/calendar/v3/calendars/primary/events?syncToken=...`).
   */
  async proxyRequest(
    method: string,
    upstreamPath: string,
    body?: unknown,
  ): Promise<Response> {
    const path = `/connections/${this.credential.connection_id}/proxy${upstreamPath}`;
    const url = `${this.apiUrl}${path}`;
    return this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.credential.api_key}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
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
