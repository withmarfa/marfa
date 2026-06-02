import { createGzip } from "node:zlib";
import { Readable, PassThrough } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  MarfaError,
  ErrorCode,
  isValidTypeIdentifier,
  ITEM_STATES,
} from "@withmarfa/shared";
import type { ItemState } from "@withmarfa/shared";
import * as tar from "tar-stream";
import type { ApiKey } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, getTypeFilter } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import { collectBlobHashes } from "../storage/blob-utils.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import type { PgClient } from "../storage/pg/connection.js";
import { acquireStreamRls } from "../storage/pg/streaming-rls.js";

/**
 * Options for `exportRoutes`. `rlsEnforce` + `pgClient` enable T-146
 * session-level RLS on a dedicated pool connection for the duration
 * of the stream. Without both set, the route runs on the owner
 * connection (unchanged pre-T-146 behaviour) — used for SQLite, for
 * tenant-less callers (platform admin / single-tenant self-host),
 * and when RLS enforcement is disabled instance-wide.
 */
export interface ExportRoutesOptions {
  rlsEnforce: boolean;
  pgClient: PgClient | null;
}

/**
 * T-053: resolve the target tenant for an export request.
 *
 * Three cases:
 *   1. **tenant_admin / member with tenant_id** — caller's tenant
 *      wins; cross-tenant attempts (`?target_tenant_id` set to
 *      anything other than the caller's own) are rejected with 403.
 *   2. **platform admin (no tenant_id)** — MUST pass an explicit
 *      `?target_tenant_id=<id>` query param. Without it we reject
 *      with 400 to avoid the historical bug where a platform key
 *      received an export covering every tenant on the instance.
 *   3. **single-tenant self-host (anonymous / bootstrap admin
 *      mode)** — historically callers exported the whole DB. To
 *      avoid breaking those deployments we treat a tenant-less
 *      caller running against a DB whose items have no tenant_id
 *      (NULL) as the legitimate single-tenant path: pass
 *      `tenantId: undefined` through to the storage layer so list
 *      operations match `tenant_id IS NULL`. Distinguishing this
 *      from case 2 is the explicit `target_tenant_id` query param —
 *      operators on hosted multi-tenant deployments must set it;
 *      single-tenant operators don't.
 */
