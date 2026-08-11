/**
 * Reusable Zod schemas shared across route files (items.ts, search.ts,
 * edges.ts). Centralized so the Item/Edge shape is declared once.
 */
import { z } from "@hono/zod-openapi";

export const EdgeSchema = z.object({
  id: z.string(),
  space_id: z.string().nullable().optional(),
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
   * Space scope. Storage queries are space-scoped at the SQL layer, so
   * for ordinary callers this always matches the caller's own space. The
   * field is informational; cross-space infrastructure (the reactive-run
   * bridge) reads this off the row to gate fanout. Mirrors the
   * `Edge.space_id` shape.
   */
  space_id: z.string().nullable().optional(),
  version: z.number(),
  schema_version: z.number().int(),
  source: z.string(),
  source_id: z.string().optional(),
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
  /** Present only on the natural-key re-sync of an item the user has
   *  trashed: the request was accepted and deliberately wrote nothing.
   *  Absent everywhere else, so a caller reading it as a boolean sees
   *  the distinction rather than having to infer it from the state. */
  acknowledged: z.boolean().optional(),
});

export const VersionSchema = z.object({
  id: z.string(),
  item_id: z.string(),
  version: z.number(),
  properties: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  device: z.string().optional(),
});

/**
 * The single-item read response. The base shape (`item` with outbound `edges`
 * hydrated, plus `metadata`) is always present; the three optional blocks are
 * opt-in via `?include=` and widen the 1-hop neighborhood the caller gets in
 * one round trip instead of a per-section fan-out:
 *
 * - `backrefs` — inbound edges grouped by type (same block shape as `edges`),
 *   capped + cursored per type. Opt in with `include=backrefs`.
 * - `neighbors` — the far-end items of the item's edges (outbound targets and,
 *   when `backrefs` is also requested, inbound sources), each with its metadata
 *   and permission-filtered. Opt in with `include=neighbors`. Paired with
 *   `neighbors_truncated`: the combined neighbor set is capped, and when the cap
 *   bites this flag is `true` — the only signal for that case, since the
 *   per-type edge-block `has_more` does not cover a combined-set overflow.
 *   Consumers must page the per-type edge/backref endpoints when it is set.
 * - `versions` — the item's version snapshots, newest-first. Opt in with
 *   `include=versions`.
 */
export const ItemDetailSchema = z.object({
  item: ItemSchema,
  metadata: MetadataSchema,
  backrefs: z.record(z.string(), ItemEdgesBlockSchema).optional(),
  neighbors: z.array(ItemWithMetadataSchema).optional(),
  neighbors_truncated: z.boolean().optional(),
  versions: z.array(VersionSchema).optional(),
});
