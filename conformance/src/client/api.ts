import { ofetch, type FetchOptions } from "ofetch";
import type {
  ApiResponse,
  MarfaItem,
  MarfaMetadata,
  MarfaVersion,
  MarfaEdge,
  EdgeTypeRegistration,
  EdgeTypeDefinition,
  TypeSchema,
  SearchResult,
  PaginatedResult,
  ApiKeyRequest,
  ApiKeyResponse,
  Owner,
  BlobUploadResponse,
  BlobOrphanRow,
  BlobStoreRow,
  BlobLocationRow,
  HousekeepingJobRow,
  HousekeepingRun,
  ConnectorAgreementRow,
  ConnectorAgreementsInput,
  ConnectorAgreementsWritten,
  ConnectorHoldTaken,
  ConnectorRow,
  ConnectorRun,
  ConnectorRunInput,
  ConnectorStateRow,
  ConnectorStateWritten,
  InboundDeliveryRow,
  InboundEndpointRow,
  InboundOutcome,
  BulkInput,
  BulkItemInput,
  BulkResponse,
  BulkEdgeInput,
  BulkEdgeResponse,
  BulkActionInput,
  BulkActionJob,
  BulkActionResponse,
  RestoreArchiveResponse,
  ErrorResponse,
  LookupInput,
  LookupResponse,
  Tombstone,
  Webhook,
  WebhookDelivery,
  AuditEntry,
  OccurrencesResponse,
} from "./types.js";

export interface MarfaClientOptions {
  baseUrl: string;
  apiKey: string;
}

export interface CreateItemInput {
  type: string;
  /**
   * The row's id, minted by the caller.
   *
   * Optional, and omitting it lets the server mint one. A client that renders
   * a row before its write leaves the device has to name the id itself, or the
   * row it drew and the row the server stores are two different things.
   */
  id?: string;
  properties?: Record<string, unknown>;
  source?: string;
  source_id?: string;
  state?: string;
  /**
   * Only meaningful when `source_id` resolves a live row: that upsert is
   * conditional and answers what the update door answers. Ignored on a
   * genuine create, which has no version to have read, and on a repeated
   * `id` or a trashed natural key, which are acknowledged rather than
   * written and so have no precondition to fail.
   */
  version?: number;
  tier?: "library" | "feed"; // Items are curated library content or transient feed content; system.* items have no tier
  occurred_at?: string;
  capture_latitude?: number;
  capture_longitude?: number;
  tags?: string[];
  /**
   * Atomic edges on creation — keyed by edge_type → array of target item IDs.
   * Server creates the item + edges in one transaction.
   */
  edges?: Record<string, string[]>;
}

export interface UpdateItemInput {
  properties?: Record<string, unknown>;
  /** Whether `properties` lays over the row's or is the whole of them, so a
   *  field left out is cleared (`versions.md` 11 for a stale write). */
  properties_mode?: "merge" | "replace";
  /** Move the item to this type, with `retype`. */
  type?: string;
  retype?: boolean;
  source_id?: string; // Mutable — updated value round-trips on subsequent GET
  tier?: "library" | "feed";
  /** The item's own time. One of the three fields of the row that are not
   *  properties and that the version check covers (`versions.md` 8). */
  occurred_at?: string;
  /**
   * The version the caller read. Required on this door: an update names the
   * version it is based on, or it is a blind overwrite of whatever arrived
   * since. A request without one is refused `400 missing_required_field`, so
   * a fixture that omits it here is asserting that refusal by accident.
   */
  version: number;
  /**
   * Replace-all-for-specified-types. Edges of types listed here are
   * replaced wholesale; edges of types NOT listed remain untouched.
   */
  edges?: Record<string, string[]>;
}

export interface UpdateMetadataInput {
  tags?: string[];
}

/**
 * Every failure, including a dropped connection, arrives as data on
 * `ok`/`status`/`error` rather than as a throw, so a fixture can assert on a
 * refusal the same way it asserts on a success.
 */
