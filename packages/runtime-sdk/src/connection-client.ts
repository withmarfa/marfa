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
  /** Upstream's stable identifier for this entity. Combined with the
   *  server-stamped `source` (from the runtime credential), enables the
   *  natural-key idempotency contract on `POST /items` (T-038): a re-POST
   *  of the same `(source, source_id)` short-circuits to update instead of
   *  creating a duplicate. Inbound integrations re-syncing from upstream
   *  feeds should always set this so whole-batch retries
   *  (createItem-success / cursor-write-fail) recover cleanly. */
  source_id?: string;
}

export interface ItemResource {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
  state?: "active" | "archived" | "trashed";
  created_at?: string;
  updated_at?: string;
}

/** Query parameters for `listItems`. Mirrors the server's
 *  `GET /items` query schema; only the fields connectors realistically
 *  use are surfaced. Add more on demand. */
export interface ListItemsQuery {
  type?: string;
  state?: "active" | "archived" | "trashed";
  filter?: string;
  sort?: "created_at" | "updated_at" | "timestamp";
  direction?: "asc" | "desc";
  /** Server caps at 200; SDK leaves the cap to the server. */
  limit?: number;
  cursor?: string;
}

export interface ListItemsPage {
  data: ItemResource[];
  cursor: string | null;
  has_more: boolean;
}

/** Allowed lifecycle transitions for non-system items. The
 *  `core.task` auto-archive handler hits `archived`. */
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

  /** GET /items with the supplied query. Server caps the page size at
   *  200; the connector iterates via `cursor` for full sweeps. */
  async listItems(query: ListItemsQuery = {}): Promise<ListItemsPage> {
    const params = new URLSearchParams();
    if (query.type !== undefined) params.set("type", query.type);
    if (query.state !== undefined) params.set("state", query.state);
    if (query.filter !== undefined) params.set("filter", query.filter);
    if (query.sort !== undefined) params.set("sort", query.sort);
    if (query.direction !== undefined) params.set("direction", query.direction);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    const qs = params.toString();
    const path = qs.length === 0 ? "/items" : `/items?${qs}`;
    return this.request<ListItemsPage>("GET", path);
  }

  /** POST /items/:id/transition with the target lifecycle state.
   *  Returns the updated item. Server validates the transition. */
  async transitionItem(id: string, to: ItemState): Promise<ItemResource> {
    const wrapper = await this.request<{ item: ItemResource }>(
      "POST",
      `/items/${id}/transition`,
      { state: to },
    );
    return wrapper.item;
  }

  /** POST/GET/PATCH/DELETE through the connection-proxy route, forwarding
   *  the runtime credential. Server's wildcard `/connections/:id/proxy/*`
   *  passes through to the upstream service with the connector's stored
   *  OAuth bearer applied. Returns the raw Response so handlers stream /
   *  parse as needed. Used by the Google Calendar integration for all
   *  Calendar API calls. */
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
