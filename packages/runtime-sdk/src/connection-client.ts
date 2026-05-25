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
import {
  nextHopMetadata,
  type CycleMetadata,
  type RuntimeCredential,
} from "./types.js";

/**
 * Headers that propagate the cycle metadata from a connector reaction
 * back to the Myme server (T-039). Mirror the server's
 * `middleware/cycle.ts:CYCLE_HEADERS` constant. Cross-package contract —
 * change in lockstep.
 */
export const CYCLE_HEADERS = {
  ORIGIN: "X-Myme-Cycle-Origin",
  HOP: "X-Myme-Cycle-Hop",
} as const;

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
  /**
   * Parent cycle metadata for this run (T-039). When the connector is
   * reacting to an `ItemEventMessage`, pass `message.cycle`. When it's
   * a fresh schedule / webhook trigger (or any other non-reactive
   * source), pass `null`. The client stamps `X-Myme-Cycle-Origin` /
   * `X-Myme-Cycle-Hop` on every mutating request, computing the next
   * hop via `nextHopMetadata(cycleParent, connection_id)`.
   *
   * **Always the parent**, never pre-incremented. The client computes
   * `nextHopMetadata` once per request — passing pre-incremented data
   * here would over-count by one hop.
   */
  cycleParent?: CycleMetadata | null;
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

/** Input to `ConnectionClient.uploadBlob` (T-239). Bytes-only in v1;
 *  pass a `ReadableStream` and the SDK rejects at the boundary
 *  (server-side streaming is a paired follow-up). */
export interface UploadBlobInput {
  /** Raw bytes. Workers handlers typically pass `Uint8Array` (e.g.
   *  `new Uint8Array(await response.arrayBuffer())`) or `ArrayBuffer`
   *  directly. Node's `Buffer` satisfies `Uint8Array` structurally
   *  and is accepted as the test-path input. */
  content: Uint8Array | ArrayBuffer;
  /** Wire-level MIME type. Stamped as `Content-Type` on the request
   *  and round-tripped on the response. */
  mime_type: string;
}

/** Response from `ConnectionClient.uploadBlob` (T-239). Mirrors the
 *  server's `POST /blobs` wire shape exactly — no envelope. Stamp
 *  `properties.blob_ref = result.hash` directly on item writes. */
export interface UploadBlobResult {
  /** Content-addressed reference: `sha256:<hex>`. Stable across
   *  re-uploads of the same bytes (server-side dedup). */
  hash: string;
  mime_type: string;
  size: number;
}

export class ConnectionClient {
  private credential: RuntimeCredential;
  private readonly apiUrl: string;
  private readonly refreshCredential: () => Promise<RuntimeCredential>;
  private readonly fetchImpl: typeof fetch;
  /**
   * Parent cycle metadata for this run, captured at construction time
   * (T-039). The client stamps `X-Myme-Cycle-Origin` /
   * `X-Myme-Cycle-Hop` on every mutating request via
   * `nextHopMetadata(this.cycleParent, this.credential.connection_id)`.
   * `null` for handlers triggered by schedule / webhook (fresh chain
   * head); set to `message.cycle` for handlers triggered by an
   * `ItemEventMessage`.
   */
  private readonly cycleParent: CycleMetadata | null;

  constructor(opts: ConnectionClientOptions) {
    this.credential = opts.credential;
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.refreshCredential = opts.refreshCredential;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.cycleParent = opts.cycleParent ?? null;
  }

  async createItem(input: CreateItemInput): Promise<ItemResource> {
    // T-087: server returns `{ item, metadata }` for `POST /items`;
    // unwrap so callers see the bare `ItemResource` like every other
    // method on this client. `transitionItem` already does the same.
    // Pre-fix this method returned the wrapper as `ItemResource`, so
    // `created.id` was `undefined` at the call site (visible in the
    // github-webhooks "bookmark undefined" activity title).
    const wrapped = await this.request<{ item: ItemResource } | ItemResource>(
      "POST",
      "/items",
      input,
    );
    if ("item" in wrapped && typeof wrapped.item === "object") {
      return wrapped.item;
    }
    return wrapped as ItemResource;
  }