/** `?limit=&cursor=` for the arguments given, or nothing. */
function pageQuery(page: { limit?: number; cursor?: string }): string {
  const query = new URLSearchParams();
  if (page.limit !== undefined) query.set("limit", String(page.limit));
  if (page.cursor !== undefined) query.set("cursor", page.cursor);
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

export class MarfaClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(options: MarfaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
  }

  /**
   * `acknowledged` is present only on a repeat: send an `id` the caller has
   * already created and the server answers 200 with the stored row rather
   * than writing a second one. It is optional here because it is absent from
   * every other answer this door gives, and a caller reading it as a boolean
   * would take a first create for a repeat.
   */
  async createItem(input: CreateItemInput): Promise<
    ApiResponse<{
      item: MarfaItem;
      metadata: MarfaMetadata;
      acknowledged?: boolean;
    }>
  > {
    return this.request<{
      item: MarfaItem;
      metadata: MarfaMetadata;
      acknowledged?: boolean;
    }>("/items", {
      method: "POST",
      body: input,
    });
  }

  async getItem(
    id: string,
  ): Promise<ApiResponse<{ item: MarfaItem; metadata: MarfaMetadata }>> {
    return this.request<{ item: MarfaItem; metadata: MarfaMetadata }>(
      `/items/${id}`,
    );
  }

  async listItems(
    filters: {
      type?: string;
      state?: string;
      source?: string;
      tags?: string[];
      tier?: "library" | "feed" | "all";
      occurred_after?: string;
      occurred_before?: string;
      updated_after?: string;
      updated_before?: string;
      sort?:
        "created_at" | "updated_at" | "occurred_at" | `properties.${string}`;
      direction?: "asc" | "desc";
      limit?: number;
      cursor?: string;
      /**
       * Edge-filter shorthand map. `{ about: itemId }` becomes `edge[about]=itemId`.
       * Multiple entries combine as AND.
       */
      edge?: Record<string, string>;
      /** Optional `filter=` expression using the canonical query language. */
      filter?: string;
      /** Comma-separated `include` tokens: `edges`, `metadata`,
       *  `extensions`, `system`. */
      include?: string;
      /** Inbound edge shorthand. `{ about: itemId }` becomes
       *  `backref[about]=itemId`. */
      backref?: Record<string, string>;
    } = {},
  ): Promise<ApiResponse<PaginatedResult<MarfaItem>>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined) continue;
      if (key === "tags" && Array.isArray(value)) {
        for (const tag of value) {
          params.append("tags", tag);
        }
      } else if (key === "edge" && value && typeof value === "object") {
        for (const [edgeType, targetId] of Object.entries(
          value as Record<string, string>,
        )) {
          params.append(`edge[${edgeType}]`, targetId);
        }
      } else if (key === "backref" && value && typeof value === "object") {
        for (const [edgeType, sourceId] of Object.entries(
          value as Record<string, string>,
        )) {
          params.append(`backref[${edgeType}]`, sourceId);
        }
      } else {
        params.set(key, String(value));
      }
    }
    const query = params.toString();
    return this.request<PaginatedResult<MarfaItem>>(
      `/items${query ? `?${query}` : ""}`,
    );
  }

  async updateItem(
    id: string,
    changes: UpdateItemInput,
  ): Promise<ApiResponse<{ item: MarfaItem }>> {
    return this.request<{ item: MarfaItem }>(`/items/${id}`, {
      method: "PATCH",
      body: changes,
    });
  }

  async deleteItem(
    id: string,
    options?: { version?: number },
  ): Promise<ApiResponse<{ ok: boolean }>> {
    const query =
      options?.version !== undefined
        ? `?version=${String(options.version)}`
        : "";
    return this.request<{ ok: boolean }>(`/items/${id}${query}`, {
      method: "DELETE",
    });
  }

  /**
   * Hard delete. `deleteItem` is a soft delete, so a suite that only calls it
   * leaves its fixtures in the database.
   */
  async purgeItem(
    id: string,
    options?: { version?: number },
  ): Promise<ApiResponse<{ ok: boolean }>> {
    const query =
      options?.version !== undefined
        ? `?version=${String(options.version)}`
        : "";
    return this.request<{ ok: boolean }>(`/items/${id}/purge${query}`, {
      method: "POST",
    });
  }

  async createFolder(
    settings: Record<string, unknown>,
  ): Promise<ApiResponse<{ item: MarfaItem }>> {
    return this.request<{ item: MarfaItem }>("/folders", {
      method: "POST",
      body: settings,
    });
  }

  async updateFolder(
    id: string,
    changes: Record<string, unknown> & { version: number },
  ): Promise<ApiResponse<{ item: MarfaItem }>> {
    return this.request<{ item: MarfaItem }>(`/folders/${id}`, {
      method: "PATCH",
      body: changes,
    });
  }

  async revokeFolder(id: string): Promise<ApiResponse<{ item: MarfaItem }>> {
    return this.request<{ item: MarfaItem }>(`/folders/${id}/revoke`, {
      method: "POST",
    });
  }

  async restoreItem(id: string): Promise<ApiResponse<{ item: MarfaItem }>> {
    return this.request<{ item: MarfaItem }>(`/items/${id}/restore`, {
      method: "POST",
    });
  }

  async transitionItem(
    id: string,
    state: string,
  ): Promise<ApiResponse<{ item: MarfaItem }>> {
    return this.request<{ item: MarfaItem }>(`/items/${id}/transition`, {
      method: "POST",
      body: { state },
    });
  }

  async updateMetadata(
    id: string,
    metadata: UpdateMetadataInput,
  ): Promise<ApiResponse<{ metadata: MarfaMetadata }>> {
    return this.request<{ metadata: MarfaMetadata }>(`/items/${id}/metadata`, {
      method: "PATCH",
      body: metadata,
    });
  }

  async removeTag(
    id: string,
    tag: string,
  ): Promise<ApiResponse<{ metadata: MarfaMetadata }>> {
    return this.request<{ metadata: MarfaMetadata }>(
      `/items/${id}/tags/${encodeURIComponent(tag)}`,
      { method: "DELETE" },
    );
  }

  async getVersions(
    id: string,
    page: { limit?: number; cursor?: string } = {},
  ): Promise<ApiResponse<PaginatedResult<MarfaVersion>>> {
    const query = new URLSearchParams();
    if (page.limit !== undefined) query.set("limit", String(page.limit));
    if (page.cursor !== undefined) query.set("cursor", page.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request<PaginatedResult<MarfaVersion>>(
      `/items/${id}/versions${suffix}`,
    );
  }

  async search(
    query: string,
    filters: {
      type?: string;
      state?: string;
      limit?: number;
      /** Structured filter expression, the same grammar `GET /items`
       *  takes — edge terms included. */
      filter?: string;
      cursor?: string;
    } = {},
  ): Promise<ApiResponse<PaginatedResult<SearchResult>>> {
    const params = new URLSearchParams({ q: query });
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) params.set(key, String(value));
    }
    return this.request<PaginatedResult<SearchResult>>(`/search?${params}`);
  }

  async registerType(
    schema: TypeSchema,
  ): Promise<ApiResponse<{ type: TypeSchema }>> {
    return this.request<{ type: TypeSchema }>("/types", {
      method: "POST",
      body: schema,
    });
  }

  async listTypes(): Promise<ApiResponse<PaginatedResult<TypeSchema>>> {
    return this.request<PaginatedResult<TypeSchema>>("/types");
  }

  async getType(typeId: string): Promise<ApiResponse<TypeSchema>> {
    return this.request<TypeSchema>(`/types/${typeId}`);
  }

  async replaceType(
    typeId: string,
    schema: object,
  ): Promise<ApiResponse<{ type: TypeSchema }>> {
    return this.request<{ type: TypeSchema }>(`/types/${typeId}`, {
      method: "PUT",
      body: schema,
    });
  }

  async deleteType(
    typeId: string,
    force?: boolean,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    const query = force ? "?force=true" : "";
    return this.request<{ ok: boolean }>(`/types/${typeId}${query}`, {
      method: "DELETE",
    });
  }

  async exportItems(
    filters: {
      type?: string;
      state?: string;
      source?: string;
      occurred_after?: string;
      occurred_before?: string;
    } = {},
  ): Promise<ApiResponse<string>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const query = params.toString();
    return this.requestText(`/export${query ? `?${query}` : ""}`);
  }

  /**
   * `GET /export?format=archive` — the tar.gz restore format, returned as
   * raw bytes that `restoreArchive` posts back.
   */
  async exportArchive(
    filters: {
      type?: string;
      state?: string;
      source?: string;
      occurred_after?: string;
      occurred_before?: string;
    } = {},
  ): Promise<ApiResponse<Uint8Array>> {
    const params = new URLSearchParams({ format: "archive" });
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const url = `${this.baseUrl}/export?${params.toString()}`;
    try {
      const response = await ofetch.raw(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        responseType: "arrayBuffer",
        ignoreResponseError: true,
      });
      const ok = response.status >= 200 && response.status < 300;
      let error: ErrorResponse | undefined;
      if (!ok) {
        error = {
          error: {
            code: "UNKNOWN_ERROR",
            message: `Request failed with status ${response.status}`,
          },
        };
      }
      return {
        status: response.status,
        data: new Uint8Array(
          (response._data as ArrayBuffer) ?? new ArrayBuffer(0),
        ),
        headers: response.headers,
        ok,
        error,
      };
    } catch (err) {
      return {
        status: 0,
        data: new Uint8Array(0),
        headers: new Headers(),
        ok: false,
        error: {
          error: {
            code: "NETWORK_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
        },
      };
    }
  }

  /** `PUT /items/:id/extensions/:namespace` — replace one extension namespace. */
  async setItemExtension(
    id: string,
    namespace: string,
    data: Record<string, unknown>,
  ): Promise<
    ApiResponse<{ extensions: Record<string, Record<string, unknown>> }>
  > {
    return this.request<{
      extensions: Record<string, Record<string, unknown>>;
    }>(`/items/${id}/extensions/${namespace}`, {
      method: "PUT",
      body: data,
    });
  }

  /**
   * `GET /items/stats` with no parameters — counts keyed by lifecycle state.
   *
   * With no filter the narrowing is entirely the caller's own scope. That is
   * what makes it worth asserting on: it returns numbers rather than rows, so
   * a filter applied while shaping a response instead of inside the query
   * leaves this answer unchanged while every other read narrows.
   */
  async itemStats(): Promise<ApiResponse<Record<string, number>>> {
    return this.request<Record<string, number>>("/items/stats");
  }

  async bulkItems(
    input: BulkInput | BulkItemInput[],
  ): Promise<ApiResponse<BulkResponse>> {
    const body: BulkInput = Array.isArray(input) ? { items: input } : input;
    return this.request<BulkResponse>("/items/bulk", {
      method: "POST",
      body: body as unknown as Record<string, unknown>,
    });
  }

  /**
   * POST /items/bulk-get — read many items by id in one round-trip. Ids the
   * caller cannot read (type not permitted, trashed, or non-existent) are
   * omitted from `items` rather than erroring. `metadata` is present only when
   * `include` carries `metadata`.
   */
  async bulkGet(
    ids: string[],
    include?: Array<"edges" | "metadata" | "extensions" | "system">,
  ): Promise<ApiResponse<{ items: MarfaItem[]; metadata?: MarfaMetadata[] }>> {
    return this.request<{ items: MarfaItem[]; metadata?: MarfaMetadata[] }>(
      "/items/bulk-get",
      {
        method: "POST",
        body: { ids, ...(include ? { include } : {}) },
      },
    );
  }

  /** POST /items/lookup — rows by link, natural key or id, in every state,
   *  and the tombstones purges left for the keys named. */
  async lookupItems(input: LookupInput): Promise<ApiResponse<LookupResponse>> {
    return this.request<LookupResponse>("/items/lookup", {
      method: "POST",
      body: input as unknown as Record<string, unknown>,
    });
  }

  /** POST /items/tombstones — moves the named tombstones' `settled_at`
   *  later, never earlier. */
  async settleTombstones(
    input: Omit<LookupInput, "ids" | "include"> & { settled_at: string },
  ): Promise<ApiResponse<{ tombstones: Tombstone[] }>> {
    return this.request<{ tombstones: Tombstone[] }>("/items/tombstones", {
      method: "POST",
      body: input as unknown as Record<string, unknown>,
    });
  }

  /**
   * POST /items/bulk-actions. dry_run stays synchronous (200 with
   * BulkActionResponse inline); non-dry-run returns 202 with a
   * BulkActionJob envelope. Callers narrow on `res.status` to decide
   * which shape they got; use `pollBulkActionJob` to drive a queued
   * job to a terminal state.
   *
   * Returned as `BulkActionResponse | BulkActionJob` because the
   * envelope changes by status. Tests destructure the union via the
   * status field.
   */
  async bulkAction(
    input: BulkActionInput,
    options?: { idempotencyKey?: string },
  ): Promise<ApiResponse<BulkActionResponse | BulkActionJob>> {
    return this.request<BulkActionResponse | BulkActionJob>(
      "/items/bulk-actions",
      {
        method: "POST",
        body: input as unknown as Record<string, unknown>,
        ...(options?.idempotencyKey && {
          headers: { "Idempotency-Key": options.idempotencyKey },
        }),
      },
    );
  }

  async bulkActionStatus(jobId: string): Promise<ApiResponse<BulkActionJob>> {
    return this.request<BulkActionJob>(
      `/items/bulk-actions/jobs/${encodeURIComponent(jobId)}`,
    );
  }

  /** Request cancellation of a bulk-action job. Idempotent on terminal rows. */
  async bulkActionCancel(jobId: string): Promise<ApiResponse<BulkActionJob>> {
    return this.request<BulkActionJob>(
      `/items/bulk-actions/jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" },
    );
  }

  /**
   * Tight defaults suit fast in-test convergence; raise them through
   * `options` where a bulk-action job is expected to outlast them.
   */
  async pollBulkActionToTerminal(
    jobId: string,
    options: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<BulkActionJob> {
    const intervalMs = options.intervalMs ?? 100;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const start = Date.now();
    for (;;) {
      const res = await this.bulkActionStatus(jobId);
      if (!res.ok || !res.data) {
        throw new Error(
          `pollBulkActionToTerminal: GET failed with status ${String(res.status)}`,
        );
      }
      const job = res.data;
      if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "canceled"
      ) {
        return job;
      }
      if (Date.now() - start >= timeoutMs) {
        throw new Error(
          `pollBulkActionToTerminal: job ${jobId} did not terminate within ${String(timeoutMs)}ms (last status: ${job.status})`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /** Restore an archive. The operator key only. */
  async restoreArchive(
    archive: ArrayBuffer | Uint8Array,
  ): Promise<ApiResponse<RestoreArchiveResponse>> {
    return this.requestBinary<RestoreArchiveResponse>(
      "/restore",
      archive,
      "application/gzip",
    );
  }

  async bulkEdges(
    input: BulkEdgeInput,
  ): Promise<ApiResponse<BulkEdgeResponse>> {
    return this.request<BulkEdgeResponse>("/edges/bulk", {
      method: "POST",
      body: input as unknown as Record<string, unknown>,
    });
  }

  /**
   * `id` and `acknowledged` mirror `createItem`: a client that mints its own
   * edge ids keeps them, and a repeat under an id already naming this exact
   * edge is answered with the stored row rather than a second one. An id
   * naming a *different* edge is a collision rather than a repeat and is
   * refused 409.
   */
  async createEdge(input: {
    id?: string;
    source_id: string;
    target_id: string;
    edge_type: string;
    properties?: Record<string, unknown>;
  }): Promise<ApiResponse<{ edge: MarfaEdge; acknowledged?: boolean }>> {
    return this.request<{ edge: MarfaEdge; acknowledged?: boolean }>("/edges", {
      method: "POST",
      body: input,
    });
  }

  /**
   * `version` is required for the same reason it is on the item door: an edge
   * update names the version it read or it silently loses the other writer's
   * edit, and a request naming none is refused `400 missing_required_field`.
   */
  async updateEdge(
    id: string,
    changes: {
      properties?: Record<string, unknown>;
      source_id?: string;
      target_id?: string;
      version: number;
    },
    headers?: Record<string, string>,
  ): Promise<ApiResponse<{ edge: MarfaEdge }>> {
    return this.request<{ edge: MarfaEdge }>(`/edges/${id}`, {
      method: "PATCH",
      body: changes,
      ...(headers === undefined ? {} : { headers }),
    });
  }

  async deleteEdge(id: string): Promise<ApiResponse<{ ok: boolean }>> {
    return this.request<{ ok: boolean }>(`/edges/${id}`, {
      method: "DELETE",
    });
  }

  async listItemEdges(
    id: string,
    opts: { edge_type?: string; cursor?: string; limit?: number } = {},
  ): Promise<ApiResponse<PaginatedResult<MarfaEdge>>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const query = params.toString();
    return this.request<PaginatedResult<MarfaEdge>>(
      `/items/${id}/edges${query ? `?${query}` : ""}`,
    );
  }

  async listItemBackrefs(
    id: string,
    opts: { edge_type?: string; cursor?: string; limit?: number } = {},
  ): Promise<ApiResponse<PaginatedResult<MarfaEdge>>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const query = params.toString();
    return this.request<PaginatedResult<MarfaEdge>>(
      `/items/${id}/backrefs${query ? `?${query}` : ""}`,
    );
  }

  async registerEdgeType(
    input: EdgeTypeRegistration,
  ): Promise<ApiResponse<{ edge_type: EdgeTypeDefinition }>> {
    return this.request<{ edge_type: EdgeTypeDefinition }>("/edge-types", {
      method: "POST",
      body: input,
    });
  }

  async listEdgeTypes(): Promise<
    ApiResponse<PaginatedResult<EdgeTypeDefinition>>
  > {
    return this.request<PaginatedResult<EdgeTypeDefinition>>("/edge-types");
  }

  async deleteEdgeType(
    id: string,
    force?: boolean,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    const query = force === true ? "?force=true" : "";
    return this.request<{ ok: boolean }>(`/edge-types/${id}${query}`, {
      method: "DELETE",
    });
  }

  /**
   * Remove an outbound webhook subscription. Needs `webhooks.manage`. The route
   * answers 404 to a credential that cannot see the row, so it takes the
   * credential that registered it.
   */
  async deleteWebhook(id: string): Promise<ApiResponse<{ ok: boolean }>> {
    return this.request<{ ok: boolean }>(`/webhooks/${id}`, {
      method: "DELETE",
    });
  }

  async uploadBlob(
    data: Uint8Array | Blob,
    mimeType: string,
  ): Promise<ApiResponse<BlobUploadResponse>> {
    return this.request<BlobUploadResponse>("/blobs", {
      method: "POST",
      body: data,
      headers: { "Content-Type": mimeType },
    });
  }

  async downloadBlob(
    hash: string,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse<ArrayBuffer>> {
    return this.requestRaw(`/blobs/${hash}`, headers);
  }

  /** `HEAD /blobs/{hash}`: the headers a download would carry, no body. */
  async headBlob(
    hash: string,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse<ArrayBuffer>> {
    return this.requestRaw(`/blobs/${hash}`, headers, "HEAD");
  }

  /** `GET /blobs/stores`: the stores the instance keeps bytes in, and the
   *  live copies a blob keeps at the least. */
  async listBlobStores(): Promise<
    ApiResponse<PaginatedResult<BlobStoreRow> & { min_copies: number }>
  > {
    return this.request<PaginatedResult<BlobStoreRow> & { min_copies: number }>(
      "/blobs/stores",
    );
  }

  /** `DELETE /blobs/{hash}/locations/{store}`: drop one store's copy. */
  async deleteBlobLocation(
    hash: string,
    store: string,
  ): Promise<ApiResponse<{ ok: true }>> {
    return this.request<{ ok: true }>(`/blobs/${hash}/locations/${store}`, {
      method: "DELETE",
    });
  }

  /** `GET /blobs/orphans`: the blobs nothing references. */
  async listBlobOrphans(): Promise<
    ApiResponse<PaginatedResult<BlobOrphanRow>>
  > {
    return this.request<PaginatedResult<BlobOrphanRow>>("/blobs/orphans");
  }

  /** `GET /blobs/{hash}/locations`: the location log for one blob. */
  async listBlobLocations(
    hash: string,
  ): Promise<ApiResponse<PaginatedResult<BlobLocationRow>>> {
    return this.request<PaginatedResult<BlobLocationRow>>(
      `/blobs/${hash}/locations`,
    );
  }

  /** `GET /housekeeping`: the jobs the server runs on itself. */
  async listHousekeeping(): Promise<
    ApiResponse<PaginatedResult<HousekeepingJobRow>>
  > {
    return this.request<PaginatedResult<HousekeepingJobRow>>("/housekeeping");
  }

  /** `POST /housekeeping/{name}/run`: one housekeeping job, now. */
  async runHousekeeping(name: string): Promise<ApiResponse<HousekeepingRun>> {
    return this.request<HousekeepingRun>(`/housekeeping/${name}/run`, {
      method: "POST",
    });
  }

  /** `POST /connectors`: register this client's key, or update the
   *  registration it already has. */
  async registerConnector(input: {
    name: string;
    description?: string;
  }): Promise<ApiResponse<ConnectorRow>> {
    return this.request<ConnectorRow>("/connectors", {
      method: "POST",
      body: input,
    });
  }

  async listConnectors(): Promise<ApiResponse<PaginatedResult<ConnectorRow>>> {
    return this.request<PaginatedResult<ConnectorRow>>("/connectors");
  }

  async getConnector(id: string): Promise<ApiResponse<ConnectorRow>> {
    return this.request<ConnectorRow>(`/connectors/${id}`);
  }

  async deleteConnector(id: string): Promise<ApiResponse<{ ok: true }>> {
    return this.request<{ ok: true }>(`/connectors/${id}`, {
      method: "DELETE",
    });
  }

  async heartbeatConnector(
    id: string,
  ): Promise<ApiResponse<{ last_heartbeat_at: string }>> {
    return this.request<{ last_heartbeat_at: string }>(
      `/connectors/${id}/heartbeat`,
      { method: "POST" },
    );
  }

  async reportConnectorRun(
    id: string,
    input: ConnectorRunInput,
  ): Promise<ApiResponse<ConnectorRun>> {
    return this.request<ConnectorRun>(`/connectors/${id}/runs`, {
      method: "POST",
      body: input as unknown as Record<string, unknown>,
    });
  }

  async listConnectorRuns(
    id: string,
    page: { limit?: number; cursor?: string } = {},
  ): Promise<ApiResponse<PaginatedResult<ConnectorRun>>> {
    return this.request<PaginatedResult<ConnectorRun>>(
      `/connectors/${id}/runs${pageQuery(page)}`,
    );
  }

  /** `POST /connectors/{id}/hold`: take or renew the hold for `process`. */
  async holdConnector(
    id: string,
    process: string,
  ): Promise<ApiResponse<ConnectorHoldTaken>> {
    return this.request<ConnectorHoldTaken>(`/connectors/${id}/hold`, {
      method: "POST",
      body: { process },
    });
  }

  async releaseConnectorHold(
    id: string,
    process: string,
  ): Promise<ApiResponse<{ ok: true }>> {
    return this.request<{ ok: true }>(
      `/connectors/${id}/hold?${new URLSearchParams({ process }).toString()}`,
      { method: "DELETE" },
    );
  }

  async getConnectorState(id: string): Promise<ApiResponse<ConnectorStateRow>> {
    return this.request<ConnectorStateRow>(`/connectors/${id}/state`);
  }

  async replaceConnectorState(
    id: string,
    input: { process: string; state: Record<string, unknown> },
  ): Promise<ApiResponse<ConnectorStateWritten>> {
    return this.request<ConnectorStateWritten>(`/connectors/${id}/state`, {
      method: "PUT",
      body: input,
    });
  }

  async deleteConnectorState(id: string): Promise<ApiResponse<{ ok: true }>> {
    return this.request<{ ok: true }>(`/connectors/${id}/state`, {
      method: "DELETE",
    });
  }

  async writeConnectorAgreements(
    id: string,
    input: ConnectorAgreementsInput,
  ): Promise<ApiResponse<ConnectorAgreementsWritten>> {
    return this.request<ConnectorAgreementsWritten>(
      `/connectors/${id}/agreements`,
      { method: "POST", body: input as unknown as Record<string, unknown> },
    );
  }

  async lookupConnectorAgreements(
    id: string,
    itemIds: string[],
  ): Promise<ApiResponse<{ data: ConnectorAgreementRow[] }>> {
    return this.request<{ data: ConnectorAgreementRow[] }>(
      `/connectors/${id}/agreements/lookup`,
      { method: "POST", body: { item_ids: itemIds } },
    );
  }

  async listConnectorAgreements(
    id: string,
    query: { waiting?: boolean; limit?: number; cursor?: string } = {},
  ): Promise<ApiResponse<PaginatedResult<ConnectorAgreementRow>>> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) params.set(name, String(value));
    }
    const search = params.toString();
    return this.request<PaginatedResult<ConnectorAgreementRow>>(
      `/connectors/${id}/agreements${search === "" ? "" : `?${search}`}`,
    );
  }

  /** `POST /connectors/{id}/endpoints`: an address a sender posts to. */
  async createInboundEndpoint(
    id: string,
    input: { label?: string; duplicate_header?: string } = {},
  ): Promise<ApiResponse<InboundEndpointRow>> {
    return this.request<InboundEndpointRow>(`/connectors/${id}/endpoints`, {
      method: "POST",
      body: input,
    });
  }

  async listInboundEndpoints(
    id: string,
  ): Promise<ApiResponse<PaginatedResult<InboundEndpointRow>>> {
    return this.request<PaginatedResult<InboundEndpointRow>>(
      `/connectors/${id}/endpoints`,
    );
  }

  async retireInboundEndpoint(
    id: string,
    endpointId: string,
  ): Promise<ApiResponse<InboundEndpointRow>> {
    return this.request<InboundEndpointRow>(
      `/connectors/${id}/endpoints/${endpointId}`,
      { method: "DELETE" },
    );
  }

  async listInboundDeliveries(
    id: string,
    query: {
      state?: "pending" | "handled" | "any";
      endpoint_id?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<ApiResponse<PaginatedResult<InboundDeliveryRow>>> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) params.set(name, String(value));
    }
    const search = params.toString();
    return this.request<PaginatedResult<InboundDeliveryRow>>(
      `/connectors/${id}/deliveries${search === "" ? "" : `?${search}`}`,
    );
  }

  /** The body door answers bytes, which the JSON transport would decode, so
   *  this answers the response itself. */
  async getInboundDeliveryBody(
    id: string,
    deliveryId: string,
  ): Promise<Response> {
    return fetch(
      `${this.baseUrl}/connectors/${id}/deliveries/${deliveryId}/body`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
    );
  }

  async markInboundDeliveriesHandled(
    id: string,
    input: { ids: string[]; outcome: InboundOutcome },
  ): Promise<ApiResponse<{ data: InboundDeliveryRow[] }>> {
    return this.request<{ data: InboundDeliveryRow[] }>(
      `/connectors/${id}/deliveries/handled`,
      { method: "POST", body: input },
    );
  }

  async createKey(
    request: ApiKeyRequest,
  ): Promise<ApiResponse<ApiKeyResponse>> {
    return this.request<ApiKeyResponse>("/keys", {
      method: "POST",
      body: request,
    });
  }

  async listKeys(): Promise<ApiResponse<PaginatedResult<ApiKeyResponse>>> {
    return this.request<PaginatedResult<ApiKeyResponse>>("/keys");
  }

  async getCurrentKey(): Promise<ApiResponse<ApiKeyResponse>> {
    return this.request<ApiKeyResponse>("/keys/current");
  }

  async revokeKey(id: string): Promise<ApiResponse<{ ok: boolean }>> {
    return this.request<{ ok: boolean }>(`/keys/${id}`, {
      method: "DELETE",
    });
  }

  async getConfig(): Promise<ApiResponse<unknown>> {
    return this.request<unknown>("/config");
  }

  async updateConfig(
    config: Record<string, unknown>,
  ): Promise<ApiResponse<unknown>> {
    return this.request<unknown>("/config", {
      method: "PUT",
      body: config,
    });
  }

  async addTags(
    id: string,
    tags: string[],
  ): Promise<ApiResponse<{ metadata: MarfaMetadata }>> {
    return this.request<{ metadata: MarfaMetadata }>(`/items/${id}/tags`, {
      method: "POST",
      body: { tags },
    });
  }

  async getMetadata(
    id: string,
  ): Promise<ApiResponse<{ metadata: MarfaMetadata }>> {
    return this.request<{ metadata: MarfaMetadata }>(`/items/${id}/metadata`);
  }

  async replaceMetadata(
    id: string,
    metadata: UpdateMetadataInput,
  ): Promise<ApiResponse<{ metadata: MarfaMetadata }>> {
    return this.request<{ metadata: MarfaMetadata }>(`/items/${id}/metadata`, {
      method: "PUT",
      body: metadata,
    });
  }

  async listTags(): Promise<
    ApiResponse<PaginatedResult<{ tag: string; count: number }>>
  > {
    return this.request<PaginatedResult<{ tag: string; count: number }>>(
      "/metadata/tags",
    );
  }

  async listOccurrences(query: {
    from?: string;
    to?: string;
    type?: string;
  }): Promise<ApiResponse<OccurrencesResponse>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, value);
    }
    const encoded = params.toString();
    return this.request<OccurrencesResponse>(
      `/occurrences${encoded ? `?${encoded}` : ""}`,
    );
  }

  async listItemExtensions(
    id: string,
  ): Promise<
    ApiResponse<{ extensions: Record<string, Record<string, unknown>> }>
  > {
    return this.request<{
      extensions: Record<string, Record<string, unknown>>;
    }>(`/items/${id}/extensions`);
  }

  /**
   * The item read with its inbound edges hydrated beside it.
   *
   * `backrefs` is a sibling of `item` rather than a block on it, because
   * the outbound edges the read always carries are the item's own and the
   * inbound ones are other items' statements about it.
   */
  async getItemWithBackrefs(id: string): Promise<
    ApiResponse<{
      item: MarfaItem;
      metadata: MarfaMetadata;
      backrefs?: Record<string, PaginatedResult<MarfaEdge>>;
    }>
  > {
    return this.request<{
      item: MarfaItem;
      metadata: MarfaMetadata;
      backrefs?: Record<string, PaginatedResult<MarfaEdge>>;
    }>(`/items/${id}?include=backrefs`);
  }

  /** The item read with the first page of its version history beside it. */
  async getItemWithVersions(id: string): Promise<
    ApiResponse<{
      item: MarfaItem;
      metadata: MarfaMetadata;
      versions: PaginatedResult<MarfaVersion>;
    }>
  > {
    return this.request<{
      item: MarfaItem;
      metadata: MarfaMetadata;
      versions: PaginatedResult<MarfaVersion>;
    }>(`/items/${id}?include=versions`);
  }

  async getItemExtension(
    id: string,
    namespace: string,
  ): Promise<ApiResponse<{ data: Record<string, unknown> }>> {
    return this.request<{ data: Record<string, unknown> }>(
      `/items/${id}/extensions/${namespace}`,
    );
  }

  async deleteItemExtension(
    id: string,
    namespace: string,
  ): Promise<
    ApiResponse<{ extensions: Record<string, Record<string, unknown>> }>
  > {
    return this.request<{
      extensions: Record<string, Record<string, unknown>>;
    }>(`/items/${id}/extensions/${namespace}`, { method: "DELETE" });
  }

  async listEdges(
    opts: {
      edge_type?: string;
      updated_after?: string;
      updated_before?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<ApiResponse<PaginatedResult<MarfaEdge>>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const query = params.toString();
    return this.request<PaginatedResult<MarfaEdge>>(
      `/edges${query ? `?${query}` : ""}`,
    );
  }

  async getEdge(id: string): Promise<ApiResponse<{ edge: MarfaEdge }>> {
    return this.request<{ edge: MarfaEdge }>(`/edges/${id}`);
  }

  /** `GET /blobs/{hash}/url`: a time-limited link the bytes can be fetched from. */
  async getBlobUrl(
    hash: string,
    ttl?: number,
  ): Promise<ApiResponse<{ url: string; expires_in: number }>> {
    const query = ttl === undefined ? "" : `?ttl=${String(ttl)}`;
    return this.request<{ url: string; expires_in: number }>(
      `/blobs/${hash}/url${query}`,
    );
  }

  async updateKey(
    id: string,
    changes: Partial<ApiKeyRequest>,
  ): Promise<ApiResponse<ApiKeyResponse>> {
    return this.request<ApiKeyResponse>(`/keys/${id}`, {
      method: "PATCH",
      body: changes,
    });
  }

  async createWebhook(input: {
    url: string;
    events: string[];
    type_filter?: string | null;
    secret?: string;
  }): Promise<ApiResponse<Webhook>> {
    return this.request<Webhook>("/webhooks", { method: "POST", body: input });
  }

  async listWebhooks(): Promise<ApiResponse<PaginatedResult<Webhook>>> {
    return this.request<PaginatedResult<Webhook>>("/webhooks");
  }

  async getWebhook(id: string): Promise<ApiResponse<Webhook>> {
    return this.request<Webhook>(`/webhooks/${id}`);
  }

  async updateWebhook(
    id: string,
    changes: {
      url?: string;
      events?: string[];
      type_filter?: string | null;
      active?: boolean;
    },
  ): Promise<ApiResponse<Webhook>> {
    return this.request<Webhook>(`/webhooks/${id}`, {
      method: "PATCH",
      body: changes,
    });
  }

  async listWebhookDeliveries(
    id: string,
    page: { limit?: number; cursor?: string } = {},
  ): Promise<ApiResponse<PaginatedResult<WebhookDelivery>>> {
    return this.request<PaginatedResult<WebhookDelivery>>(
      `/webhooks/${id}/deliveries${pageQuery(page)}`,
    );
  }

  async listAudit(
    query: {
      action?: string;
      resource_type?: string;
      resource_id?: string;
      created_after?: string;
      created_before?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<ApiResponse<PaginatedResult<AuditEntry>>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const encoded = params.toString();
    return this.request<PaginatedResult<AuditEntry>>(
      `/audit${encoded ? `?${encoded}` : ""}`,
    );
  }

  /** `GET /owner`: the operator key only. */
  async getOwner(): Promise<ApiResponse<Owner>> {
    return this.request<Owner>("/owner");
  }

  /** `POST /owner`: the operator key only. */
  async createOwner(body: {
    email: string;
    password: string;
    name?: string;
  }): Promise<ApiResponse<Owner>> {
    return this.request<Owner>("/owner", { method: "POST", body });
  }

  /** `GET /platform-types/drift`: the operator key only. */
  async listPlatformTypeDrift(): Promise<
    ApiResponse<
      PaginatedResult<{
        id: string;
        item_count: number;
        child_types: string[];
        removable: boolean;
      }>
    >
  > {
    return this.request("/platform-types/drift");
  }

  /**
   * `DELETE /platform-types/{id}`: the operator key only.
   *
   * Encoded because the identifier is the last segment: a `?` or a `#`
   * in one would otherwise end the path early and the door would answer a
   * plausible refusal about a shorter identifier than the fixture sent.
   */
  async deletePlatformType(
    id: string,
  ): Promise<ApiResponse<{ removed: true; id: string }>> {
    return this.request<{ removed: true; id: string }>(
      `/platform-types/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  /** `POST /auth/oauth2/register`: dynamic client registration; no credential. */
  async registerOAuthClient(
    body: Record<string, unknown>,
  ): Promise<ApiResponse<Record<string, unknown>>> {
    const url = `${this.baseUrl}/auth/oauth2/register`;
    try {
      const response = await ofetch.raw(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        responseType: "json",
        ignoreResponseError: true,
      });
      const ok = response.status >= 200 && response.status < 300;
      return {
        status: response.status,
        data: response._data as Record<string, unknown>,
        headers: response.headers,
        ok,
        error: ok ? undefined : (response._data as ErrorResponse),
      };
    } catch (err) {
      return {
        status: 0,
        data: {},
        headers: new Headers(),
        ok: false,
        error: {
          error: {
            code: "NETWORK_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
        },
      };
    }
  }

  async openApiDocument(): Promise<
    ApiResponse<{ openapi: string; paths: Record<string, unknown> }>
  > {
    return this.request<{ openapi: string; paths: Record<string, unknown> }>(
      "/openapi.json",
    );
  }

  async root(): Promise<
    ApiResponse<{
      name: string;
      version: string;
      instance_id: string;
      contract: number;
      features: string[];
    }>
  > {
    return this.request<{
      name: string;
      version: string;
      instance_id: string;
      contract: number;
      features: string[];
    }>("/");
  }

  /**
   * Issue a request the typed methods above cannot express.
   *
   * Every other method on this client names a parameter the server is known
   * to serve. That is the right default and it is exactly wrong for a suite
   * whose job is to establish whether a parameter exists at all: a query key
   * or request header that has not shipped has no typed method to call, and
   * adding one would assert the surface the test is supposed to be asking
   * about. This is the escape hatch for that case, and only that case — reach
   * for a typed method whenever one fits.
   *
   * It goes through the same path as everything else, so a failure still
   * arrives as data on `ok`/`status`/`error` rather than as a throw.
   */
  async rawRequest<T>(
    path: string,
    options: FetchOptions = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>(path, options);
  }

  private async request<T>(
    path: string,
    options: FetchOptions = {},
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...((options.headers as Record<string, string>) ?? {}),
    };

    if (
      options.body &&
      typeof options.body === "object" &&
      !(options.body instanceof Uint8Array) &&
      !(options.body instanceof Blob) &&
      !headers["Content-Type"]
    ) {
      headers["Content-Type"] = "application/json";
    }

    try {
      const response = await ofetch.raw(url, {
        ...options,
        headers,
        responseType: "json",
        ignoreResponseError: true,
      });

      const ok = response.status >= 200 && response.status < 300;

      return {
        status: response.status,
        data: response._data as T,
        headers: response.headers,
        ok,
        error: ok ? undefined : (response._data as ErrorResponse),
      };
    } catch (err) {
      return {
        status: 0,
        data: undefined as T,
        headers: new Headers(),
        ok: false,
        error: {
          error: {
            code: "NETWORK_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
        },
      };
    }
  }

  private async requestRaw(
    path: string,
    extraHeaders: Record<string, string> = {},
    method: "GET" | "HEAD" = "GET",
  ): Promise<ApiResponse<ArrayBuffer>> {
    const url = `${this.baseUrl}${path}`;
    try {
      const response = await ofetch.raw(url, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...extraHeaders },
        responseType: "arrayBuffer",
        ignoreResponseError: true,
      });

      const ok = response.status >= 200 && response.status < 300;

      let error: ErrorResponse | undefined;
      if (!ok) {
        try {
          const text = new TextDecoder().decode(response._data as ArrayBuffer);
          error = JSON.parse(text) as ErrorResponse;
        } catch {
          error = {
            error: {
              code: "UNKNOWN_ERROR",
              message: `Request failed with status ${response.status}`,
            },
          };
        }
      }

      return {
        status: response.status,
        data: response._data as ArrayBuffer,
        headers: response.headers,
        ok,
        error,
      };
    } catch (err) {
      return {
        status: 0,
        data: new ArrayBuffer(0),
        headers: new Headers(),
        ok: false,
        error: {
          error: {
            code: "NETWORK_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
        },
      };
    }
  }

  private async requestText(path: string): Promise<ApiResponse<string>> {
    const url = `${this.baseUrl}${path}`;
    try {
      const response = await ofetch.raw(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        responseType: "text",
        ignoreResponseError: true,
      });

      const ok = response.status >= 200 && response.status < 300;

      let error: ErrorResponse | undefined;
      if (!ok) {
        try {
          error = JSON.parse((response._data as string) ?? "") as ErrorResponse;
        } catch {
          error = {
            error: {
              code: "UNKNOWN_ERROR",
              message: `Request failed with status ${response.status}`,
            },
          };
        }
      }

      return {
        status: response.status,
        data: (response._data as string) ?? "",
        headers: response.headers,
        ok,
        error,
      };
    } catch (err) {
      return {
        status: 0,
        data: "",
        headers: new Headers(),
        ok: false,
        error: {
          error: {
            code: "NETWORK_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
        },
      };
    }
  }

  private async requestBinary<T>(
    path: string,
    body: ArrayBuffer | Uint8Array,
    contentType: string,
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    try {
      const response = await ofetch.raw(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": contentType,
        },
        body,
        responseType: "json",
        ignoreResponseError: true,
      });

      const ok = response.status >= 200 && response.status < 300;

      return {
        status: response.status,
        data: response._data as T,
        headers: response.headers,
        ok,
        error: ok ? undefined : (response._data as ErrorResponse),
      };
    } catch (err) {
      return {
        status: 0,
        data: undefined as T,
        headers: new Headers(),
        ok: false,
        error: {
          error: {
            code: "NETWORK_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
        },
      };
    }
  }
}
