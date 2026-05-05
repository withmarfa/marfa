/**
 * Reusable Zod schemas shared across route files (items.ts, search.ts,
 * edges.ts). Centralised so the Item/Edge shape is declared once.
 */
import { z } from "@hono/zod-openapi";

export const EdgeSchema = z.object({
  id: z.string(),
  tenant_id: z.string().nullable().optional(),
  source_id: z.string(),
  target_id: z.string(),
  edge_type: z.string(),
  properties: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * A single edge type's hydrated block on an item response. Per-type cap is
 * 50 by default; has_more + next_cursor signal that more edges exist and the
 * caller should paginate via GET /items/:id/edges?edge_type=X&cursor=...
 */
export const ItemEdgesBlockSchema = z.object({
  edges: z.array(EdgeSchema),
  has_more: z.boolean(),
  next_cursor: z.string().optional(),
});

export const ItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  properties: z.record(z.string(), z.unknown()),
  state: z.enum(["active", "archived", "trashed", "revoked"]),
  /** Optional — `system.*` items have no tier. */
  tier: z.enum(["library", "feed"]).optional(),
  /**
   * Tenant scope. Storage queries are tenant-scoped at the SQL layer, so
   * for ordinary callers this always matches the caller's own tenant. The
   * field is informational; cross-tenant infrastructure (the reactive-run
   * bridge — T-042) reads this off the row to gate fanout. Mirrors the
   * `Edge.tenant_id` shape.
   */
  tenant_id: z.string().nullable().optional(),
  version: z.number(),
  schema_version: z.number().int(),
  source: z.string(),
  source_id: z.string().optional(),
  origin: z.enum(["user", "ai", "worker", "system"]),
  device: z.string().optional(),
  capture_latitude: z.number().optional(),
  capture_longitude: z.number().optional(),
  timestamp: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  /**
   * Hydrated outbound edges per type. Always populated on single-item GETs;
   * opt-in on list GETs via ?include=edges. An empty object means no edges
   * or hydration was skipped.
   */
  edges: z.record(z.string(), ItemEdgesBlockSchema).optional(),
  /**
   * Hydrated extension namespaces. Opt-in on list GETs via
   * ?include=extensions; filtered by caller permissions (same rule as
   * GET /items/:id/extensions). An empty object means no extensions or
   * hydration was skipped. Absent when the caller did not opt in.
   */
  extensions: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
});

// MetadataSchema does not include `about` — entity references are carried
// as first-class `about` edges.
export const MetadataSchema = z.object({
  item_id: z.string(),
  tags: z.array(z.string()),
  extensions: z.record(z.string(), z.unknown()),
});

export const ItemWithMetadataSchema = z.object({
  item: ItemSchema,
  metadata: MetadataSchema,
});
