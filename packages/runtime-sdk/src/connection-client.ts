/**
 * ConnectionClient — a thin Marfa HTTP client scoped to a single
 * Connection's runtime credential.
 *
 * Wraps the global `fetch` rather than @withmarfa/sdk's MarfaClient
 * because:
 *   1. The runtime-sdk runs on Cloudflare Workers (no Node Buffer);
 *      MarfaClient pulls in HTTP machinery designed for Node.
 *   2. We want refresh-on-401 to live here so the underlying API is
 *      stateless from the integration's point of view — the client
 *      transparently calls the lease broker again when the cached
 *      credential expires.
 *   3. The Connection's permissions are narrow (per the manifest)
 *      and the surface an integration needs is correspondingly narrow:
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
 * Headers that propagate the cycle metadata from an integration reaction
 * back to the Marfa server. Mirror the server's
 * `middleware/cycle.ts:CYCLE_HEADERS` constant. Cross-package contract —
 * change in lockstep.
 */
export const CYCLE_HEADERS = {
  ORIGIN: "X-Marfa-Cycle-Origin",
  HOP: "X-Marfa-Cycle-Hop",
} as const;

export interface ConnectionClientOptions {
  /** Base URL of the Marfa server (e.g. `https://marfa.so`). */
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
   * Parent cycle metadata for this run. When the integration is reacting
   * to an `ItemEventMessage`, pass `message.cycle`. When it's a fresh
   * schedule / webhook trigger (or any other non-reactive source), pass
   * `null`. The client stamps `X-Marfa-Cycle-Origin` /
   * `X-Marfa-Cycle-Hop` on every mutating request, computing the next
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
   *  natural-key idempotency contract on `POST /items`: a re-POST of the
   *  same `(source, source_id)` short-circuits to update instead of
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
 *  `GET /items` query schema; only the fields integrations realistically
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

/** One entry's outcome from `bulkUpsertItems`, positionally matched to
 *  the input array by `index`. */
export interface BulkUpsertResult {
  index: number;
  outcome: "created" | "updated" | "skipped" | "errored";
  id?: string;
  reason?: string;
  error?: { code: string; message: string };
}

export interface BulkUpsertResponse {
  counts: {
    created: number;
    updated: number;
    skipped: number;
    errored: number;
  };
  results: BulkUpsertResult[];
}

/** Allowed lifecycle transitions for non-system items. The
 *  `core.task` auto-archive handler hits `archived`. */
export type ItemState = "active" | "archived" | "trashed";

/** Input to `ConnectionClient.uploadBlob`. Bytes-only; pass a
 *  `ReadableStream` and the SDK rejects at the boundary. */
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

/** Response from `ConnectionClient.uploadBlob`. Mirrors the server's
 *  `POST /blobs` wire shape exactly — no envelope. Stamp
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
   * Parent cycle metadata for this run, captured at construction time.
   * The client stamps `X-Marfa-Cycle-Origin` / `X-Marfa-Cycle-Hop` on
   * every mutating request via
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
    // Server returns `{ item, metadata }` for `POST /items`; unwrap so
    // callers see the bare `ItemResource` like every other method on
    // this client.
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
      const wrapped = await this.request<{ item: ItemResource } | ItemResource>(
        "GET",
        `/items/${id}`,
      );
      if ("item" in wrapped && typeof wrapped.item === "object") {
        return wrapped.item;
      }
      return wrapped as ItemResource;
    } catch (err) {
      if (err instanceof MarfaApiError && err.status === 404) return null;
      throw err;
    }
  }

  async updateItem(
    id: string,
    patch: Partial<CreateItemInput>,
  ): Promise<ItemResource> {
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

  /**
   * POST /items/bulk — upsert a batch of items in one request.
   *
   * The point is the round trip. A backfill that writes one item per
   * request pays the full API latency per document, and against a
   * library of several thousand that is the difference between a sweep
   * that finishes and one that does not.
   *
   * Resolution is the same natural key `createItem` uses: the server
   * matches on `(source, source_id)` first and stamps `source` from the
   * runtime credential, so re-running a batch updates rather than
   * duplicates.
   *
   * `atomic: false` deliberately. A backfill wants the ninety-nine
   * documents that are fine to land while the one the server rejects is
   * reported on its own; rolling the page back because a single upstream
   * record is malformed would make the whole import hostage to it. Read
   * `counts.errored` and decide, rather than assuming the batch applied
   * in full.
   */
  async bulkUpsertItems(items: CreateItemInput[]): Promise<BulkUpsertResponse> {
    return this.request<BulkUpsertResponse>("POST", "/items/bulk", {
      items,
      mode: "upsert",
      atomic: false,
    });
  }