  async getItem(id: string): Promise<ItemResource | null> {
    try {
      // Same unwrap shape as `createItem` / `transitionItem`: the
      // server returns `GET /items/:id` as `{ item, metadata }`, not
      // the bare ItemResource. Pre-fix every handler that read
      // `item.id` / `item.properties.<x>` saw `undefined` (visible
      // during T-236's hosted Marfa walkthrough — the outbound task
      // landed on Google with `title: null` and `notes: "[myme-id:undefined]"`).
      const wrapped = await this.request<{ item: ItemResource } | ItemResource>(
        "GET",
        `/items/${id}`,
      );
      if ("item" in wrapped && typeof wrapped.item === "object") {
        return wrapped.item;
      }
      return wrapped as ItemResource;
    } catch (err) {
      if (err instanceof MymeApiError && err.status === 404) return null;
      throw err;
    }
  }

  async updateItem(
    id: string,
    patch: Partial<CreateItemInput>,
  ): Promise<ItemResource> {
    // Server returns `PATCH /items/:id` as `{ item, metadata }` — same
    // unwrap shape as the other Item-returning methods. Without this,
    // callers reading the returned `item.id` see `undefined`.
    const wrapped = await this.request<{ item: ItemResource } | ItemResource>(
      "PATCH",
      `/items/${id}`,
      patch,
    );
    if ("item" in wrapped && typeof wrapped.item === "object") {
      return wrapped.item;
    }
    return wrapped as ItemResource;
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

  /** POST /edges — create a typed edge between two items. Direction
   *  is edge-type-specific — e.g. for `parent-of` the source is parent
   *  and the target is child. Returns the server-assigned edge id.
   *  The substrate enforces edge_permissions; the runtime credential
   *  needs the edge_type in its `edge_permissions` map (see
   *  manifest.permissions.edge). */
  async createEdge(input: {
    source_id: string;
    target_id: string;
    edge_type: string;
    properties?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    return this.request<{ id: string }>("POST", "/edges", input);
  }

  /** POST/GET/PATCH/DELETE through the connection-proxy route, forwarding
   *  the runtime credential. Server's wildcard `/connections/:id/proxy/*`
   *  passes through to the upstream service with the connector's stored
   *  bearer applied (OAuth access_token for `kind: oauth_token`
   *  credentials, the static API token for `kind: api_token` credentials).
   *  Returns the raw Response so handlers stream / parse as needed.
   *  Used by the Google Calendar integration for all Calendar API
   *  calls. */
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

  /** Form-encoded variant of `proxyRequest` for upstreams that demand
   *  `application/x-www-form-urlencoded` rather than JSON. Todoist's
   *  Sync API (`POST /api/v1/sync`) is the canonical example — fields
   *  like `resource_types` + `commands` are JSON-stringified into form
   *  values rather than sent as a JSON body. Returns the raw Response
   *  so handlers parse as they need. */
  async proxyRequestForm(
    method: string,
    upstreamPath: string,
    formFields: Record<string, string>,
  ): Promise<Response> {
    const path = `/connections/${this.credential.connection_id}/proxy${upstreamPath}`;
    const url = `${this.apiUrl}${path}`;
    const body = new URLSearchParams(formFields).toString();
    return this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.credential.api_key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
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

  /**
   * Upload bytes as a content-addressed Myme blob (T-239). Forwards
   * to the server's `POST /blobs` route using this connection's
   * runtime credential — tenant scoping, dedup, and per-tenant
   * `blobs` + `storage_bytes` quotas are enforced server-side. The
   * returned `hash` is the canonical `sha256:<hex>` reference: stamp
   * it onto item properties (e.g. `properties.blob_ref` on
   * `core.file`) on a subsequent `createItem` / `updateItem`.
   *
   * **Bytes only in v1.** `ReadableStream` is rejected at the SDK
   * boundary because the server-side route currently buffers via
   * `c.req.arrayBuffer()` anyway — a stream input would mislead
   * callers into assuming back-pressure. Worker memory is the real
   * ceiling; pair with a per-handler size cap (Drive uses 25 MB).
   * Lifting that ceiling requires paired server-side streaming +
   * a stream-accepting overload — flagged as a follow-up.
   *
   * **No cycle headers.** `POST /blobs` doesn't publish events
   * through `pubsub.publish`, so the cycle metadata serves no
   * purpose on this route — it's a storage write, not an
   * event-emitting mutation.
   */
  async uploadBlob(input: UploadBlobInput): Promise<UploadBlobResult> {
    const body = toUploadBytes(input.content);
    return this.fetchJson<UploadBlobResult>("POST", "/blobs", {
      contentType: input.mime_type,
      // `Uint8Array` is a valid `BufferSource` and the Workers /
      // Node fetch runtime accepts it as a body, but lib.dom's
      // `BodyInit` declaration excludes it in some TS configurations
      // — the cast keeps the call sites honest without widening the
      // wire-level contract.
      body: body as unknown as BodyInit,
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
    // T-039: stamp cycle headers on mutating requests so the server's
    // `cycleMiddleware` can resolve `c.var.cycle` and the resulting
    // publishes carry attribution. Read-only verbs (GET/HEAD/OPTIONS)
    // don't trigger publishes — no need to bloat the headers there.
    // `nextHopMetadata` is called ONCE per request: the SDK never
    // pre-increments `this.cycleParent`. Multiple requests in the same
    // run all derive from the same parent (each gets `parent.hop + 1`)
    // — that's deliberate. The runtime contract is "this connector's
    // run is one logical hop"; per-request increments would conflate
    // an N-call handler with an N-deep chain.
    const isMutating = method !== "GET" && method !== "HEAD";
    return this.fetchJson<T>(method, path, {
      contentType: body !== undefined ? "application/json" : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      stampCycle: isMutating,
    });
  }

  /**
   * Single-flight 401-refresh + JSON-response decoder. Shared by
   * `request` (JSON body) and `uploadBlob` (raw bytes body). The
   * caller controls `contentType` + `body`; this helper just stamps
   * the bearer, optionally adds cycle headers, retries once on 401,
   * and surfaces non-2xx as `MymeApiError`.
   */
  private async fetchJson<T>(
    method: string,
    path: string,
    init: {
      contentType?: string;
      body?: BodyInit;
      stampCycle?: boolean;
    },
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const cycleHeaders: Record<string, string> = {};
    if (init.stampCycle === true) {
      const next = nextHopMetadata(
        this.cycleParent,
        this.credential.connection_id,
      );
      cycleHeaders[CYCLE_HEADERS.ORIGIN] = next.originating_connection_id ?? "";
      cycleHeaders[CYCLE_HEADERS.HOP] = String(next.hop_count);
    }
    const doFetch = async (): Promise<Response> =>
      this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.credential.api_key}`,
          ...(init.contentType !== undefined
            ? { "Content-Type": init.contentType }
            : {}),
          ...cycleHeaders,
        },
        body: init.body,
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

/**
 * Coerce a caller-supplied `content` value into a `BodyInit` the
 * Workers / Node `fetch` accepts as a raw-bytes body. Rejects
 * anything that isn't bytes — strings, streams, nulls all surface a
 * clear `MymeApiError` at the SDK boundary rather than being
 * silently misinterpreted by `fetch`.
 *
 * Returned shape:
 * - `Buffer` (Node) passes through (it is also a `Uint8Array` at
 *   runtime, but `Buffer.from(buf.buffer, ...)` would copy unnecessarily).
 * - `Uint8Array` passes through.
 * - `ArrayBuffer` wraps in a `Uint8Array` view.
 */
function toUploadBytes(content: UploadBlobInput["content"]): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  throw new MymeApiError(
    `uploadBlob: content must be Uint8Array, ArrayBuffer, or Buffer (got ${describeContent(content)})`,
    0,
  );
}

function describeContent(content: unknown): string {
  if (content === null) return "null";
  if (content === undefined) return "undefined";
  if (typeof content === "string") return "string";
  if (typeof content === "object") {
    const ctor = (content as { constructor?: { name?: string } }).constructor
      ?.name;
    return ctor ?? "object";
  }
  return typeof content;
}

export class MymeApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "MymeApiError";
  }
}
