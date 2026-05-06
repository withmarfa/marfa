import { createGzip } from "node:zlib";
import { Readable, PassThrough } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  MymeError,
  ErrorCode,
  isValidTypeIdentifier,
  ITEM_STATES,
} from "@mymehq/shared";
import type { ItemState } from "@mymehq/shared";
import * as tar from "tar-stream";
import type { ApiKey } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, getTypeFilter } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import { collectBlobHashes } from "../storage/blob-utils.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";

/**
 * T-053: resolve the target tenant for an export request.
 *
 * Three cases:
 *   1. **workspace_admin / member with tenant_id** — caller's tenant
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
      throw new MymeError(
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
  method: "get",
  path: "/",
  tags: ["Export"],
  summary: "Streaming NDJSON or archive export with filters",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      type: z.string().optional(),
      state: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      format: z.string().optional(),
      // T-053: platform admins scope a hosted-mode export to a
      // specific tenant by passing `?target_tenant_id=<id>`. Tenant-
      // bound callers (workspace_admin / member) get their own
      // tenant automatically; supplying a mismatching value here
      // returns 403.
      target_tenant_id: z.string().optional(),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function exportRoutes(storage: Storage, blobBackend: BlobBackend) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(exportRoute, (c) => {
    requireAuth(c);

    const query = c.req.valid("query");

    // Archive export: ?format=archive
    if (query.format === "archive") {
      return handleArchiveExport(c, storage, blobBackend);
    }

    const type = query.type;
    if (type && !isValidTypeIdentifier(type)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    const state = query.state as ItemState | undefined;
    if (state && !(ITEM_STATES as readonly string[]).includes(state)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid state: ${state}`,
      );
    }

    const since = query.since;
    const until = query.until;

    // T-053: resolve the target tenant (caller's own, or platform-
    // admin's explicit target). Throws on cross-tenant attempts.
    const tenantId = resolveExportTenant(
      c.get("apiKey"),
      query.target_tenant_id,
    );
    const allowedTypes = getTypeFilter(c);

    // T-053: audit the export attempt before streaming starts.
    // `details.scope` captures the resolved tenant; an "unscoped"
    // shape signals operators when a platform admin exports without
    // a target_tenant_id (self-host fallback path that returns all
    // rows — fine on single-tenant deployments, a real concern on
    // hosted multi-tenant). Operators alerting on this shape can
    // catch accidental cross-tenant exports.
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
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let cursor: string | undefined;
        try {
          do {
            const result = await storage.items.list({
              tenantId,
              type,
              state,
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
        } finally {
          controller.close();
        }
      },
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
): Promise<Response> {
  const type = c.req.query("type");
  if (type && !isValidTypeIdentifier(type)) {
    throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid type identifier");
  }
  const state = c.req.query("state") as ItemState | undefined;
  if (state && !(ITEM_STATES as readonly string[]).includes(state)) {
    throw new MymeError(ErrorCode.VALIDATION_ERROR, `Invalid state: ${state}`);
  }
  const since = c.req.query("since");
  const until = c.req.query("until");
  // T-053: resolve target tenant (caller's own, or platform-admin's
  // explicit target). The audit row in the parent handler already
  // captured the `started` action; the manifest below stamps the
  // resolved tenant_id for restore-side verification.
  const tenantId = resolveExportTenant(
    c.get("apiKey"),
    c.req.query("target_tenant_id"),
  );
  const allowedTypes = getTypeFilter(c);

  // Pass 1: Collect all items as NDJSON and gather blob hashes
  const lines: string[] = [];
  const blobHashes = new Set<string>();

  let cursor: string | undefined;
  do {
    const result = await storage.items.list({
      tenantId,
      type,
      state,
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

  // Resolve blob metadata from the database. T-049: tenant-scoped lookup
  // using the export caller's tenant_id. Platform admins on single-tenant
  // self-hosts pass `""` (the instance-wide sentinel).
  const blobMeta: Record<string, { mime_type: string; size: number }> = {};
  for (const hash of blobHashes) {
    const record = await storage.blobs.get(hash, tenantId ?? "");
    if (record) {
      blobMeta[hash] = { mime_type: record.mime_type, size: record.size };
    }
  }

  // Build manifest. T-053: tenant_id is the resolved scope of this
  // export — the calling tenant or the platform-admin's
  // target_tenant_id; null for single-tenant self-hosts.
  const manifest: ArchiveManifest = {
    version: 1,
    format: "myme-archive-v1",
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
      "Content-Disposition": `attachment; filename="myme-export-${date}.tar.gz"`,
    },
  });
}