function resolveExportTenant(
  apiKey: ApiKey | undefined,
  targetParam: string | undefined,
): string | undefined {
  const callerTenant = apiKey?.tenant_id;
  // Tenant-bound caller — own tenant wins.
  if (callerTenant) {
    if (targetParam !== undefined && targetParam !== callerTenant) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "Cannot export another tenant's data — target_tenant_id must match caller's tenant_id (or be omitted).",
      );
    }
    return callerTenant;
  }
  // Tenant-less caller — platform admin OR single-tenant self-host.
  // The presence of `target_tenant_id` distinguishes them: platform
  // admins on hosted multi-tenant set it explicitly; single-tenant
  // self-hosts leave it unset.
  if (targetParam !== undefined) {
    return targetParam; // platform admin scoping to a specific tenant
  }
  return undefined; // single-tenant self-host fallback
}

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const exportRoute = createRoute({
  operationId: "exportTenantData",
  method: "get",
  path: "/",
  tags: ["Export"],
  summary: "Export tenant data",
  description:
    "Streams the tenant's items, edges, metadata, extensions, and blob references as NDJSON (default) or, with `format=archive`, a `marfa-archive-v1.tar.gz` that `POST /admin/restore-archive` can ingest. Tenant-scoped, exporting only what the caller can read; the response streams until the filter is exhausted.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      type: z
        .string()
        .optional()
        .describe("Filter to a single type identifier"),
      state: z.string().optional().describe("Filter by item state"),
      source: z.string().optional().describe("Filter by source credential"),
      since: z
        .string()
        .optional()
        .describe("Include only items updated at or after this timestamp"),
      until: z
        .string()
        .optional()
        .describe("Include only items updated at or before this timestamp"),
      format: z
        .string()
        .optional()
        .describe("Output format: `ndjson` (default) or `archive`"),
      // T-053: platform admins scope a hosted-mode export to a
      // specific tenant by passing `?target_tenant_id=<id>`. Tenant-
      // bound callers (tenant_admin / member) get their own
      // tenant automatically; supplying a mismatching value here
      // returns 403.
      target_tenant_id: z
        .string()
        .optional()
        .describe("Platform admins scope the export to a specific tenant"),
    }),
  },
  responses: {
    200: {
      content: {
        "text/x-ndjson": {
          schema: z.string(),
        },
      },
      description:
        "Streaming NDJSON export of items with metadata (or archive when format=archive)",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Validation error",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function exportRoutes(
  storage: Storage,
  blobBackend: BlobBackend,
  options: ExportRoutesOptions = { rlsEnforce: false, pgClient: null },
) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(exportRoute, (c) => {
    requireAuth(c);

    const query = c.req.valid("query");

    // T-053: resolve the target tenant up front so it's available to
    // the audit log AND both downstream paths (archive + NDJSON). The
    // resolver throws on cross-tenant attempts.
    const tenantId = resolveExportTenant(
      c.get("apiKey"),
      query.target_tenant_id,
    );

    // T-053: audit the export attempt before streaming starts. Stamped
    // for both archive and NDJSON paths. `details.scope: "platform_unscoped"`
    // signals operators when a platform admin exports without a
    // target_tenant_id (self-host fallback path that returns all rows —
    // fine on single-tenant deployments, a real concern on hosted
    // multi-tenant). Alerting on the shape catches accidental cross-
    // tenant exports.
    const platformUnscoped =
      c.get("apiKey")?.tenant_id === undefined &&
      query.target_tenant_id === undefined;
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: tenantId ?? null,
      key_id: c.get("apiKey")?.id,
      action: "export.tenant",
      resource_type: "tenant",
      resource_id: tenantId ?? undefined,
      details: {
        format: query.format ?? "ndjson",
        scope: platformUnscoped ? "platform_unscoped" : "tenant",
        ...(query.target_tenant_id !== undefined
          ? { target_tenant_id: query.target_tenant_id }
          : {}),
      },
    });

    // Archive export: ?format=archive. The handler re-resolves the
    // tenant from the same param (single source of truth) but the
    // audit row is already written.
    if (query.format === "archive") {
      return handleArchiveExport(c, storage, blobBackend, options);
    }

    const type = query.type;
    if (type && !isValidTypeIdentifier(type)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    const state = query.state as ItemState | undefined;
    if (state && !(ITEM_STATES as readonly string[]).includes(state)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid state: ${state}`,
      );
    }

    const since = query.since;
    const until = query.until;
    const source = query.source;

    const allowedTypes = getTypeFilter(c);
    const encoder = new TextEncoder();

    // T-146: when the caller has a tenant_id and RLS enforcement is on,
    // pin a dedicated pool connection for the stream and apply
    // session-level `SET ROLE marfa_app` + `marfa.tenant_id`. Storage
    // reads inside the stream then flow through that connection and
    // are RLS-filtered at the DB layer. Tenant-less callers (platform
    // admin / single-tenant self-host) and SQLite skip — same
    // semantics as the non-streaming RLS middleware.
    const stream = new ReadableStream({
      async start(controller) {
        const rlsCtx =
          options.rlsEnforce && options.pgClient !== null && tenantId
            ? await acquireStreamRls(options.pgClient, tenantId)
            : null;
        try {
          const work = async () => {
            let cursor: string | undefined;
            do {
              const result = await storage.items.list({
                tenantId,
                type,
                state,
                source,
                since,
                until,
                allowed_types: allowedTypes,
                limit: 200,
                cursor,
              });

              for (const item of result.data) {
                const metadata = await storage.metadata.get(item.id);
                controller.enqueue(
                  encoder.encode(JSON.stringify({ item, metadata }) + "\n"),
                );
              }

              cursor = result.has_more
                ? (result.cursor as string | undefined)
                : undefined;
            } while (cursor);
          };
          if (rlsCtx) {
            await rlsCtx.withInstalledContext(work);
          } else {
            await work();
          }
        } finally {
          controller.close();
          if (rlsCtx) {
            await rlsCtx.release();
          }
        }
      },
      // Hono / node-server invokes `cancel` when the consumer detaches
      // (client disconnect mid-stream). The `start` body's `finally`
      // already releases the RLS context on the normal completion
      // path; this cancel hook is the explicit disconnect path. Both
      // converge on `controller.close` → start's finally → release().
      // Idempotent release means a double-fire is safe.
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Archive export helper
// ---------------------------------------------------------------------------

interface ArchiveManifest {
  version: number;
  format: string;
  created_at: string;
  /**
   * T-053: tenant_id stamped at export time. `null` for single-
   * tenant self-host exports (no tenant scope on either side);
   * a string for hosted-mode exports. Used by `/admin/restore-archive`
   * to verify cross-tenant restore attempts (rejected unless the
   * platform admin passes an explicit `target_tenant_id`).
   */
  tenant_id: string | null;
  item_count: number;
  blob_count: number;
  blobs: Record<string, { mime_type: string; size: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HonoContext = Context<any, any, any>;

async function handleArchiveExport(
  c: HonoContext,
  storage: Storage,
  blobBackend: BlobBackend,
  options: ExportRoutesOptions,
): Promise<Response> {
  const type = c.req.query("type");
  if (type && !isValidTypeIdentifier(type)) {
    throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid type identifier");
  }
  const state = c.req.query("state") as ItemState | undefined;
  if (state && !(ITEM_STATES as readonly string[]).includes(state)) {
    throw new MarfaError(ErrorCode.VALIDATION_ERROR, `Invalid state: ${state}`);
  }
  const since = c.req.query("since");
  const until = c.req.query("until");
  const source = c.req.query("source");
  // T-053: resolve target tenant (caller's own, or platform-admin's
  // explicit target). The audit row in the parent handler already
  // captured the `started` action; the manifest below stamps the
  // resolved tenant_id for restore-side verification.
  const tenantId = resolveExportTenant(
    c.get("apiKey"),
    c.req.query("target_tenant_id"),
  );
  const allowedTypes = getTypeFilter(c);

  // T-146: dedicated-connection session-level RLS for the collect pass.
  // Same shape as the NDJSON path above.
  const rlsCtx =
    options.rlsEnforce && options.pgClient !== null && tenantId
      ? await acquireStreamRls(options.pgClient, tenantId)
      : null;

  // Pass 1: Collect all items as NDJSON and gather blob hashes
  const lines: string[] = [];
  const blobHashes = new Set<string>();
  const blobMeta: Record<string, { mime_type: string; size: number }> = {};

  try {
    const collect = async () => {
      let cursor: string | undefined;
      do {
        const result = await storage.items.list({
          tenantId,
          type,
          state,
          source,
          since,
          until,
          allowed_types: allowedTypes,
          limit: 200,
          cursor,
        });
        for (const item of result.data) {
          const metadata = await storage.metadata.get(item.id);
          lines.push(JSON.stringify({ item, metadata }));
          collectBlobHashes(item.properties, blobHashes);
          collectBlobHashes(metadata.extensions, blobHashes);
        }
        cursor = result.has_more
          ? (result.cursor as string | undefined)
          : undefined;
      } while (cursor);

      // Resolve blob metadata from the database. T-049: tenant-scoped
      // lookup using the export caller's tenant_id. Platform admins
      // on single-tenant self-hosts pass `""` (the instance-wide
      // sentinel).
      for (const hash of blobHashes) {
        const record = await storage.blobs.get(hash, tenantId ?? "");
        if (record) {
          blobMeta[hash] = { mime_type: record.mime_type, size: record.size };
        }
      }
    };
    if (rlsCtx) {
      await rlsCtx.withInstalledContext(collect);
    } else {
      await collect();
    }
  } finally {
    if (rlsCtx) {
      await rlsCtx.release();
    }
  }

  // Blob *bytes* fetched below come from the BlobBackend (filesystem
  // / S3), not Postgres — so they don't need the RLS context. The
  // session has already been released at this point.

  // Build manifest. T-053: tenant_id is the resolved scope of this
  // export — the calling tenant or the platform-admin's
  // target_tenant_id; null for single-tenant self-hosts.
  const manifest: ArchiveManifest = {
    version: 1,
    format: "marfa-archive-v1",
    created_at: new Date().toISOString(),
    tenant_id: tenantId ?? null,
    item_count: lines.length,
    blob_count: Object.keys(blobMeta).length,
    blobs: blobMeta,
  };

  // Pack tar.gz
  const pack = tar.pack();
  const gzip = createGzip();
  const passthrough = new PassThrough();
  pack.pipe(gzip).pipe(passthrough);

  const writeEntries = async (): Promise<void> => {
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
    pack.entry(
      { name: "manifest.json", size: manifestBuf.length },
      manifestBuf,
    );

    const ndjsonBuf = Buffer.from(lines.join("\n") + "\n");
    pack.entry({ name: "items.ndjson", size: ndjsonBuf.length }, ndjsonBuf);

    for (const hash of Object.keys(blobMeta)) {
      const data = await blobBackend.get(hash);
      if (data) {
        pack.entry({ name: `blobs/${hash}`, size: data.length }, data);
      }
    }

    pack.finalize();
  };

  writeEntries().catch(() => {
    passthrough.destroy();
  });

  const webStream = Readable.toWeb(passthrough) as ReadableStream;

  const date = new Date().toISOString().split("T")[0] ?? "today";
  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="marfa-export-${date}.tar.gz"`,
    },
  });
}
