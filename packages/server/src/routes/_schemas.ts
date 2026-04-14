/**
 * Reusable Zod schemas shared across route files.
 *
 * Lift-out from items.ts / threads.ts / search.ts (Wave 2 PR 2). Wave 1
 * had three separate ItemSchema declarations that drifted from the
 * runtime types and from each other; the response-schema fix-up commits
 * (14dc0ca / a093454) had to repair all three. Wave 2's edges work will
 * grow the Item shape further — extracting now keeps the addition local
 * to a single file rather than a four-way duplication.
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
  state: z.enum(["active", "archived", "trashed"]),
  library: z.boolean(),
  version: z.number(),
  schema_version: z.number().int(),
  source: z.string(),
  source_id: z.string().optional(),
  origin: z.enum(["user", "ai", "worker"]),
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
});

// MetadataSchema no longer includes `about` — Wave 2 PR 4 dropped the
// column and moved entity references to first-class `about` edges.
export const MetadataSchema = z.object({
  item_id: z.string(),
  tags: z.array(z.string()),
  extensions: z.record(z.string(), z.unknown()),
});

export const ItemWithMetadataSchema = z.object({
  item: ItemSchema,
  metadata: MetadataSchema,
});