  /** GET /items with the supplied query. Server caps the page size at
   *  200; the integration iterates via `cursor` for full sweeps. */
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

  /** Create an edge, treating "already exists" as success. Returns
   *  "created" or "exists". Every other refusal throws: a cardinality
   *  rejection, a permission failure, or a network error means the
   *  relationship did NOT form, and a handler that swallows those is
   *  silently dropping edges. The duplicate case is identified by the
   *  server's `constraint: "duplicate"` detail, never by message text. */
  async ensureEdge(input: {
    source_id: string;
    target_id: string;
    edge_type: string;
    properties?: Record<string, unknown>;
  }): Promise<"created" | "exists"> {
    try {
      await this.createEdge(input);
      return "created";
    } catch (err) {
      if (
        err instanceof MarfaApiError &&
        err.code === "edge_constraint_violation" &&
        err.details?.constraint === "duplicate"
      ) {
        return "exists";
      }
      throw err;
    }
  }

  /** POST/GET/PATCH/DELETE through the connection-proxy route, forwarding
   *  the runtime credential. Server's wildcard `/connections/:id/proxy/*`
   *  passes through to the upstream service with the integration's stored
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
   * Upload bytes as a content-addressed Marfa blob. Forwards to the
   * server's `POST /blobs` route using this connection's runtime
   * credential — space scoping, dedup, and per-space `blobs` +
   * `storage_bytes` quotas are enforced server-side. The returned
   * `hash` is the canonical `sha256:<hex>` reference: stamp it onto
   * item properties (e.g. `properties.blob_ref` on `core.file`) on
   * a subsequent `createItem` / `updateItem`.
   *
   * **Bytes only.** `ReadableStream` is rejected at the SDK boundary
   * because the server-side route buffers via `c.req.arrayBuffer()` —
   * a stream input would mislead callers into assuming back-pressure.
   *
   * **No cycle headers.** `POST /blobs` doesn't publish events
   * through `pubsub.publish`, so cycle metadata serves no purpose
   * here — it's a storage write, not an event-emitting mutation.
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
    // Cycle headers go on mutating requests only (GET/HEAD don't trigger publishes).
    // nextHopMetadata is called once per request — all calls in a run share
    // the same parent, which is intentional: the run is one logical hop,
    // not one hop per API call.
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
   * and surfaces non-2xx as `MarfaApiError`.
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
      // Refresh once on 401; persistent 401 surfaces as MarfaApiError.
      this.credential = await this.refreshCredential();
      res = await doFetch();
    }

    if (!res.ok) {
      const text = await res.text();
      throw new MarfaApiError(
        `Marfa API ${String(res.status)} ${res.statusText} ${method} ${path}: ${text}`,
        res.status,
        parseApiErrorBody(text),
      );
    }
    if (res.status === 204) return undefined as T;
    return await res.json();
  }
}

/**
 * Coerce `content` into a `Uint8Array` the Workers / Node `fetch` accepts as
 * a raw-bytes body. Rejects non-bytes (strings, streams, null) with a clear
 * `MarfaApiError` rather than letting `fetch` silently misinterpret the input.
 * `Buffer` (Node) is also a `Uint8Array` at runtime and passes through.
 */
function toUploadBytes(content: UploadBlobInput["content"]): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  throw new MarfaApiError(
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

/**
 * Structured fields recovered from a Marfa error response body. Kept beside
 * the raw message because handlers need machine-checkable identity (which
 * refusal is this) while logs want the whole text.
 */
interface ParsedApiError {
  code?: string;
  details?: Record<string, unknown>;
}

function parseApiErrorBody(text: string): ParsedApiError {
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: unknown; details?: unknown };
    };
    const out: ParsedApiError = {};
    if (typeof parsed.error?.code === "string") out.code = parsed.error.code;
    if (
      parsed.error?.details !== null &&
      typeof parsed.error?.details === "object"
    ) {
      out.details = parsed.error.details as Record<string, unknown>;
    }
    return out;
  } catch {
    // Non-JSON bodies (proxies, HTML error pages) carry no structure.
    return {};
  }
}

export class MarfaApiError extends Error {
  readonly status: number;
  /** Marfa error code from the response body, when the body was parseable. */
  readonly code?: string;
  /** Structured error details from the response body, when present. */
  readonly details?: Record<string, unknown>;
  constructor(message: string, status: number, parsed?: ParsedApiError) {
    super(message);
    this.status = status;
    if (parsed?.code !== undefined) this.code = parsed.code;
    if (parsed?.details !== undefined) this.details = parsed.details;
    this.name = "MarfaApiError";
  }
}
